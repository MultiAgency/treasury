const assert = require('node:assert/strict');
const { runTask } = require('./fixtures/task.cjs');
const { workspaceEvidence, workspaceOpener } = require('./fixtures/workspace.cjs');

async function treasuryScope(browser, root) {
  const { budget, setup, overview } = workspaceEvidence();
  const book = overview('treasury');
  book.book[0].priceUpdatedAt = new Date().toISOString();
  const open = workspaceOpener(root, { budget, values: () => ({
    setup: { ...setup, executor: true }, instance: { agentId: setup.agentId, executor: true }, overview: book, 'treasury/get': null, unresolved: [], held: [], activity: [], 'owner/actions': [],
    'autopilot/get': { on: false, everyMin: 60, maxUsd: 10, lastRun: null, nextRun: null },
  }) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  for (const path of ['/', '/#/explore/payables/overview', '/#/explore/treasury/overview']) {
    const { page, calls, errors } = await open(context, path, { public: true });
    await page.getByRole('heading', { name: /Your treasury.*Your limits/ }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Payables overview' }).count(), 0);
    assert.deepEqual(calls, [], 'public entry and legacy hashes read no private agent records');
    assert.deepEqual(errors, []);
    await page.close();
  }
  const payout = await open(context, '/a/payables/');
  await payout.page.getByRole('heading', { name: 'Treasury unavailable', exact: true }).waitFor();
  assert.deepEqual(payout.calls, [], 'out-of-scope agent must not mount private task queries');
  await payout.page.close();
  for (const path of ['/a/treasury/payees']) {
    const { page, calls, requests, errors } = await open(context, path);
    await page.getByRole('heading', { name: 'Signed limits', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Rebalance', exact: true }).count(), 1);
    assert.equal(await page.getByRole('heading', { name: 'Known limitations', exact: true }).count(), 1);
    assert(!calls.some(method => ['pay', 'sweep', 'rebalance', 'executePlan', 'owner/prepare', 'steward', 'agreements'].includes(method)), 'redirects must neither prepare nor send actions');
    assert(!requests.some(url => url.includes('/payables/')));
    assert.equal(await page.getByText('Review invoices in Payments', { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.close();
  }
  const steward = await open(context, '/a/treasury/steward');
  await steward.page.getByRole('heading', { name: 'Steward (experimental)', exact: true }).waitFor({ timeout: 2000 });
  assert.equal(await steward.page.getByRole('button', { name: 'Execute plan', exact: true }).isDisabled(), true);
  assert.equal(await steward.page.getByRole('link', { name: /steward/i }).count(), 0, 'Steward remains absent from navigation');
  assert(!steward.calls.some(method => ['steward/propose', 'executePlan', 'pay', 'sweep', 'owner/prepare'].includes(method)), 'opening Steward does not propose or execute');
  await steward.page.reload();
  await steward.page.getByRole('heading', { name: 'Steward (experimental)', exact: true }).waitFor({ timeout: 2000 });
  assert.equal(new URL(steward.page.url()).pathname, '/a/treasury/steward');
  assert(await steward.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(steward.errors, []);
  await steward.page.close();
  const activity = await open(context, '/a/treasury/follow/payment?payment=old-record');
  await activity.page.getByRole('heading', { name: 'Operation history', exact: true }).waitFor();
  assert.equal(await activity.page.getByText('Review invoices in Payments', { exact: true }).count(), 0);
  assert.equal(await activity.page.getByRole('link', { name: 'Back to Activity', exact: true }).count(), 0);
  assert(!activity.calls.includes('paymentStatus'), 'historical payment URL lands on read-only operation history');
  assert.deepEqual(activity.errors, []);
  await activity.page.close();
  const funding = await open(context, '/a/treasury/funding');
  await funding.page.getByRole('heading', { name: 'Balances', exact: true }).waitFor();
  assert.equal(await funding.page.getByRole('heading', { name: 'Send funds', exact: true }).count(), 0);
  assert.equal(await funding.page.getByRole('heading', { name: 'Held payouts', exact: true }).count(), 0);
  assert.equal(await funding.page.getByText('Available to spend', { exact: true }).count(), 1);
  assert.equal(await funding.page.getByText('Not established', { exact: true }).count(), 1);
  assert(!funding.calls.some(method => ['pay', 'sweep', 'owner/prepare'].includes(method)));
  assert.deepEqual(funding.errors, []);
  const previewLink = funding.page.getByRole('link', { name: 'Continue to rebalance preview', exact: true });
  assert.equal(await previewLink.getAttribute('href'), '/a/treasury/#rebalance');
  await previewLink.click();
  await funding.page.getByRole('heading', { name: 'Rebalance', exact: true }).waitFor();
  await context.close();
}
runTask([treasuryScope]);
