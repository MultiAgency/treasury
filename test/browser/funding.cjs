/** Offline task journeys. Run through test/browser/run.cjs to retain failure diagnostics. */
const { runTask } = require('./fixtures/task.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { workspaceEvidence, workspaceOpener } = require('./fixtures/workspace.cjs');

async function fundingBalances(browser, root) {
  const { budget, setup, overview } = workspaceEvidence();
  const open = workspaceOpener(root, { budget, values(kind, options, state, run) {
    const values = { get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup: { ...setup, ...(options.payoutGrant && { grant: { ...setup.grant, label: "payout" } }), ...(options.noGrant && { grant: null }), ...(options.approveOnly && { executor: false }) }, overview: overview(kind), 'treasury/get': options.linked ? { accountId: 'treasury.near', balances: { near: '1', usdc: '1000000' }, payees: [], dao: null, confidential: false } : null, held: options.held && !state.settled ? ['payment-one','payment-two'].map(correlationId => ({ correlationId, kind: 'payout', approvalId: 'approval-' + correlationId, at: new Date().toISOString(), request: { amount: '1000000', asset: 'usdc', recipient: 'payee.near', confidential: true } })) : [], unresolved: options.unresolved && kind === 'payables' ? [{ kind: 'payout', at: new Date().toISOString(), key: 'fixture-unresolved', request: {}, status: null, sent: false }] : [],
      'inbox/list': [], 'agreements/list': options.agreed ? [{ id: 'agreement-fixture', payee: 'payee.near', amount: '1000000', status: 'agreed', origin: 'owner', at: '2026-10-01T00:00:00Z', note: '' }] : [], activity: [], invoices: [], reconcileBooks: [], 'owner/pending': [], 'owner/actions': [], paymentHistory: { items: options.held ? ['payment-one','payment-two'].map(correlationId => ({ correlationId, at: '2026-10-14T00:00:00Z' })) : [], complete: true }, paymentStatus: { status: state.settled ? 'SUCCESS' : 'PENDING_APPROVAL', request: { amount: '1000000', asset: 'usdc', recipient: 'payee.near', confidential: true }, approvalId: 'approval-one', expiresAt: '2030-01-01T00:00:00Z', failureCode: null, createdAt: null, updatedAt: null, detailError: null, evidence: { txHash: null, destinationTxHash: null, refundTxHash: null, refundTo: null, refundedAmount: null } },
      'autopilot/get': { on: true, everyMin: 60, maxUsd: 10, lastRun: null, nextRun: null },
      'autopilot/evidence': { ticks: [run], corrupt: [] } };
    if (options.missingTerms && values.held.length) {
      values.held[0].request = {};
      values.held[1].request.asset = 'unknown-token';
    }
    if (options.unmanaged) {
      values.overview.unmanaged = [{ asset: 'unmanaged', symbol: 'OTHER', amount: 1000000n, decimals: 6, usd: null, price: null, priceUpdatedAt: null, priceExpiresAt: null }];
      values.overview.policy.policy.assets = options.excluded ? ['usdc'] : 'any';
    }
    return values;
  } });
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const { page, calls } = await open(context, '/a/payables/funding', { payoutGrant: true });
    const sweep = page.getByRole('region', { name: 'Shield public funds' });
    await sweep.getByText('Shield public funds', { exact: true }).click();
    await sweep.getByText('Shielding requires a treasury grant. Payout and invoice grants cannot shield funds.').waitFor();
    assert.equal(await sweep.getByRole('button', { name: 'Preview', exact: true }).isDisabled(), true);
    assert.equal(await sweep.getByRole('button', { name: 'Shield', exact: true }).isDisabled(), true);
    await sweep.getByText(/Other assets are not included in this sweep/).waitFor();
    assert.ok(!calls.includes('sweep'));
    await context.close();
    console.log('PASS payout grant explains unavailable sweep and managed asset scope');
  }
  for (const width of [320, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const { page, calls, errors } = await open(context, '/a/treasury/funding', { held: true, linked: true });
    await page.getByRole('heading', { name: 'Receive funds', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Send funds', exact: true }).waitFor();
    await page.getByText('Not established', { exact: true }).waitFor();
    const held = page.getByRole('list', { name: 'Held payout records' });
    assert.equal(await held.getByRole('link').count(), 2);
    assert.ok((await held.innerText()).includes('1 USDC'));
    assert.ok((await page.getByRole('table').innerText()).includes('10 USDC'));
    const incoming = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Receive funds', exact: true }) });
    const outgoing = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Send funds', exact: true }) });
    assert.equal(await incoming.getByText('Money out: return funds to treasury.near', { exact: true }).count(), 0);
    assert.ok(await outgoing.getByText('Money out: return funds to treasury.near', { exact: true }).isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.ok(!calls.some(call => /^(pay|deposit|treasury\/link|owner\/prepare)$/.test(call)), 'browsing funding does not initiate actions');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `/tmp/funding-${width}.png`, fullPage: true });
    await context.close();
    console.log(`PASS separated directions and reported versus held funds at ${width}px`);
  }
  {
    const context = await browser.newContext();
    const { page, state } = await open(context, '/a/payables/funding', { held: true, missingTerms: true, clock: true });
    await page.getByText('Payment terms unavailable', { exact: true }).waitFor();
    await page.getByText('1000000 raw units of unknown-token to payee.near', { exact: true }).waitFor();
    state.error = 'held';
    await page.clock.fastForward(16000);
    await page.getByText('Held payout amounts are unavailable.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('list', { name: 'Held payout records' }).count(), 0, 'failed refresh must not present cached amounts as current');
    await page.getByText('Not established', { exact: true }).waitFor();
    state.error = 'overview';
    await page.clock.fastForward(31000);
    await page.clock.runFor(10000);
    await page.getByText(/Last reported balances; the latest refresh failed/).waitFor();
    await page.getByText('Not established', { exact: true }).waitFor();
    await context.close();
    console.log('PASS missing terms, unknown assets and failed refresh do not invent available funds');
  }
  for (const error of ['held', 'unresolved', 'treasury/get']) {
    const context = await browser.newContext();
    const { page, calls } = await open(context, '/a/payables/funding', { error });
    await page.getByText('Not established', { exact: true }).waitFor();
    if (error === 'held') {
      await page.getByText('Held payout amounts are unavailable.', { exact: true }).waitFor();
      assert.equal(await page.getByText('No held payouts found in the records checked.', { exact: true }).count(), 0);
    }
    if (error === 'treasury/get') {
      await page.getByText('Linked account could not be checked.', { exact: true }).waitFor();
      assert.equal(await page.getByText('Link a treasury account', { exact: true }).count(), 0);
    }
    assert.ok(!calls.includes('pay'));
    await context.close();
    console.log(`PASS ${error} failure never implies available funds or absent account`);
  }
  {
    const context = await browser.newContext();
    const { page } = await open(context, '/a/payables/funding', { unresolved: true });
    await page.getByRole('link', { name: 'Review unresolved operations', exact: true }).waitFor();
    await page.getByText('No held payouts found in the records checked.', { exact: true }).waitFor();
    await page.getByText('Not established', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Get a deposit address', exact: true }).waitFor();
    await context.close();
    console.log('PASS empty held records do not prove spendability');
  }
}

async function fundingPresentation(browser, root) {
  const { budget, setup, overview } = workspaceEvidence();
  const results = [];
  const filter = process.env.CASE_FILTER;
  async function check(name, work) {
    if (filter && !name.includes(filter)) return;
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' });
    try { await work(context); results.push({ name, pass: true }); }
    catch (error) { results.push({ name, pass: false, error: error.message }); }
    finally { await context.close(); }
  }
  const open = workspaceOpener(root, { budget, values(kind, options, state, run) {
    const values = { instance: { agentId: 'fixture', executor: !options.approveOnly }, setup: { ...setup, ...(options.noGrant && { grant: null }), ...(options.approveOnly && { executor: false }) }, overview: overview(kind), 'treasury/get': null, held: options.held && kind === 'payables' ? [{ at: new Date().toISOString(), request: { amount: '1000000', asset: 'usdc', recipient: 'payee.near' }, kind: 'payout', correlationId: 'fixture-held-payment', approvalId: 'fixture-approval' }] : [], unresolved: options.unresolved && kind === 'payables' ? [{ kind: 'payout', at: new Date().toISOString(), key: 'fixture-unresolved', request: {}, status: null, sent: false }] : [],
      'inbox/list': [], 'agreements/list': options.agreed ? [{ id: 'agreement-fixture', payee: 'payee.near', amount: '1000000', status: 'agreed', origin: 'owner', at: '2026-10-01T00:00:00Z', note: '' }] : [], activity: [], invoices: [], reconcileBooks: [], 'owner/pending': [], 'owner/actions': [], paymentHistory: { items: [], complete: true },
      'autopilot/get': { on: true, everyMin: 60, maxUsd: 10, lastRun: null, nextRun: null },
      'autopilot/evidence': { ticks: [run], corrupt: [] } };
    if (options.unmanaged) {
      values.overview.unmanaged = [{ asset: 'unmanaged', symbol: 'OTHER', amount: 1000000n, decimals: 6, usd: null, price: null, priceUpdatedAt: null, priceExpiresAt: null }];
      values.overview.policy.policy.assets = options.excluded ? ['usdc'] : 'any';
    }
    return values;
  } });
  const width = 390;
  await check(`funding starts with a deposit at ${width}px`, async context => {
    const { page, calls } = await open(context, '/a/treasury/funding');
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('button', { name: 'Get a deposit address', exact: true }).waitFor();
    assert.ok(!await page.getByRole('textbox', { name: 'Treasury NEAR account' }).isVisible());
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `funding-${width}.png`), fullPage: true });
    const disclosure = page.getByText('Link a treasury account', { exact: true });
    await disclosure.focus(); await page.keyboard.press('Enter');
    assert.ok(await page.getByRole('textbox', { name: 'Treasury NEAR account' }).isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(!calls.includes('treasury/link'));
  });
  await check('optional linking is not an Overview blocker', async context => {
    const { page } = await open(context, '/a/treasury/');
    await page.getByRole('heading', { name: 'Portfolio · Overview', exact: true }).waitFor();
    assert.equal(await page.getByText(/No treasury linked/).count(), 0);
  });
  for (const excluded of [false, true]) {
    await check(`unmanaged asset: ${excluded ? 'excluded' : 'allowed'} by policy`, async context => {
      const { page, calls } = await open(context, '/a/treasury/', { unmanaged: true, excluded });
      const row = page.getByRole('listitem').filter({ hasText: 'The agent holds 1 OTHER,' });
      await row.waitFor();
      if (excluded) {
        const action = row.getByRole('link', { name: /Review policy assets/ });
        assert.ok((await action.getAttribute('href')).endsWith('/policy'));
      } else {
        assert.equal(await row.getByRole('link').count(), 0);
        assert.equal(await row.getByText('Review policy assets').count(), 0);
        assert.ok(await row.getByText(/outside the assets its strategies manage/).isVisible());
      }
      assert.ok(!calls.some(call => /prepare|execute|update/.test(call)));
    });
  }
  console.log(JSON.stringify(results, null, 2));
  if (!results.length || results.some(result => !result.pass)) process.exitCode = 1;
}

runTask([fundingBalances, fundingPresentation]);
