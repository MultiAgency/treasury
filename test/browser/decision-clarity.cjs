const { rpcBody, UNAVAILABLE } = require('./fixtures/rpc.cjs');
const { runSuite } = require('./fixtures/task.cjs');
/** Offline presentation boundaries. All requests are intercepted; no executor or wallet starts. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('./fixtures/browser.cjs');
const root = path.resolve(process.argv[2] || 'web/dist');

runSuite(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  let failures = 0;
  async function check(name, options, verify) {
    const page = await browser.newPage();
    page.setDefaultTimeout(12000);
    const calls = [], errors = [];
    let on = true;
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'frontend.test') return route.abort();
      if (url.pathname === '/gw/me') return route.fulfill({ json: {
        agents: ['treasury', 'payables'].map(name => ({ name, area: name, owner: 'owner.near', dao: false })),
        invoices: null, viewer: { account: 'owner.near', access: Object.fromEntries(['treasury', 'payables'].map(name => [name,
          { canSign: !options.member, canPropose: !options.member, canVote: !options.member, canExecute: !options.member, canManage: !options.member }])) },
      } });
      if (url.pathname.includes('/rpc/')) {
        const method = url.pathname.split('/rpc/')[1];
        const treasury = url.pathname.includes('/treasury/');
        calls.push(method);
        if (method === options.fail && treasury) return route.fulfill({ status: 503,
          json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Fixture observation unavailable' } } });
        if (method === 'autopilot/stop') on = false;
        const values = {
          instance: { agentId: 'fixture', area: treasury ? 'treasury' : 'payables', executor: !options.approveOnly },
          setup: { agentId: 'fixture', executor: !options.approveOnly, wallet: 'agent.near', owner: { type: 'near', account_id: 'owner.near', public_key: 'ed25519:fixture' },
            grant: options.noGrant ? null : { id: 'grant-fixture', label: 'treasury', expiresAt: '2030-01-01T00:00:00Z' }, dao: null },
          overview: { agentId: 'fixture', area: treasury ? 'treasury' : 'payables', digest: 'fixture', notInForce: null, agreed: [], unmanaged: [], grants: [],
            book: [], target: {}, rebalance: { minLegUsd: 1, maxCostBps: 100 },
            policy: { policy: { actions: treasury ? ['swap'] : ['transfer'], frozen: false, confidential: false, owner_approval: false, assets: 'any', limits: {}, max_actions_per_hour: 10, destinations: { mode: 'only', list: [] }, budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, timelock_ms: 0 }, usage: { budget: { daily: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, weekly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, monthly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null } }, timelock: { delay_ms: 0, scheduled_count: 0 } }, cooldowns: { policy_change_available_at: null, unfreeze_available_at: null }, wallet_id: 'agent.near', revision: null, status: 'APPLIED', provider_policy_synced: true } },
          'treasury/get': null, held: [], 'inbox/list': [], 'agreements/list': [], invoices: [],
          unresolved: treasury ? [] : [{ kind: 'payout', key: 'fixture', at: '2026-10-01T00:00:00Z', request: {}, status: null, sent: false }],
          'autopilot/get': { on, everyMin: 60, maxUsd: 10, lastRun: null, nextRun: null }, 'autopilot/stop': { on: false },
          'autopilot/evidence': { ticks: [], corrupt: [] }, 'owner/actions': [],
          activity: ['refused', 'unknown', 'settled'].map((state, i) => ({ at: `2026-10-01T00:00:0${i}Z`, kind: 'transfer',
            request: { asset: 'usdc', amount: '1000000', recipient: `${state}.near` }, policyRevision: 1, policyDigest: 'fixture',
            ...(state === 'refused' ? { refused: 'never_submitted' } : state === 'settled' ? { correlationId: 'settled', status: 'SUCCESS' } : {}) })),
        };
        if (method === 'reconcileBooks') return route.fulfill({ status: 503,
          json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Books unavailable' } } });
        assert.ok(method in values, `Unexpected call: ${method}`);
        return route.fulfill({ json: rpcBody(values, method) });
      }
      return route.fulfill({ path: url.pathname.startsWith('/static/') ? root + url.pathname : path.join(root, 'index.html') });
    });
    try {
      await page.goto('http://frontend.test' + (options.route || '/a/treasury/activity'));
      await verify(page, calls);
      assert.deepEqual(errors, []);
      console.log('PASS ' + name);
    } catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); }
    finally { await page.close(); }
  }
  try {
    await check('record wording and lazy books preserve outcomes', {}, async (page, calls) => {
      await page.getByText('Operations recorded on this instance, including refusals, newest first.').waitFor();
      for (const recipient of ['refused.near', 'unknown.near', 'settled.near']) await page.getByText(recipient, { exact: false }).waitFor();
      assert.equal(await page.getByText('Recorded policy revision 1', { exact: true }).count(), 3);
      await page.getByText('refused · never submitted', { exact: true }).waitFor();
      await page.getByText('unsettled', { exact: true }).waitFor();
      await page.getByText('success', { exact: true }).waitFor();
      assert.ok(!calls.includes('reconcileBooks'));
      await page.getByText('Compare balances with records', { exact: true }).click();
      await page.locator('details', { has: page.getByText('Compare balances with records', { exact: true }) }).getByText(UNAVAILABLE, { exact: true }).waitFor();
      assert.ok(calls.includes('reconcileBooks'), 'only the opened disclosure starts books reads, including normal retries');
      await page.getByText('refused · never submitted', { exact: true }).waitFor();
    });
    await check('one incomplete-check explanation retains another agent’s unresolved item', { route: '/', fail: 'setup' }, async page => {
      await page.getByText(/1 money action has no proven outcome/).waitFor();
      assert.equal(await page.getByRole('listitem').filter({ hasText: 'treasury: checks are incomplete (agent setup)' }).getByText(UNAVAILABLE, { exact: true }).count(), 1);
      assert.equal(await page.getByText(UNAVAILABLE, { exact: true }).count(), 1);
      assert.equal(await page.getByRole('link', { name: 'Check status', exact: true }).getAttribute('href'), '/a/payables/activity');
    });
    await check('grant tasks link directly to the appropriate area task', { route: '/', noGrant: true }, async (page, calls) => {
      const issue = page.getByRole('link', { name: 'Issue', exact: true });
      await issue.nth(1).waitFor();
      assert.deepEqual((await issue.evaluateAll(links => links.map(link => link.getAttribute('href')))).sort(),
        ['/a/payables/policy#grants', '/a/treasury/automations']);
      assert.equal(calls.filter(call => call === 'overview').length, 2, 'one overview read per agent');
      assert.equal(calls.filter(call => call === 'setup').length, 2, 'one setup read per agent');
    });
    await check('unknown area retains the policy fallback for grants', { route: '/', noGrant: true, fail: 'overview' }, async page => {
      await page.getByRole('link', { name: 'Issue', exact: true }).nth(1).waitFor();
      assert.ok((await page.getByRole('link', { name: 'Issue', exact: true }).evaluateAll(links => links.map(link => link.getAttribute('href')))).includes('/a/treasury/policy#grants'));
    });
    await check('Activity does not depend on linked-treasury reads', { fail: 'treasury/get' }, async (page, calls) => {
      await page.getByText('Operations recorded on this instance, including refusals, newest first.').waitFor();
      assert.ok(!calls.includes('treasury/get'));
    });
    await check('stop survives cold overview failure', { fail: 'overview' }, async (page, calls) => {
      await page.locator('main').filter({ hasText: 'Some agent details could not be loaded.' }).getByText(UNAVAILABLE, { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Turn off', exact: true }).click();
      await page.getByText('Future scheduled runs are off. A run already started can still submit further operations; submitted operations may finish.', { exact: true }).waitFor();
      assert.deepEqual(calls.filter(c => /stop|enable|prepare|submit|tick|save/.test(c)), ['autopilot/stop']);
    });
    for (const options of [{ member: true, fail: 'overview' }, { approveOnly: true, fail: 'overview' }, { fail: 'setup' }])
      await check(`no stop without confirmed authority ${JSON.stringify(options)}`, options, async (page, calls) => {
        await page.locator('main').filter({ hasText: options.fail === 'setup' ? 'Setup unavailable' : 'Some agent details could not be loaded.' }).getByText(UNAVAILABLE, { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Turn off', exact: true }).count(), 0);
        assert.ok(!calls.includes('autopilot/stop'));
      });
  } finally { await browser.close(); }
  process.exitCode = failures ? 1 : 0;
});
