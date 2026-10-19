/** A validated recording end remains visible while the separate run receipt is delayed or unreadable. */
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { runTask } = require('./fixtures/task.cjs');
const { rpcAnswer, rpcBody, UNAVAILABLE } = require('./fixtures/rpc.cjs');
const { makeTick } = require('./fixtures/run.cjs');
const { workspaceEvidence } = require('./fixtures/workspace.cjs');
const { tickLog } = require('../../src/agui.ts');

async function delayedRunReceipt(browser, root) {
  const { budget, setup, overview } = workspaceEvidence();
  const at = new Date(Date.now() - 60_000).toISOString();
  const endedAt = new Date(Date.now() - 30_000).toISOString();
  const base = makeTick('quiet', budget);
  const tick = { ...base, at, progressVersion: 1, end: { ...base.end, endedAt,
    before: { error: 'Balance read unavailable' }, after: { error: 'Balance read unavailable' },
    outcome: 'Failed: balance read unavailable' } };
  const progress = [{ version: 1, agentId: tick.agentId, tickId: tick.id, sequence: 1,
    at: new Date(Date.parse(at) + 1000).toISOString(), event: { type: 'STEP_STARTED', stepName: 'balances-before' } }];
  const recording = ended => tickLog(ended ? tick : { ...tick, end: null },
    { agentId: tick.agentId, records: [], gaps: [] }, {
      exportedAt: new Date().toISOString(), display: { asOf: endedAt, assets: [] }, progress,
    });
  assert.equal(recording(true).schemaVersion, 3);
  assert.equal(recording(true).events.at(-1).code, 'tick_failed');

  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(20_000);
  const calls = [], errors = [];
  const state = { recordingEnded: false, receipt: 'incomplete' };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const { hostname, pathname } = new URL(route.request().url());
    if (hostname !== 'frontend.test') return route.abort();
    if (pathname === '/gw/me') return route.fulfill({ json: {
      agents: [{ name: 'treasury', owner: 'owner.near', dao: false }], invoices: null,
      viewer: { account: 'member.near', access: { treasury: { canSign: false, canPropose: false, canVote: false, canExecute: false, canManage: false } } },
    } });
    if (pathname.includes('/rpc/')) {
      const method = pathname.split('/rpc/')[1]; calls.push(method);
      if (method === 'autopilot/log') {
        assert.equal(route.request().postDataJSON().json.tickId, tick.id);
        return route.fulfill({ json: rpcAnswer(method, recording(state.recordingEnded)) });
      }
      if (method === 'autopilot/evidence' && state.receipt === 'unavailable') return route.fulfill({
        status: 503, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Run receipt unavailable' } },
      });
      const values = {
        instance: { agentId: tick.agentId, executor: true }, setup: { ...setup, executor: true }, overview: overview('treasury'),
        'treasury/get': null, 'autopilot/get': { on: false, everyMin: 60, maxUsd: 10, lastRun: null, nextRun: null },
        'autopilot/evidence': { ticks: [state.receipt === 'available' ? tick : { ...tick, end: null }], corrupt: [] },
        held: [], unresolved: [], activity: [], 'inbox/list': [], 'agreements/list': [], 'owner/pending': [], 'owner/actions': [],
      };
      return route.fulfill({ json: rpcBody(values, method) });
    }
    if (pathname.startsWith('/static/')) return route.fulfill({ path: join(root, pathname),
      contentType: pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'font/woff2' });
    if (pathname.startsWith('/gw/')) throw new Error('Unexpected gateway request: ' + pathname);
    return route.fulfill({ path: join(root, 'index.html'), contentType: 'text/html' });
  });

  await page.goto('http://frontend.test/a/treasury/follow/run');
  const timeline = page.getByRole('region', { name: 'Run timeline', exact: true });
  await timeline.getByText('Last recorded: Checking balances · started.', { exact: true }).waitFor();
  state.recordingEnded = true;
  await timeline.getByRole('button', { name: 'Refresh outcomes', exact: true }).click();
  const terminalSummary = timeline.getByText('Run failure recorded. Operation outcomes are shown separately. The run receipt has not refreshed yet.', { exact: true });
  await terminalSummary.waitFor();
  await timeline.getByText('Following later operation outcomes.', { exact: true }).waitFor();
  await timeline.getByText('No return recorded', { exact: true }).waitFor();
  assert.equal(await timeline.getByText(/^Last recorded:|^Run started\. No end recorded yet\.$/).count(), 0,
    'a validated end must replace stale claims that the run or its last stage is still active');
  assert.equal(await timeline.getByText(/^Run outcome:/).count(), 0, 'the delayed receipt cannot fabricate an original outcome');

  state.receipt = 'unavailable';
  const receiptError = page.locator('section', { has: page.getByRole('heading', { name: 'Follow this run', exact: true }) }).getByRole('alert').filter({ hasText: UNAVAILABLE });
  await receiptError.waitFor();
  assert.ok(await terminalSummary.isVisible(), 'a receipt read failure must retain the validated terminal summary');
  assert.equal(await timeline.getByText(/^Last recorded:|^Run started\. No end recorded yet\.$/).count(), 0,
    'failed receipt refreshes cannot restore an obsolete stage claim');

  state.receipt = 'available';
  await receiptError.getByRole('button', { name: 'Check again', exact: true }).click();
  await timeline.getByText('Run outcome: Failed: balance read unavailable', { exact: true }).waitFor();
  assert.equal(await terminalSummary.count(), 0, 'the original receipt replaces the temporary summary after recovery');
  await timeline.getByText('A recorded end does not prove every operation settled. Activity shows subsequent recorded outcomes.', { exact: true }).waitFor();
  assert.ok(await page.getByRole('button', { name: 'Run now', exact: true }).isDisabled());
  assert.ok(!calls.some(method => /^(pay|executePlan|recover|owner\/(prepare|submit)|autopilot\/tick)$/.test(method)),
    'recording and receipt refreshes never prepare, reconcile or send a money action');
  assert.deepEqual(errors, []);
  console.log('PASS: terminal recording survives delayed and failed receipt reads, then restores its original outcome without writes');
  await page.close();
}

runTask([delayedRunReceipt]);
