/** Shared-DAO proposal payloads follow each agent's access, including late successful reads. */
const assert = require('node:assert/strict');
const { runSuite } = require('./fixtures/task.cjs');
const path = require('node:path');
const { chromium } = require('./fixtures/browser.cjs');
const { rpcBody } = require('./fixtures/rpc.cjs');
const root = path.resolve(process.argv[2] || 'web/dist');

runSuite(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(5000); await page.clock.install();
    let denied = false, holdProposals = false;
    const waitingProposals = [], waitingGateway = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const proposals = suffix => ['payables', 'healthy'].map((agent, index) => ({
      id: 42 + index, what: 'agent', agent, type: 'policy_update', correlationId: `${agent}-policy`,
      state: 'waiting', expiresAt: '2099-01-01T00:00:00Z', status: 'InProgress', proposer: 'owner.near', votes: {},
      hash: `${agent}-hash`, submittedAt: '2026-10-01T00:00:00Z', description: '',
      check: { kind: 'verified', standard: 'nep413', message: { payee: `${agent}-private-proposal${suffix}.near` } },
    }));
    await page.route('**/*', async route => {
      const { hostname, pathname: p } = new URL(route.request().url());
      if (hostname !== 'frontend.test') return route.abort();
      if (p === '/gw/me') {
        if (denied) { waitingGateway.push(route); return; }
        return route.fulfill({ json: { agents: ['payables', 'healthy'].map(name => ({ name, owner: 'owner.near', dao: true, area: 'payables' })),
          invoices: null, viewer: { account: 'owner.near', access: Object.fromEntries(['payables', 'healthy'].map(name => [name,
            { canSign: false, canPropose: false, canVote: false, canExecute: true, canManage: true }])) } } });
      }
      if (p === '/gw/proposals') {
        if (holdProposals) { waitingProposals.push(route); return; }
        return route.fulfill({ json: proposals('') });
      }
      if (p.includes('/rpc/')) {
        const agent = p.split('/')[2], method = p.split('/rpc/')[1];
        if (denied && agent === 'payables') return route.fulfill({ status: 403, json: { error: 'Access denied', access: 'agent' } });
        const payee = `${agent}-payment-payee.near`;
        const values = {
          instance: { agentId: agent, executor: true },
          setup: { agentId: agent, executor: true, wallet: `${agent}.near`, owner: { type: 'near', account_id: 'owner.near', public_key: 'ed25519:fixture' }, grant: null, dao: null },
          overview: { agentId: agent, area: 'payables', digest: 'fixture', notInForce: null, agreed: [payee], unmanaged: [], target: {},
            rebalance: { minLegUsd: 1, maxCostBps: 100 }, book: [], grants: [],
            policy: { revision: 1, status: 'APPLIED', policy: { actions: ['transfer'], assets: 'any', budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, owner_approval: true, confidential: true,
              destinations: { mode: 'only', list: [{ action: 'transfer', address: payee, confidential: true }] }, frozen: false, limits: {}, max_actions_per_hour: 10, timelock_ms: 0 }, wallet_id: 'agent.near', provider_policy_synced: true, cooldowns: { policy_change_available_at: null, unfreeze_available_at: null }, usage: { budget: { daily: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, weekly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, monthly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null } }, timelock: { delay_ms: 0, scheduled_count: 0 } } } },
          'treasury/get': null, 'autopilot/get': { on: false, everyMin: 60, maxUsd: 0, lastRun: null, nextRun: null },
          held: [{ correlationId: `${agent}-payment`, at: new Date().toISOString(), request: { recipient: payee, asset: 'usdc', amount: '1000000' }, kind: 'payout', approvalId: 'fixture-approval' }],
          unresolved: [], 'inbox/list': [], 'agreements/list': [], 'owner/actions': [], 'owner/pending': [], policyHistory: [],
        };
        return route.fulfill({ json: rpcBody(values, method) });
      }
      if (p.startsWith('/static/')) return route.fulfill({ path: root + p,
        contentType: p.endsWith('.js') ? 'application/javascript' : p.endsWith('.css') ? 'text/css' : 'font/woff2' });
      return route.fulfill({ path: root + '/index.html', contentType: 'text/html' });
    });
    await page.goto('http://frontend.test/');
    const disclosures = page.getByText('What the signature authorizes', { exact: true });
    await disclosures.nth(1).waitFor();
    for (const disclosure of await disclosures.all()) await disclosure.click();
    await page.getByText(/payables-private-proposal\.near/).waitFor();
    await page.getByText(/healthy-private-proposal\.near/).waitFor();
    holdProposals = true;
    await page.clock.fastForward(15001); await page.clock.runFor(100);
    assert.equal(waitingProposals.length, 1, 'hold the proposal read that began before denial');
    denied = true;
    await page.clock.fastForward(15000); await page.clock.runFor(100);
    await page.getByText(/payables-payment-payee\.near/).waitFor({ state: 'hidden' });
    assert.equal(await page.getByText(/payables-private-proposal/).count(), 0, 'cached denied-agent payload is removed');
    assert.equal(await page.getByText(/healthy-private-proposal\.near/).isVisible(), true);
    for (const request of waitingProposals.splice(0)) await request.fulfill({ json: proposals('-late') });
    await page.getByText(/healthy-private-proposal-late\.near/).waitFor();
    assert.equal(await page.getByText(/payables-private-proposal/).count(), 0, 'a late successful read cannot restore denied payloads');
    for (const request of waitingGateway.splice(0)) await request.fulfill({ status: 503, json: { error: 'Gateway permission refresh unavailable' } });
    await page.getByText(/Workspace permissions could not be refreshed/).waitFor();
    assert.equal(await page.getByText(/healthy-private-proposal-late\.near/).isVisible(), true);
    assert.equal(await page.getByText(/payables-private-proposal/).count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
    console.log('PASS shared-DAO proposals redact cached and late denied-agent payloads while preserving healthy-agent evidence');
  } finally { await browser.close(); }
});
