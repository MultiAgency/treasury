const assert = require('node:assert/strict');
const { join } = require('node:path');
const { runTask } = require('./fixtures/task.cjs');
const { workspaceEvidence } = require('./fixtures/workspace.cjs');
const { rpcBody } = require('./fixtures/rpc.cjs');

/**
 * Agent reads are cached per host, agent and signed-in account. When another account signs in on
 * this host (here: the session cookie changes, as from another tab), the open page must never keep
 * showing, or keep in the new account's scope, reads made for an earlier account.
 */
async function open(browser, root, answer) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  const state = { account: 'owner.near', switches: 0, signIns: 0 }, reads = [], writes = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Every tab of this context is the same host, so a second tab shares the session and these routes.
  await context.route('**/*', async route => {
    const { hostname, pathname } = new URL(route.request().url());
    if (hostname !== '127.0.0.1') return route.abort();
    if (pathname === '/gw/challenge') return route.fulfill({ json: { message: 'Offline sign-in', recipient: '127.0.0.1', nonce: Buffer.alloc(32).toString('base64') } });
    if (pathname === '/gw/session') {
      // The gateway's sign-in sets the session cookie that every tab of this host sends.
      state.account = route.request().postDataJSON().accountId; state.signIns++;
      return route.fulfill({ json: {} });
    }
    if (pathname === '/gw/me') {
      if (state.delayIdentity) await new Promise(resolve => setTimeout(resolve, state.delayIdentity));
      if (state.account === null) return route.fulfill({ json: { agents: [], invoices: null, viewer: null } });
      // A member signed in elsewhere may only vote; the owner holds every capability.
      const member = state.account === 'member.near';
      return route.fulfill({ json: { agents: [{ name: 'treasury', area: 'treasury', owner: 'owner.near', dao: false }], invoices: null,
        viewer: { account: state.account, access: { treasury: { canSign: !member, canPropose: !member, canVote: true, canExecute: !member, canManage: !member } } } } });
    }
    if (pathname.includes('/rpc/')) {
      const method = pathname.split('/rpc/')[1];
      if (method === 'autopilot/stop') {
        writes.push({ method, account: state.account });
        // The earlier tab's action reaches the gateway under the new session and is refused there.
        return route.fulfill({ status: 403, json: { error: 'Your account cannot do that here.', access: 'procedure' } });
      }
      // The account whose session made this request; a late answer still belongs to it.
      const read = { method, account: state.account, after: state.switches };
      reads.push(read);
      return answer(route, method, read);
    }
    if (pathname.startsWith('/static/')) return route.fulfill({ path: join(root, pathname), contentType: pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'font/woff2' });
    return route.fulfill({ path: join(root, 'index.html'), contentType: 'text/html' });
  });
  const signInAs = async (account, trigger) => { state.account = account; state.switches++; await trigger(); };
  return { context, page, state, reads, writes, errors, signInAs };
}

const { setup, overview } = workspaceEvidence();
const book = account => {
  const value = overview('treasury');
  value.area = 'treasury';
  value.book[0].confidential = { 'owner.near': 10_000_000n, 'other.near': 77_000_000n, 'member.near': 33_000_000n }[account];
  value.book[0].usd = Number(value.book[0].confidential) / 1e6;
  value.book[0].priceUpdatedAt = new Date().toISOString();
  value.book[0].priceExpiresAt = new Date(Date.now() + 600_000).toISOString();
  return value;
};
const common = account => ({ setup, instance: { agentId: setup.agentId, executor: true }, overview: book(account), 'treasury/get': null, unresolved: [], held: [], activity: [],
  'owner/actions': [], 'owner/pending': [], 'inbox/list': [], 'autopilot/get': { on: true, everyMin: 60, maxUsd: 10, lastRun: null, nextRun: null } });

async function overviewSwitch(browser, root) {
  const { context, page, reads, writes, errors, signInAs } = await open(browser, root, (route, method, read) => route.fulfill({ json: rpcBody(common(read.account), method) }));
  try {
    await page.goto('http://127.0.0.1/a/treasury/');
    await page.getByText('$10.00', { exact: true }).first().waitFor();
    await signInAs('other.near', () => page.getByRole('button', { name: 'Turn off schedule', exact: true }).click());
    await page.getByText('$77.00', { exact: true }).first().waitFor();
    assert.equal(await page.getByText('$10.00', { exact: true }).count(), 0, 'no read made for the earlier account remains on the page');
    assert.ok(reads.some(read => read.method === 'overview' && read.account === 'other.near'), 'the new account reads its own records');
    assert.deepEqual(writes, [{ method: 'autopilot/stop', account: 'other.near' }], 'the refused action is not repeated');
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('Overview switch failure:', { reads, writes }, await page.locator('body').innerText());
    throw error;
  } finally { await context.close(); }
}

/** Instance identity (the recovery view's executor check) is re-read for every newly signed-in account. */
async function instanceSwitch(browser, root) {
  const { context, page, reads, writes, errors, signInAs } = await open(browser, root, (route, method, read) => {
    // Agent observations stay unavailable, so /automations shows the recovery task that reads instance identity.
    if (method === 'setup') return route.fulfill({ status: 503, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Setup unavailable' } } });
    return route.fulfill({ json: rpcBody(common(read.account), method) });
  });
  const instanceReads = (account, after) => reads.filter(read => read.method === 'instance' && read.account === account && read.after === after).length;
  try {
    await page.goto('http://127.0.0.1/a/treasury/automations');
    const stop = page.getByRole('button', { name: 'Turn off', exact: true });
    await stop.waitFor();
    assert.ok(instanceReads('owner.near', 0) > 0);
    await signInAs('other.near', () => stop.click());
    await page.waitForFunction(() => document.querySelector('button') !== null);
    await assert.doesNotReject(waitFor(() => instanceReads('other.near', 1) > 0), 'the new account reads instance identity in its own scope');
    await signInAs('owner.near', () => stop.click());
    // Returning to the first account must not reuse an entry filled while another account was signed in.
    await assert.doesNotReject(waitFor(() => instanceReads('owner.near', 2) > 0), 'returning to an account reads instance identity again in that account\'s scope');
    assert.deepEqual(writes.map(write => write.account), ['other.near', 'owner.near'], 'each refused stop is sent once');
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('Instance switch failure:', { reads, writes }, await page.locator('body').innerText());
    throw error;
  } finally { await context.close(); }
}

/** Strategy status is re-read per account, and a late answer for an earlier account never reaches the new scope. */
async function strategySwitch(browser, root) {
  let delayed;
  const strategy = account => ({ strategy: { targetBps: { usdc: 10000 }, minLegUsd: 1, maxCostBps: 100, autopilot: { everyMin: 60, maxUsd: 10 } }, digest: 'fixture', grantSuffix: 'fixture',
    executor: true, on: true, grantMatches: false, unresolved: 0, grant: null, observedAt: new Date().toISOString(),
    readiness: { state: 'authorization-required', canEnable: false, reasons: [`Readiness recorded for ${account}.`] } });
  const { context, page, reads, writes, errors, signInAs, state } = await open(browser, root, async (route, method, read) => {
    // Signing in elsewhere is noticed when the next polled read is denied; that refreshes the session without re-reading strategy status.
    if (method === 'owner/actions' && state.denyNextActions) {
      state.denyNextActions = false;
      return route.fulfill({ status: 403, json: { error: 'Signed in as another account.', access: 'procedure' } });
    }
    const late = method === 'strategy/get' && state.delayNext;
    if (late) {
      state.delayNext = false;
      // Answered only after the next account has signed in: a late answer for the earlier account.
      await new Promise(resolve => { delayed = resolve; });
    }
    const answered = route.fulfill({ json: rpcBody({ ...common(read.account), 'strategy/get': strategy(read.account) }, method) }).then(() => true, () => false);
    if (late) state.late = await answered;
    return answered;
  });
  const strategyReads = (account, after) => reads.filter(read => read.method === 'strategy/get' && read.account === account && read.after === after).length;
  try {
    await page.goto('http://127.0.0.1/a/treasury/automations');
    await page.getByText('Readiness recorded for owner.near.', { exact: true }).waitFor();
    // A refused stop while owner.near is still signed in refreshes strategy status; hold that answer.
    state.delayNext = true;
    await page.getByRole('button', { name: 'Turn off', exact: true }).click();
    await waitFor(() => Boolean(delayed));
    const viaPolledRead = () => { state.denyNextActions = true; return waitFor(() => !state.denyNextActions); };
    await signInAs('other.near', viaPolledRead);
    await page.getByText('Readiness recorded for other.near.', { exact: true }).waitFor();
    delayed();
    await waitFor(() => state.late !== undefined);
    // The witness: the earlier account's answer was delivered to the page, not cancelled or dropped.
    assert.equal(state.late, true, 'the late answer for the earlier account was delivered');
    await page.waitForTimeout(500);
    assert.equal(await page.getByText('Readiness recorded for owner.near.', { exact: true }).count(), 0, 'a late answer for the earlier account never reaches the new account');
    assert.ok(strategyReads('other.near', 1) > 0, 'the new account reads strategy status in its own scope');
    await signInAs('owner.near', viaPolledRead);
    await waitFor(() => strategyReads('owner.near', 2) > 0);
    await page.getByText('Readiness recorded for owner.near.', { exact: true }).waitFor();
    assert.equal(await page.getByText('Readiness recorded for other.near.', { exact: true }).count(), 0, 'returning to an account never shows another account\'s strategy status');
    assert.deepEqual(writes.map(write => write.account), ['owner.near'], 'the refused stop is sent once and never repeated');
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('Strategy switch failure:', { reads, writes }, await page.locator('body').innerText());
    throw error;
  } finally { delayed?.(); await context.close(); }
}

/** A switch made in another tab is noticed when this tab becomes visible again, not a minute later. */
async function capabilitySwitch(browser, root) {
  const { context, page, writes, errors, state } = await open(browser, root, (route, method, read) => route.fulfill({ json: rpcBody(common(read.account), method) }));
  try {
    await page.goto('http://127.0.0.1/a/treasury/');
    const stop = page.getByRole('button', { name: 'Turn off schedule', exact: true });
    await stop.waitFor();
    assert.equal(await stop.isEnabled(), true, 'the owner may stop the schedule');
    state.account = 'member.near';
    // The owner switched accounts in another tab; this tab is hidden, then shown again.
    await page.evaluate(() => {
      for (const visibility of ['hidden', 'visible']) {
        Object.defineProperty(document, 'visibilityState', { value: visibility, configurable: true });
        document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
      }
    });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Turn off schedule' && b.disabled), undefined, { timeout: 5000 });
    // Settled, not merely pending: the member's own records are shown, and the control stays disabled.
    await page.getByText('$33.00', { exact: true }).first().waitFor();
    assert.equal(await stop.isDisabled(), true, 'the confirmed member may not stop the schedule');
    assert.deepEqual(writes, [], 'nothing was sent');
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('Capability switch failure:', { state, writes }, await page.locator('body').innerText());
    throw error;
  } finally { await context.close(); }
}

/** While the new identity is being confirmed, the previous account's controls are not offered. */
async function pendingIdentity(browser, root) {
  const { context, page, writes, errors, state } = await open(browser, root, (route, method, read) => route.fulfill({ json: rpcBody(common(read.account), method) }));
  try {
    await page.goto('http://127.0.0.1/a/treasury/');
    const stop = page.getByRole('button', { name: 'Turn off schedule', exact: true });
    await stop.waitFor();
    assert.equal(await stop.isEnabled(), true);
    state.account = 'other.near'; state.delayIdentity = 2000;
    await page.evaluate(() => {
      for (const visibility of ['hidden', 'visible']) {
        Object.defineProperty(document, 'visibilityState', { value: visibility, configurable: true });
        document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
      }
    });
    await page.waitForTimeout(300);
    assert.equal(await stop.isDisabled(), true, 'no control is offered while the signed-in account is being confirmed');
    state.delayIdentity = 0;
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Turn off schedule' && !b.disabled), undefined, { timeout: 8000 });
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('Pending identity failure:', { state, writes }, await page.locator('body').innerText());
    throw error;
  } finally { await context.close(); }
}

/** A sign-in or sign-out in another tab of this host is noticed at once, with no focus change. */
async function crossTabSignal(browser, root) {
  const { context, page, writes, errors, state } = await open(browser, root, (route, method, read) => route.fulfill({ json: rpcBody(common(read.account), method) }));
  try {
    await page.goto('http://127.0.0.1/a/treasury/');
    const stop = page.getByRole('button', { name: 'Turn off schedule', exact: true });
    await stop.waitFor();
    assert.equal(await stop.isEnabled(), true);
    state.account = 'member.near';
    // The other tab announces what the app's sign-in and sign-out announce (web/src/app/session-signal.ts).
    const other = await context.newPage();
    await other.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Other tab</title>' }));
    await other.goto('http://127.0.0.1/other-tab');
    await other.evaluate(() => { const channel = new BroadcastChannel('multiagency-session'); channel.postMessage('changed'); channel.close(); });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Turn off schedule' && b.disabled), undefined, { timeout: 5000 });
    // Settled, not merely pending: the member's own records are shown, and the control stays disabled.
    await page.getByText('$33.00', { exact: true }).first().waitFor();
    assert.equal(await stop.isDisabled(), true, 'the confirmed member may not stop the schedule');
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('Cross-tab failure:', { state, writes }, await page.locator('body').innerText());
    throw error;
  } finally { await context.close(); }
}

/** The app's own sign-in in a second tab (challenge, wallet signature, session) reaches this tab at once, with no focus change. */
async function realSignIn(browser, root) {
  const { context, page, writes, errors, state } = await open(browser, root, (route, method, read) => route.fulfill({ json: rpcBody(common(read.account), method) }));
  // An offline wallet in every tab; it signs only the sign-in message.
  await context.addInitScript(() => {
    localStorage.setItem('member:selected-wallet:mainnet', 'fixture-wallet');
    const accounts = [{ accountId: 'owner.near', publicKey: 'ed25519:fixture' }];
    const wallet = { manifest: { id: 'fixture-wallet', name: 'Offline wallet', features: { signMessage: true }, permissions: {} },
      getAccounts: async () => accounts, signIn: async () => accounts, signOut: async () => {},
      signMessage: async () => ({ ...accounts[0], signature: 'offline-signature' }) };
    window.addEventListener('near-selector-ready', () => window.dispatchEvent(new CustomEvent('near-wallet-injected', { detail: wallet })));
  });
  try {
    state.account = null;
    await page.goto('http://127.0.0.1/a/treasury/');
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).first().waitFor();
    const other = await context.newPage();
    await other.goto('http://127.0.0.1/');
    await other.getByRole('button', { name: 'Connect wallet', exact: true }).first().click();
    await waitFor(() => state.signIns === 1);
    const stop = page.getByRole('button', { name: 'Turn off schedule', exact: true });
    await stop.waitFor({ timeout: 5000 });
    await page.getByText('$10.00', { exact: true }).first().waitFor();
    assert.equal(await stop.isEnabled(), true, 'the owner who signed in elsewhere may stop the schedule here');
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('Real sign-in failure:', { state, writes }, await page.locator('body').innerText());
    throw error;
  } finally { await context.close(); }
}

async function waitFor(predicate, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Condition not reached');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

runTask([overviewSwitch, instanceSwitch, strategySwitch, capabilitySwitch, pendingIdentity, crossTabSignal, realSignIn]);
