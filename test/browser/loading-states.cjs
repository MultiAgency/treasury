/** Offline loading/empty transitions. Every request is intercepted; no write RPC is declared.
 * CASE_FILTER='run loading 390 light' node test/browser/loading-states.cjs [build-directory]
 */
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { runTask } = require('./fixtures/task.cjs');
const { rpcValue } = require('./fixtures/rpc.cjs');
const { workspaceEvidence } = require('./fixtures/workspace.cjs');
const { makeTick, recordingFor } = require('./fixtures/run.cjs');

const { budget, setup, overview } = workspaceEvidence({ policyDetails: true, grants: true });
// The runner executes a frozen copy in /tmp. Its artifact path identifies the original project.
const project = process.env.PROTO_BROWSER_ARTIFACTS
  ? resolve(process.env.PROTO_BROWSER_ARTIFACTS, '../../../..') : resolve(__dirname, '../..');
const screenshots = join(project, '.test-artifacts/loading-pass/screenshots');
const noPayments = 'No payment records found in the sources checked.';
const noRuns = 'No autopilot run found in this executor’s retained records.';
const walletManifest = 'https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json';

function deferredRead() {
  let release, requested;
  const ready = new Promise(resolve => { requested = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  return { ready, release, async wait() { requested(); await response; } };
}

async function open(browser, root, routePath, options = {}) {
  const { width = 390, theme = 'light', agent = 'payables' } = options;
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' });
  await context.addInitScript(theme => {
    document.addEventListener('DOMContentLoaded', () => document.documentElement.classList.toggle('dark', theme === 'dark'));
  }, theme);
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const calls = [], errors = [], blocked = [];
  const state = { failures: new Set(options.failures || []) };
  const gates = new Map((options.defer || []).map(method => [method, deferredRead()]));
  const ticks = options.ticks || [];
  const currentOverview = overview(agent);
  if (options.frozen) currentOverview.policy.policy.frozen = true;
  const held = options.held ? [{ correlationId: 'held-loading-fixture', approvalId: 'approval-loading-fixture',
    at: '2026-10-14T12:00:00Z', request: { recipient: 'payee.near', asset: 'usdc', amount: '1000000', confidential: true } }] : [];
  const values = {
    instance: { agentId: 'fixture', executor: !options.approveOnly },
    setup: { ...setup, executor: !options.approveOnly,
      grant: options.noGrant ? null : { ...setup.grant, label: agent === 'payables' ? 'payout' : 'treasury' } },
    overview: currentOverview,
    'treasury/get': null, held,
    unresolved: options.unresolved ? [{ key: 'unresolved-loading-fixture', at: '2026-10-14T12:00:00Z' }] : [],
    'inbox/list': [], 'agreements/list': [], 'owner/pending': [], 'owner/actions': [],
    activity: [], invoices: [], policyHistory: [], reconcileBooks: [],
    paymentHistory: { items: [], complete: true },
    'autopilot/get': { on: false, everyMin: 60, maxUsd: 10 },
    'autopilot/evidence': { ticks, corrupt: options.corrupt || [] },
    'strategy/get': null,
  };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const { hostname, pathname } = new URL(route.request().url());
    // The existing wallet selector discovers public wallet metadata. Keep that read offline too.
    if (route.request().method() === 'GET' && route.request().url() === walletManifest) return route.abort();
    if (hostname !== 'frontend.test') { blocked.push(route.request().url()); return route.abort(); }
    if (pathname === '/gw/me') return route.fulfill({ json: {
      agents: [{ name: agent, area: agent, owner: 'owner.near', dao: false }], invoices: null,
      viewer: { account: 'owner.near', access: { [agent]: {
        canSign: !options.readOnly, canPropose: !options.readOnly, canVote: !options.readOnly,
        canExecute: !options.readOnly, canManage: !options.readOnly,
      } } },
    } });
    if (pathname.includes('/rpc/')) {
      const method = pathname.split('/rpc/')[1];
      calls.push(method);
      assert.ok(Object.hasOwn(values, method) || method === 'autopilot/log', `Unexpected or mutating RPC: ${method}`);
      if (gates.has(method)) await gates.get(method).wait();
      if (page.isClosed()) return;
      if (state.failures.has(method)) return route.fulfill({ status: 503,
        json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: `Fixture read unavailable: ${method}` } } });
      if (method === 'autopilot/log') {
        assert.ok(!options.approveOnly, 'approve-only instances do not read executor recordings');
        const id = route.request().postDataJSON().json.tickId;
        const tick = ticks.find(tick => tick.id === id);
        assert.ok(tick, 'recording reads must select a retained run');
        return route.fulfill({ json: { json: recordingFor(tick) } });
      }
      return route.fulfill({ json: { json: rpcValue(values, method) } });
    }
    if (pathname.startsWith('/static/')) return route.fulfill({ path: join(root, pathname),
      contentType: pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'font/woff2' });
    assert.ok(!pathname.startsWith('/gw/'), `Unexpected gateway request: ${pathname}`);
    return route.fulfill({ path: join(root, 'index.html'), contentType: 'text/html' });
  });
  await page.goto('http://frontend.test' + routePath);
  return { page, calls, state, gates,
    async finish() {
      assert.deepEqual(errors, [], 'no browser errors');
      assert.deepEqual(blocked, [], 'the view makes no unexpected external requests');
      assert.ok(calls.every(method => Object.hasOwn(values, method) || method === 'autopilot/log'), 'only declared reads occurred');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'view fits the viewport');
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), theme === 'dark');
      for (const gate of gates.values()) gate.release();
      await context.close();
    },
  };
}

async function loading(page, label) {
  const status = page.getByRole('status').filter({ hasText: label });
  await status.waitFor();
  const shapes = status.locator('[data-slot="skeleton"]');
  await shapes.first().waitFor();
  assert.ok(await shapes.count() > 0);
  assert.equal(await shapes.evaluateAll(elements => elements.every(element => element.closest('[aria-hidden="true"]'))), true,
    'decorative skeletons are hidden from assistive technology');
  assert.equal(await status.getByRole('button').count(), 0, 'loading placeholders are not actions');
  return status;
}

async function screenshot(page, name) {
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, name + '.png'), fullPage: true });
}

const cases = [];
function scenario(name, work) { cases.push(Object.defineProperty(work, 'name', { value: name })); }

for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
  const viewport = { width, theme };
  scenario(`home loading ${width} ${theme}`, async (browser, root) => {
    const test = await open(browser, root, '/', { ...viewport, defer: ['held'] });
    const { page, gates } = test;
    await gates.get('held').ready;
    const pending = await loading(page, 'Checking payables…');
    assert.equal(await page.getByText('No decisions or exceptions in the records checked.', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'View activity', exact: true }).count(), 0);
    gates.get('held').release();
    await page.getByText('No decisions or exceptions in the records checked.', { exact: true }).waitFor();
    const next = page.getByRole('link', { name: 'View activity', exact: true });
    await next.waitFor();
    assert.equal(await next.getAttribute('href'), '/#activity');
    await pending.waitFor({ state: 'detached' });
    await test.finish();
  });

  scenario(`payments loading ${width} ${theme}`, async (browser, root) => {
    const test = await open(browser, root, '/a/payables/', { ...viewport, defer: ['held', 'paymentHistory'] });
    const { page, gates } = test;
    await Promise.all([...gates.values()].map(gate => gate.ready));
    const pending = await loading(page, 'Checking payments and owner actions…');
    assert.equal(await page.getByText(noPayments, { exact: true }).count(), 0);
    assert.equal(await page.getByText('No records need review.', { exact: true }).count(), 0);
    const capture = width === 390 && theme === 'light' || width === 1280 && theme === 'dark';
    if (capture) await screenshot(page, `payments-${width}-${theme}-loading`);
    gates.get('held').release();
    // One successful source cannot turn the still-pending history into an empty result.
    await loading(page, 'Checking payments and owner actions…');
    assert.equal(await page.getByText(noPayments, { exact: true }).count(), 0);
    gates.get('paymentHistory').release();
    await page.getByText(noPayments, { exact: true }).waitFor();
    await page.getByRole('link', { name: 'Review Agreements', exact: true }).waitFor();
    await pending.waitFor({ state: 'detached' });
    if (capture) await screenshot(page, `payments-${width}-${theme}-empty`);
    assert.ok(!test.calls.includes('paymentStatus'), 'empty discovery never polls a selected payment');
    await test.finish();
  });

  scenario(`run loading ${width} ${theme}`, async (browser, root) => {
    const test = await open(browser, root, '/a/treasury/follow/run', { ...viewport, agent: 'treasury', defer: ['autopilot/evidence'] });
    const { page, gates } = test;
    await gates.get('autopilot/evidence').ready;
    await page.getByRole('heading', { name: 'Follow this run', exact: true }).waitFor();
    const pending = await loading(page, 'Loading recorded runs…');
    assert.equal(await page.getByText(noRuns, { exact: true }).count(), 0);
    gates.get('autopilot/evidence').release();
    await page.getByText(noRuns, { exact: true }).waitFor();
    await pending.waitFor({ state: 'detached' });
    const run = page.getByRole('button', { name: 'Run now', exact: true });
    await run.click();
    const dialog = page.getByRole('dialog', { name: 'Run one autopilot tick on mainnet?', exact: true });
    await dialog.waitFor();
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
    assert.equal(await cancel.evaluate(element => element === document.activeElement), true);
    await cancel.click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await run.evaluate(element => element === document.activeElement), true);
    assert.ok(!test.calls.includes('autopilot/tick'), 'review and cancellation send nothing');
    await test.finish();
  });
}

scenario('home approve-only attention', async (browser, root) => {
  const test = await open(browser, root, '/', { approveOnly: true, noGrant: true, held: true, unresolved: true, frozen: true });
  const { page } = test;
  const review = page.getByRole('link', { name: 'Review payment', exact: true });
  await review.waitFor();
  assert.equal(await review.getAttribute('href'), '/a/payables/follow/payment?payment=held-loading-fixture');
  await page.getByText(/1 money action has no proven outcome/).waitFor();
  await page.getByText('The agent is frozen. Nothing moves until the owner unfreezes it.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: /^(Issue|Renew)$/ }).count(), 0, 'approve-only review needs no send grant');
  assert.equal(await page.getByText('No decisions or exceptions in the records checked.', { exact: true }).count(), 0);
  await test.finish();
});

scenario('payments failed read is not empty', async (browser, root) => {
  const test = await open(browser, root, '/a/payables/', { defer: ['held'], failures: ['held'] });
  const { page, gates } = test;
  await loading(page, 'Checking payments and owner actions…');
  gates.get('held').release();
  // The same failed source is surfaced by both area attention and the payment queue.
  await page.getByText('Fixture read unavailable: held', { exact: true }).first().waitFor();
  await page.getByText('The available records show no matching items. Some checks are incomplete; review the notices above.', { exact: true }).waitFor();
  assert.equal(await page.getByText(noPayments, { exact: true }).count(), 0);
  assert.equal(await page.getByText('No records need review.', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('status').filter({ hasText: 'Checking payments and owner actions…' }).count(), 0);
  await test.finish();
});

scenario('payments known rows survive pending history', async (browser, root) => {
  const test = await open(browser, root, '/a/payables/', { held: true, defer: ['paymentHistory'] });
  const { page, gates } = test;
  await gates.get('paymentHistory').ready;
  const queue = page.getByRole('list', { name: 'Payment records' });
  await queue.getByRole('link').filter({ hasText: 'payee.near' }).waitFor();
  assert.equal(await page.locator('[data-slot="skeleton"]').count(), 0, 'known records remain visible without cold-load placeholders');
  assert.equal(await page.getByText(noPayments, { exact: true }).count(), 0);
  gates.get('paymentHistory').release();
  await page.getByText('Showing 1 of 1 retained records.', { exact: true }).waitFor();
  await test.finish();
});

scenario('run failed read retries without an empty claim', async (browser, root) => {
  const test = await open(browser, root, '/a/treasury/follow/run', { agent: 'treasury', defer: ['autopilot/evidence'], failures: ['autopilot/evidence'] });
  const { page, gates, state } = test;
  await loading(page, 'Loading recorded runs…');
  gates.get('autopilot/evidence').release();
  await page.getByText('Fixture read unavailable: autopilot/evidence', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Follow this run', exact: true }).waitFor();
  assert.equal(await page.getByText(noRuns, { exact: true }).count(), 0);
  const retry = page.getByRole('button', { name: 'Check again', exact: true });
  await retry.waitFor();
  state.failures.clear();
  await retry.click();
  await page.getByText(noRuns, { exact: true }).waitFor();
  await test.finish();
});

for (const profile of ['read-only', 'approve-only']) scenario(`run empty ${profile}`, async (browser, root) => {
  const test = await open(browser, root, '/a/treasury/follow/run', {
    agent: 'treasury', readOnly: profile === 'read-only', approveOnly: profile === 'approve-only', theme: 'dark',
  });
  const { page } = test;
  await page.getByText(noRuns, { exact: true }).waitFor();
  const history = page.getByRole('link', { name: 'Review operation history', exact: true });
  await history.waitFor();
  assert.equal(await history.getAttribute('href'), '/a/treasury/activity');
  const run = page.getByRole('button', { name: 'Run now', exact: true });
  if (await run.count()) assert.equal(await run.isDisabled(), true);
  await test.finish();
});

scenario('missing selected run offers latest retained run', async (browser, root) => {
  const tick = makeTick('quiet', budget);
  const test = await open(browser, root, '/a/treasury/follow/run?run=missing-run', { agent: 'treasury', readOnly: true, ticks: [tick] });
  const { page } = test;
  await page.getByText('The selected run was not found in this executor’s retained records.', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'View latest run', exact: true }).click();
  await page.getByText('Run outcome: book on target', { exact: true }).waitFor();
  assert.notEqual(new URL(page.url()).searchParams.get('run'), 'missing-run');
  await test.finish();
});

scenario('corrupt run records are incomplete rather than empty', async (browser, root) => {
  const test = await open(browser, root, '/a/treasury/follow/run', { agent: 'treasury', readOnly: true, corrupt: [3] });
  const { page } = test;
  await page.getByRole('heading', { name: 'Follow this run', exact: true }).waitFor();
  await page.getByText(/run records.*(?:unreadable|incomplete)|(?:unreadable|incomplete).*run records/i).first().waitFor();
  await page.getByRole('button', { name: 'Check again', exact: true }).waitFor();
  assert.equal(await page.getByText(noRuns, { exact: true }).count(), 0);
  await test.finish();
});

const filter = process.env.CASE_FILTER || process.env.SCENARIO;
const selected = filter ? cases.filter(work => new RegExp(filter).test(work.name)) : cases;
assert.ok(selected.length, `No loading-state scenarios matched ${filter}`);
runTask(selected);
