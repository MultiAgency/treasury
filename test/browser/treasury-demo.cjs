const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { join, resolve } = require('node:path');
const { mkdirSync } = require('node:fs');
const { runTask } = require('./fixtures/task.cjs');
const { workspaceEvidence } = require('./fixtures/workspace.cjs');
const { rpcValue } = require('./fixtures/rpc.cjs');

async function treasuryDemo(browser, root) {
  const { budget, setup, overview } = workspaceEvidence({ policyDetails: true, grants: true });
  for (const scenario of ['streamed', 'unknown', 'refused']) {
    const context = await browser.newContext({ viewport: { width: scenario === 'streamed' ? 1280 : 390, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    const book = overview('treasury');
    book.area = 'treasury';
    book.book[0].priceUpdatedAt = new Date().toISOString();
    book.book[0].priceExpiresAt = new Date(Date.now() + 600_000).toISOString();
    const from = book.book[0], to = { asset: 'near', symbol: 'wNEAR', decimals: 24 };
    book.policy.policy.limits = { monthly: { usdc: '100000000' } };
    book.policy.policy.budget = { daily_usd: '100', weekly_usd: '100', monthly_usd: '100' };
    const planId = `selected-${scenario}`, calls = [], writes = [], errors = [];
    const state = { started: false, results: 0, budgetError: false, recordsError: false, policyChanged: false, policyUnknown: false };
    const oldRefusal = { at: '2026-10-01T00:00:00Z', kind: 'swap', refused: 'spend_budget_exceeded', planId: 'older-plan', request: { origin_asset: 'usdc', destination_asset: 'near', amount: '1000000' } };
    const records = () => [oldRefusal, { at: '2026-10-15T12:00:00Z', kind: 'swap', status: 'SUCCESS', planId: 'unrelated-plan', correlationId: 'unrelated-operation', request: {} },
      ...(state.started ? scenario === 'refused' ? [{ ...oldRefusal, at: '2026-10-15T12:01:00Z', planId }] : [
        { at: '2026-10-15T12:01:00Z', kind: 'swap', planId, correlationId: 'selected-operation-one', status: scenario === 'unknown' ? undefined : 'SUCCESS', request: { origin_asset: 'usdc', destination_asset: 'near', amount: '1000000' } },
        ...(state.results === 2 ? [{ at: '2026-10-15T12:02:00Z', kind: 'swap', planId, correlationId: 'selected-operation-two', status: 'SUCCESS', request: { origin_asset: 'usdc', destination_asset: 'near', amount: '1000000' } }] : []),
      ] : []),
    ];
    let finishStream;
    const continuation = new Promise(resolve => { finishStream = resolve; });
    const server = createServer(async (request, response) => {
      if (request.url !== '/a/treasury/rpc/executePlan' || request.method !== 'POST') { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' });
      state.started = true; state.results = 1;
      response.write(`data: ${JSON.stringify({ json: { type: 'action', index: 0, status: 'SUCCESS', correlationId: 'selected-operation-one' } })}\n\n`);
      await continuation;
      state.results = 2;
      response.end(`data: ${JSON.stringify({ json: { type: 'action', index: 1, status: 'SUCCESS', correlationId: 'selected-operation-two' } })}\n\n`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const { hostname, pathname } = new URL(route.request().url());
        if (hostname !== '127.0.0.1') return route.abort();
        if (pathname === '/gw/me') return route.fulfill({ json: { agents: [{ name: 'treasury', area: 'treasury', owner: 'owner.near', dao: false }], invoices: null,
          viewer: { account: 'owner.near', access: { treasury: { canSign: true, canPropose: true, canVote: true, canExecute: true, canManage: true } } } } });
        if (pathname.includes('/rpc/')) {
          const method = pathname.split('/rpc/')[1]; calls.push(method);
          if (method === 'rebalance') {
            writes.push(method);
            const events = [{ type: 'plan', legs: [0, 1].map(() => ({ from, to, amount: '1000000', usd: 1 })), budget: '90' },
              ...[0, 1].map(leg => ({ type: 'quote', leg, amountOut: '1000000000000000000000000', minAmountOut: '990000000000000000000000', costBps: 5, worstCostBps: 100, skipped: false })),
              { type: 'saved', plan: { id: planId, expiresAt: '2030-01-01T00:00:00Z' }, steps: [0, 1] }];
            return route.fulfill({ contentType: 'text/event-stream', body: events.map(json => `data: ${JSON.stringify({ json })}\n\n`).join('') });
          }
          if (method === 'executePlan') {
            writes.push(method); assert.deepEqual(route.request().postDataJSON().json, { planId });
            if (scenario === 'streamed') return route.continue();
            state.started = true;
            return route.fulfill({ status: 500, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: scenario === 'unknown' ? 'Execution response interrupted' : 'spend_budget_exceeded' } } });
          }
          if ((method === 'overview' && state.budgetError) || (method === 'activity' && state.recordsError)) return route.fulfill({ status: 503, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Observation unavailable' } } });
          const current = structuredClone(book);
          if (state.policyChanged) current.digest = 'new-policy';
          if (state.policyUnknown) current.digest = null;
          current.policy.usage.budget = Object.fromEntries(Object.entries(budget).map(([period, window]) => [period, { ...window, remaining_usd: String(90 - state.results), spent_usd: String(10 + state.results) }]));
          const values = { setup: { ...setup, executor: true }, instance: { agentId: 'fixture', executor: true }, overview: current, 'treasury/get': null,
            unresolved: state.started && scenario === 'unknown' ? [{ key: 'unknown-operation', kind: 'swap', sent: true, at: new Date().toISOString() }] : [],
            activity: records(), 'owner/actions': [], 'autopilot/get': { on: false, everyMin: 60, maxUsd: 10 } };
          return route.fulfill({ json: { json: rpcValue(values, method) } });
        }
        if (pathname.startsWith('/static/')) return route.fulfill({ path: join(root, pathname), contentType: pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'font/woff2' });
        return route.fulfill({ path: join(root, 'index.html'), contentType: 'text/html' });
      });
      await page.goto(origin + '/a/treasury/');
      await page.getByRole('table', { name: 'USD budget windows' }).waitFor({ timeout: 2000 });
      assert.equal(calls.includes('activity'), false, 'history loads on request, not on entry');
      await page.getByText('Review recorded refusals', { exact: true }).click();
      await page.getByText('spend_budget_exceeded', { exact: true }).waitFor();
      assert.deepEqual(writes, [], 'reviewing refusals issues no probe');
      await page.getByText('Review recorded refusals', { exact: true }).click();
      const rebalance = page.getByRole('region', { name: 'Quoted rebalance', exact: true });
      await rebalance.getByRole('button', { name: 'Preview', exact: true }).click();
      await rebalance.getByRole('button', { name: 'Execute', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Execute the previewed rebalance on mainnet?' });
      assert.deepEqual(writes, ['rebalance'], 'opening confirmation does not execute');
      await dialog.getByRole('button', { name: 'Execute swaps', exact: true }).click();
      const outcome = page.getByRole('region', { name: 'Confirmed plan outcome', exact: true });
      await outcome.waitFor();
      await outcome.getByText('Confirmed plan reference', { exact: true }).click();
      await outcome.getByText(planId, { exact: true }).waitFor();
      const operations = outcome.getByRole('heading', { name: 'This plan’s operations', exact: true });
      await operations.waitFor();
      assert.equal(await outcome.getByText('unrelated-operation', { exact: true }).count(), 0, 'never substitutes another plan');
      if (scenario === 'streamed') {
        await outcome.getByText('$89.00', { exact: true }).first().waitFor();
        assert.equal(state.results, 1, 'budget refresh occurs while execution stream remains open');
        finishStream();
        await outcome.getByText('$88.00', { exact: true }).first().waitFor();
        state.policyChanged = true;
        await outcome.getByRole('button', { name: 'Refresh observations', exact: true }).click();
        await outcome.getByText('The reported policy changed.', { exact: false }).waitFor();
        assert.equal(await outcome.getByText('$88.00', { exact: true }).count(), 0, 'do not compare headroom across policies');
        state.policyChanged = false;
        state.policyUnknown = true;
        await outcome.getByRole('button', { name: 'Refresh observations', exact: true }).click();
        await outcome.getByText('Policy identity is unavailable.', { exact: false }).waitFor();
        assert.equal(await outcome.getByText('$88.00', { exact: true }).count(), 0, 'missing policy identity cannot establish a comparison');
        state.policyUnknown = false;
        await outcome.getByRole('button', { name: 'Refresh observations', exact: true }).click();
        await outcome.getByText('$88.00', { exact: true }).first().waitFor();
        assert.equal(await outcome.getByText('$90.00', { exact: true }).count(), 3, 'baseline remains the pre-confirmation observations');
        state.budgetError = true; state.recordsError = true;
        await outcome.getByRole('button', { name: 'Refresh observations', exact: true }).click();
        await outcome.getByText('Current budget observation unavailable.', { exact: true }).waitFor();
        assert.equal(await outcome.getByText('$88.00', { exact: true }).count(), 0, 'failed refresh cannot masquerade as a current budget');
        assert.equal(await outcome.getByText('No operations for this plan are recorded here yet.', { exact: false }).count(), 0, 'failed records read is not empty history');
        state.budgetError = false; state.recordsError = false;
        await outcome.getByRole('button', { name: 'Refresh observations', exact: true }).click();
        await outcome.getByText('$88.00', { exact: true }).first().waitFor();
      } else if (scenario === 'unknown') {
        await page.getByRole('heading', { name: 'Unresolved operations', exact: true }).waitFor();
        assert.equal(await outcome.getByText(/completed|settled successfully/i).count(), 0, 'stream error never establishes settlement');
      } else await outcome.getByText('refused · over the USD budget', { exact: true }).waitFor();
      assert.deepEqual(writes, ['rebalance', 'executePlan'], 'refresh and outcomes never replay a send');
      assert.deepEqual(errors, []);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (scenario === 'streamed') {
        const shots = resolve(process.env.PROTO_BROWSER_ARTIFACTS || '.test-artifacts/treasury-demo'); mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: join(shots, 'outcome-desktop.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: join(shots, 'outcome-mobile.png'), fullPage: true });
      }
      await page.reload();
      await page.getByRole('heading', { name: 'Rebalance', exact: true }).waitFor();
      assert.equal(await page.getByRole('region', { name: 'Confirmed plan outcome', exact: true }).count(), 0, 'reload clears local plan selection without replay');
      assert.deepEqual(writes, ['rebalance', 'executePlan']);
    } catch (error) {
      console.error('Treasury fixture failure:', { scenario, state, calls, writes }, await page.locator('body').innerText());
      throw error;
    } finally {
      finishStream(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await context.close();
    }
  }
}
runTask([treasuryDemo]);
