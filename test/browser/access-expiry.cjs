/** Authorization loss must clear only the affected private views, including during gateway refresh. */
const assert = require('node:assert/strict');
const { runSuite } = require('./fixtures/task.cjs');
const path = require('node:path');
const { chromium } = require('./fixtures/browser.cjs');
const { rpcBody } = require('./fixtures/rpc.cjs');
const root = path.resolve(process.argv[2] || 'web/dist');

runSuite(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    async function open(routePath, options = {}) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.clock.install(); page.setDefaultTimeout(5000);
      const state = { denied: false, unavailable: false, gatewayUnavailable: false, permissions: null, procedureDenied: Boolean(options.initialProposalDenial), holdProposals: false, status: 403, gatewayReads: 0, proposalDenials: 0, waiting: [], waitingProposals: [], errors: [], calls: [] };
      page.on('pageerror', error => state.errors.push(error.message));
      const gateway = () => {
        const names = state.denied ? ['healthy'] : ['payables', 'healthy'];
        return { agents: names.map(name => ({ name, owner: 'owner.near', dao: Boolean(options.dao), area: 'payables' })),
          invoices: null, viewer: { account: 'owner.near', access: Object.fromEntries(names.map(name => [name,
            name === 'payables' && state.permissions ? state.permissions : { canSign: !options.dao, canPropose: false, canVote: false, canExecute: true, canManage: true }])) } };
      };
      const proposals = (suffix = '') => ['payables', 'healthy'].map((agent, index) => ({
        id: 42 + index, what: 'agent', agent, type: 'policy_update', correlationId: `${agent}-policy`,
        state: 'waiting', expiresAt: '2099-01-01T00:00:00Z', status: 'InProgress', proposer: 'owner.near', votes: {},
        hash: `${agent}-hash`, submittedAt: '2026-10-01T00:00:00Z', description: '',
        check: { kind: 'verified', standard: 'nep413', message: { payee: `${agent}-private-proposal${suffix}.near` } },
      }));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url()), p = url.pathname;
        if (url.hostname !== 'frontend.test') return route.abort();
        if (p === '/gw/me') {
          state.gatewayReads++;
          if (state.gatewayUnavailable) return route.fulfill({ status: 503, json: { error: 'Fixture permission metadata unavailable' } });
          if (state.denied) { state.waiting.push(route); return; }
          return route.fulfill({ json: gateway() });
        }
        if (p === '/gw/proposals') {
          if (state.holdProposals) { state.waitingProposals.push(route); return; }
          if (state.procedureDenied) {
            state.proposalDenials++;
            // Bound a broken client's self-refetch loop so a failing regression can finish.
            if (state.proposalDenials > 8) return route.abort();
            return route.fulfill({ status: 403, json: { error: 'Proposal access denied', access: 'procedure' } });
          }
          const unknown = { id: options.activityHistory ? 44 : 42, what: 'unknown', status: 'InProgress', proposer: 'owner.near', votes: {}, hash: 'fixture-proposal-hash',
            submittedAt: '2026-10-01T00:00:00Z', description: 'Private proposal description' };
          if (options.sharedDao) return route.fulfill({ json: [...proposals(), ...(options.activityHistory ? [unknown] : [])] });
          return route.fulfill({ json: [unknown] });
        }
        if (p.includes('/rpc/')) {
          const agent = p.split('/')[2], method = p.split('/rpc/')[1];
          state.calls.push([agent, method]);
          if (state.procedureDenied && method === 'deposit') return route.fulfill({ status: 403, json: options.encodedProcedure
            ? { json: { defined: false, code: 'FORBIDDEN', message: 'This account does not have permission for this action', data: { fixture: 'underlying-rpc' } } }
            : { error: 'This account does not have permission for this action', access: 'procedure' } });
          if (agent === 'payables' && state.denied) return route.fulfill({ status: state.status,
            json: { error: 'Access denied', access: state.status === 401 ? 'session' : 'agent' } });
          if (agent === 'payables' && state.unavailable) return route.fulfill({ status: 503,
            json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Fixture unavailable' } } });
          const payee = agent === 'payables' ? 'private-payee.near' : 'healthy-payee.near';
          const values = {
            instance: { agentId: agent, executor: true },
            setup: { agentId: agent, executor: true, wallet: `${agent}.near`, owner: { type: 'near', account_id: 'owner.near', public_key: 'ed25519:fixture' }, grant: null, dao: null },
            overview: { agentId: agent, area: 'payables', digest: 'fixture', notInForce: null, agreed: [payee], unmanaged: [], target: {}, rebalance: { minLegUsd: 1, maxCostBps: 100 },
              book: [], grants: [], policy: { revision: 1, status: 'APPLIED', policy: { actions: ['transfer'], assets: 'any', budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, owner_approval: true, confidential: true,
                destinations: { mode: 'only', list: [{ action: 'transfer', address: payee, confidential: true }] }, frozen: false, limits: {}, max_actions_per_hour: 10, timelock_ms: 0 }, wallet_id: 'agent.near', provider_policy_synced: true, cooldowns: { policy_change_available_at: null, unfreeze_available_at: null }, usage: { budget: { daily: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, weekly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, monthly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null } }, timelock: { delay_ms: 0, scheduled_count: 0 } } } },
            'treasury/get': null, 'autopilot/get': { on: false, everyMin: 60, maxUsd: 0, lastRun: null, nextRun: null },
            held: [{ correlationId: `${agent}-payment`, at: new Date().toISOString(), request: { recipient: payee, asset: 'usdc', amount: '1000000' }, kind: 'payout', approvalId: 'fixture-approval' }],
            unresolved: [], 'inbox/list': [], 'agreements/list': [], 'owner/actions': [], 'owner/pending': [], policyHistory: [],
            activity: options.activityHistory ? [{ at: '2026-10-01T00:00:00Z', kind: 'payout', correlationId: `${agent}-retained-operation`,
              request: { recipient: payee, asset: 'usdc', amount: '1000000' }, status: 'SUCCESS' }] : [],
          };
          if (options.payment) Object.assign(values, {
            activity: [], invoices: [], paymentHistory: { items: [], complete: true },
            paymentStatus: { status: 'PROCESSING', request: { recipient: payee, asset: 'usdc', amount: '1000000' }, approvalId: 'fixture-approval', failureCode: null, createdAt: null, updatedAt: null, expiresAt: null, detailError: null, evidence: { txHash: null, destinationTxHash: null, refundTxHash: null, refundTo: null, refundedAmount: null } },
            'owner/pending': [{ correlationId: 'fixture-owner-action', type: 'approval_vote', expiresAt: '2099-01-01T00:00:00Z', hash: 'fixture-proposal-hash', state: 'waiting',
              intent: { standard: 'nep413', payload: { message: '{}', recipient: 'fixture', nonce: 'fixture' } }, delegate: null,
              payment: { correlationId: `${agent}-payment`, verdict: 'approve' } }],
            'owner/status': { stage: 'voting', expiresAt: '2099-01-01T00:00:00Z' },
          });
          return route.fulfill({ json: rpcBody(values, method) });
        }
        if (p.startsWith('/static/')) return route.fulfill({ path: root + p,
          contentType: p.endsWith('.js') ? 'application/javascript' : p.endsWith('.css') ? 'text/css' : 'font/woff2' });
        return route.fulfill({ path: root + '/index.html', contentType: 'text/html' });
      });
      await page.goto('http://frontend.test' + routePath);
      return { page, state, gateway, proposals };
    }
    {
      const { page, state, gateway } = await open('/');
      await page.getByText(/private-payee.near/).waitFor();
      await page.getByText(/healthy-payee.near/).waitFor();
      const before = state.gatewayReads;
      state.denied = true;
      await page.clock.fastForward(31000); await page.clock.runFor(100);
      await page.getByText(/private-payee.near/).waitFor({ state: 'hidden' });
      assert.equal(await page.getByText(/healthy-payee.near/).isVisible(), true, 'a denied agent must not hide a healthy agent');
      await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: /payables/ }).waitFor({ state: 'hidden' });
      assert.ok(state.gatewayReads > before, 'denial rechecks cached gateway permissions');
      for (const request of state.waiting.splice(0)) await request.fulfill({ json: gateway() });
      await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: /payables/ }).waitFor({ state: 'hidden' });
      assert.deepEqual(state.errors, []);
      await page.close(); console.log('PASS Home clears denied-agent terms before metadata returns and keeps healthy-agent observations');
    }
    for (const status of [401, 403]) {
      const { page, state, gateway } = await open('/a/payables/policy');
      await page.getByText(/private-payee.near/).waitFor();
      state.status = status; state.denied = true;
      await page.clock.fastForward(31000); await page.clock.runFor(100);
      await page.getByText(/private-payee.near/).waitFor({ state: 'hidden' });
      assert.equal(await page.getByRole('heading', { name: 'Allowed actions', exact: true }).count(), 0);
      state.denied = false;
      for (const request of state.waiting.splice(0)) await request.fulfill({ json: gateway() });
      await page.getByRole('button', { name: 'Check access again', exact: true }).click();
      await page.getByText(/private-payee.near/).waitFor();
      assert.deepEqual(state.errors, []);
      await page.close(); console.log(`PASS agent policy hides private state during HTTP${status} permission refresh`);
    }
    {
      const { page, state } = await open('/');
      await page.getByText(/private-payee.near/).waitFor();
      await page.getByText(/healthy-payee.near/).waitFor();
      state.denied = true;
      await page.clock.fastForward(31000); await page.clock.runFor(100);
      await page.getByText(/private-payee.near/).waitFor({ state: 'hidden' });
      for (const request of state.waiting.splice(0)) await request.fulfill({ status: 503, json: { error: 'Gateway permission refresh unavailable' } });
      await page.getByText(/Workspace permissions could not be refreshed/).waitFor();
      assert.equal(await page.getByText(/healthy-payee.near/).isVisible(), true);
      assert.equal(await page.getByText(/private-payee.near/).count(), 0);
      assert.deepEqual(state.errors, []);
      await page.close(); console.log('PASS failed permission refresh retains healthy-agent views without restoring denied records');
    }
    {
      const { page, state } = await open('/');
      await page.getByText(/private-payee.near/).waitFor();
      state.unavailable = true;
      await page.clock.fastForward(31000); await page.clock.runFor(100);
      await page.getByText(/checks are incomplete/).waitFor();
      assert.equal(await page.getByText(/private-payee.near/).isVisible(), true, 'transient outages retain explicitly stale observations');
      assert.deepEqual(state.errors, []);
      await page.close(); console.log('PASS transient provider failure retains labelled observations');
    }
    {
      const { page, state, proposals } = await open('/', { dao: true, sharedDao: true });
      await page.getByText('What the signature authorizes', { exact: true }).first().waitFor();
      for (const disclosure of await page.getByText('What the signature authorizes', { exact: true }).all()) await disclosure.click();
      await page.getByText(/payables-private-proposal\.near/).waitFor();
      await page.getByText(/healthy-private-proposal\.near/).waitFor();
      state.holdProposals = true;
      await page.clock.fastForward(15001); await page.clock.runFor(100);
      assert.equal(state.waitingProposals.length, 1, 'hold a proposal read that started before access changed');
      state.denied = true;
      await page.clock.fastForward(15000); await page.clock.runFor(100);
      await page.getByText(/private-payee.near/).waitFor({ state: 'hidden' });
      assert.equal(await page.getByText(/payables-private-proposal/).count(), 0, 'cached private proposal payload must disappear with the denied agent');
      assert.equal(await page.getByText(/healthy-private-proposal\.near/).isVisible(), true);
      for (const request of state.waitingProposals.splice(0)) await request.fulfill({ json: proposals('-late') });
      await page.getByText(/healthy-private-proposal-late\.near/).waitFor();
      assert.equal(await page.getByText(/payables-private-proposal/).count(), 0, 'a late successful proposal read must not restore denied payloads');
      for (const request of state.waiting.splice(0)) await request.fulfill({ status: 503, json: { error: 'Gateway permission refresh unavailable' } });
      await page.getByText(/Workspace permissions could not be refreshed/).waitFor();
      assert.equal(await page.getByText(/healthy-private-proposal-late\.near/).isVisible(), true);
      assert.equal(await page.getByText(/payables-private-proposal/).count(), 0);
      assert.deepEqual(state.errors, []);
      await page.close(); console.log('PASS shared-DAO proposals remove only denied-agent payloads, including cached and late results');
    }
    {
      const { page, state } = await open('/', { dao: true });
      await page.getByText('Private proposal description', { exact: true }).waitFor();
      const before = state.gatewayReads;
      state.procedureDenied = true;
      await page.clock.fastForward(15001); await page.clock.runFor(500);
      await page.getByText('Proposal access denied', { exact: true }).waitFor();
      assert.equal(await page.getByText('Private proposal description', { exact: true }).count(), 0);
      assert.equal(state.proposalDenials, 1, 'a proposal denial must not retry or invalidate itself');
      assert.ok(state.gatewayReads > before, 'proposal denial refreshes capability metadata');
      assert.equal(await page.getByText(/healthy-payee.near/).isVisible(), true);
      assert.deepEqual(state.errors, []);
      await page.close(); console.log('PASS gateway procedure denial redacts cached proposals promptly without a refetch loop');
    }
    {
      const { page, state } = await open('/#activity', { dao: true, sharedDao: true, activityHistory: true });
      const filters = page.getByRole('region', { name: 'History filters', exact: true });
      await filters.getByText('5 of 5 returned records shown', { exact: true }).waitFor();
      await page.getByLabel('Area', { exact: true }).selectOption('payables');
      await filters.getByText('4 of 4 returned records shown', { exact: true }).waitFor();
      await page.getByText('Private proposal description', { exact: true }).waitFor();
      assert.match(await page.locator('body').textContent(), /payables-private-proposal\.near/);
      assert.match(await page.locator('body').textContent(), /healthy-private-proposal\.near/, 'selecting one area retains its owner DAO’s accessible proposals');
      await filters.getByText('More filters', { exact: true }).click();
      const statuses = page.getByLabel('Recorded status', { exact: true });
      assert.equal(await statuses.locator('option[value="proposal:InProgress"]').count(), 1);
      await page.getByLabel('Search history', { exact: true }).fill('Private proposal description');
      await filters.getByText('1 of 4 returned records shown', { exact: true }).waitFor();
      const before = state.gatewayReads;
      state.procedureDenied = true;
      await page.clock.fastForward(15001); await page.clock.runFor(500);
      await page.getByText('Proposal access denied', { exact: true }).waitFor();
      await filters.getByText('0 of 1 returned records shown · Checks incomplete', { exact: true }).waitFor();
      // Clear the search before inspecting DOM text so the search input itself is not confused with a cached record.
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      await filters.getByText('2 of 2 returned records shown · Checks incomplete', { exact: true }).waitFor();
      assert.doesNotMatch(await page.locator('body').textContent(), /Private proposal description|(?:payables|healthy)-private-proposal\.near|(?:payables|healthy)-hash/, 'denied proposal descriptions and signature payloads leave the DOM, including closed disclosures');
      assert.equal(await statuses.locator('option[value^="proposal:"]').count(), 0, 'denied records cannot contribute status options');
      assert.equal(await page.getByRole('heading', { name: 'DAO proposals', exact: true }).count(), 0);
      await page.locator('#payables-operation-payables-retained-operation').waitFor();
      await page.locator('#healthy-operation-healthy-retained-operation').waitFor();
      assert.equal(state.proposalDenials, 1, 'a proposal denial must not retry or invalidate itself');
      assert.ok(state.gatewayReads > before);
      assert.deepEqual(state.errors, []);
      await page.close(); console.log('PASS Activity proposal denial clears cached payloads, search counts and status options while preserving agent history');
    }
    {
      const { page, state } = await open('/#activity', { dao: true, activityHistory: true, initialProposalDenial: true });
      await page.getByText('Proposal access denied', { exact: true }).waitFor();
      await page.getByRole('region', { name: 'History filters', exact: true }).getByText('2 of 2 returned records shown · Checks incomplete', { exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'DAO proposals', exact: true }).count(), 0, 'a failed first proposal read must not leave an empty section with a permanent loading spinner');
      assert.equal(await page.getByText('Checking proposals · owner.near…', { exact: true }).count(), 0, 'the failed read is no longer reported as loading');
      assert.equal(state.proposalDenials, 1);
      assert.deepEqual(state.errors, []);
      await page.close(); console.log('PASS first Activity proposal-read denial shows the error without an indefinite proposal loading state');
    }
    {
      const { page, state } = await open('/a/payables/follow/payment?payment=payables-payment', { dao: true, payment: true });
      await page.getByText('Payment history and public visibility', { exact: true }).click();
      await page.getByText('Proposal #42: voting, 0 votes so far.', { exact: true }).waitFor();
      state.procedureDenied = true;
      await page.clock.fastForward(10001); await page.clock.runFor(500);
      await page.getByText('Proposal access denied', { exact: true }).waitFor();
      await page.getByText(/Proposal #42/).first().waitFor({ state: 'hidden' });
      assert.equal(await page.getByText(/Proposal #42/).count(), 0);
      assert.equal(await page.getByText(/private-payee.near/).first().isVisible(), true, 'permitted payment evidence remains available');
      assert.equal(state.proposalDenials, 1);
      assert.deepEqual(state.errors, []);
      await page.close(); console.log('PASS denied proposal records disappear from the payment timeline without hiding permitted payment evidence');
    }
    {
      const { page, state } = await open('/a/payables/funding');
      const deposit = page.getByRole('button', { name: 'Get a deposit address', exact: true });
      await deposit.waitFor();
      const held = page.getByRole('list', { name: 'Held payout records', exact: true });
      await held.getByText(/private-payee.near/).waitFor();
      await page.getByText('Link a treasury account', { exact: true }).click();
      const link = page.getByRole('button', { name: 'Link', exact: true });
      assert.equal(await link.isEnabled(), true);
      state.procedureDenied = true;
      state.gatewayUnavailable = true;
      await deposit.click();
      const retry = page.getByRole('button', { name: 'Retry permissions', exact: true });
      await retry.waitFor();
      await page.getByText('This account does not have permission for this action', { exact: true }).waitFor();
      assert.equal(await held.getByText(/private-payee.near/).isVisible(), true, 'failed permission metadata does not revoke admitted private reads');
      assert.equal(await deposit.isDisabled(), true, 'a denied action cannot reuse stale preparation permission after metadata refresh fails');
      assert.equal(await link.isDisabled(), true, 'stale management permission cannot remain actionable');
      state.permissions = { canSign: false, canPropose: true, canVote: false, canExecute: false, canManage: false };
      state.gatewayUnavailable = false;
      state.procedureDenied = false;
      const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/gw/me');
      await retry.click();
      await refreshed;
      await retry.waitFor({ state: 'hidden' });
      assert.equal(await deposit.isEnabled(), true, 'successful retry restores the newly observed preparation permission');
      assert.equal(await link.isDisabled(), true, 'successful retry must not restore the previous management permission');
      assert.equal(await held.getByText(/private-payee.near/).isVisible(), true);
      assert.equal(state.calls.filter(([, method]) => method === 'deposit').length, 1, 'permission recovery does not retry the denied action');
      assert.ok(!state.calls.some(([, method]) => ['treasury/link', 'pay', 'owner/prepare', 'owner/submit'].includes(method)));
      assert.deepEqual(state.errors, []);
      await page.close(); console.log('PASS failed capability refresh disables mutations, retains reads, and restores only newly observed permissions');
    }
    for (const encodedProcedure of [false, true]) {
      const { page, state } = await open('/a/payables/funding', { encodedProcedure });
      await page.getByRole('button', { name: 'Get a deposit address', exact: true }).waitFor();
      const before = state.gatewayReads;
      state.procedureDenied = true;
      await page.getByRole('button', { name: 'Get a deposit address', exact: true }).click();
      await page.getByText('This account does not have permission for this action', { exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'Access unavailable', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Get a deposit address', exact: true }).isVisible(), true);
      if (!encodedProcedure) assert.ok(state.gatewayReads > before, 'procedure denial refreshes capability metadata without removing permitted reads');
      assert.deepEqual(state.errors, []);
      await page.close(); console.log(`PASS ${encodedProcedure ? 'encoded RPC' : 'gateway procedure-only'} denial preserves authorized agent reads`);
    }
  } finally { await browser.close(); }
});
