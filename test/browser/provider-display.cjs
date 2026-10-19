const { rpcBody } = require('./fixtures/rpc.cjs');
const { runSuite } = require('./fixtures/task.cjs');
/** Offline only: every application request is a fixture; no executor or wallet is started. */
const assert = require('node:assert/strict');
const { chromium } = require('./fixtures/browser.cjs');
const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const root = require('node:path').resolve(process.argv[2] || 'web/dist');
runSuite(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    for (const scenario of ['fresh-then-stale', 'no-price', 'budget', 'budget-error', 'evidence', 'missing-evidence']) {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      page.setDefaultTimeout(8000);
      const now = Date.now(), at = new Date(now - 60_000).toISOString(), expires = new Date(now + 60_000).toISOString();
      await page.clock.install({ time: now });
      const writes = [];
      const payment = scenario.includes('evidence');
      const budget = scenario.startsWith('budget');
      const details = { budgetRemainingUsd: '0.000001', availableAt: '2030-01-01T00:00:00Z' };
      const evidence = { txHash: 'source-hash', destinationTxHash: 'destination-hash', refundTxHash: 'refund-hash', refundTo: 'agent.near', refundedAmount: '12345678901234567890' };
      await page.route('**/*', async route => {
        const u = new URL(route.request().url()), p = u.pathname;
        if (u.hostname !== 'frontend.test') return route.abort();
        if (p === '/gw/me') return route.fulfill({ json: { agents: [{ name: 'fixture', owner: 'owner.near', dao: false }], invoices: null,
          viewer: { account: 'owner.near', access: { fixture: { canSign: true, canPropose: true, canVote: true, canExecute: true, canManage: true } } } } });
        if (p.includes('/rpc/')) {
          const method = p.split('/rpc/')[1];
          if (['pay', 'owner/prepare', 'owner/submit'].includes(method)) writes.push(method);
          if (method === 'pay' && scenario === 'budget-error') return route.fulfill({ status: 400, json: { json: { defined: false, code: 'BAD_REQUEST', message: 'Budget exceeded', data: { kind: 'provider', code: 'spend_budget_exceeded', ...details } } } });
          const values = {
            get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup: { executor: true, agentId: 'fixture', wallet: 'agent.near', owner: { type: 'near', account_id: 'owner.near', public_key: 'ed25519:fixture' }, grant: { id: 'live', label: 'payout', expiresAt: '2099-01-01T00:00:00Z' }, dao: null },
            overview: { agentId: 'fixture', digest: 'sha256:' + 'a'.repeat(64), notInForce: null, agreed: ['payee.near'], grants: [], unmanaged: [], target: { [USDC]: 1 }, rebalance: { minLegUsd: 1, maxCostBps: 100 },
              book: [...(budget ? [{ asset: 'nep141:wrap.near', symbol: 'wNEAR', decimals: 24, public: 0n, confidential: 0n, price: 1, usd: 0, priceUpdatedAt: null, priceExpiresAt: null }] : []), { asset: USDC, symbol: 'USDC', decimals: 6, public: 0n, confidential: 10000000n, price: scenario === 'no-price' ? null : 1, usd: scenario === 'no-price' ? null : 10, priceUpdatedAt: at, priceExpiresAt: expires }],
              policy: { status: 'APPLIED', revision: 1, policy: { actions: payment ? ['transfer'] : ['swap', 'transfer'], owner_approval: true, frozen: false, destinations: { mode: 'only', list: [{ action: 'transfer', address: 'payee.near', confidential: true }] }, assets: [USDC], budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, limits: {}, confidential: false, max_actions_per_hour: 10, timelock_ms: 0 }, usage: { budget: { daily: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, weekly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, monthly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null } }, timelock: { delay_ms: 0, scheduled_count: 0 } }, cooldowns: { policy_change_available_at: null, unfreeze_available_at: null }, wallet_id: 'agent.near', provider_policy_synced: true } },
            'treasury/get': null, held: [], unresolved: [], 'inbox/list': [], 'agreements/list': [], activity: [], 'owner/pending': [], 'owner/actions': [],
            paymentHistory: { items: payment ? [{ correlationId: 'payment', at }] : [], complete: true },
            paymentStatus: { status: 'REFUNDED', failureCode: null, createdAt: at, updatedAt: at, request: { asset: USDC, recipient: 'payee.near', amount: '1000000', confidential: true }, approvalId: null, expiresAt: null, detailError: null,
              evidence: scenario === 'evidence' ? evidence : { txHash: null, destinationTxHash: null, refundTxHash: null, refundTo: null, refundedAmount: null } },
            'autopilot/get': { on: false, everyMin: 60, maxUsd: 10, lastRun: null, nextRun: null }, 'autopilot/evidence': { ticks: [], corrupt: [] }, 'strategy/get': {}, invoices: [],
            pay: { outcome: 'refused', code: 'spend_budget_exceeded', details },
          };
          return route.fulfill({ json: rpcBody(values, method) });
        }
        if (p.startsWith('/static/')) return route.fulfill({ path: root + p, contentType: p.endsWith('.js') ? 'application/javascript' : p.endsWith('.css') ? 'text/css' : 'font/woff2' });
        return route.fulfill({ path: root + '/index.html', contentType: 'text/html' });
      });
      await page.goto('http://frontend.test/a/fixture/' + (payment ? 'follow/payment?payment=payment' : budget ? 'funding' : ''));
      if (budget) {
        await page.getByText('Send money to a payee', { exact: true }).click();
        await page.getByLabel('Recipient’s NEAR account', { exact: true }).fill('payee.near');
        await page.getByLabel('Amount', { exact: true }).fill('1');
        await page.getByRole('button', { name: 'Review payment', exact: true }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Send payment', exact: true }).click();
        await page.getByText(/Provider-reported budget remaining: 0\.000001 USD/).waitFor();
        assert.doesNotMatch(await page.locator('body').innerText(), /Try again at/);
        assert.deepEqual(writes, ['pay']);
      } else if (payment) {
        await page.getByText('Provider evidence', { exact: true }).click();
        const section = page.getByRole('region', { name: 'Provider-reported payment evidence' });
        await section.waitFor();
        await page.getByText('Provider reported refunded', { exact: true }).first().waitFor();
        if (scenario === 'evidence') await section.getByText(evidence.txHash, { exact: true }).waitFor();
        const text = await section.innerText();
        if (scenario === 'evidence') for (const value of Object.values(evidence)) assert.ok(text.includes(value));
        else assert.equal((text.match(/Not provided/g) || []).length, 5);
        assert.match(text, /not independently verified settlement/);
        assert.match(text, /asset not established here/);
        assert.deepEqual(writes, []);
      } else {
        await page.getByText('Allocation', { exact: true }).waitFor();
        if (scenario === 'fresh-then-stale') {
          await page.getByText('Fresh price', { exact: false }).waitFor();
          await page.clock.fastForward(61_000);
          await page.getByText('Stale price', { exact: false }).waitFor();
        }
        await page.getByText('Unavailable', { exact: true }).waitFor();
        await page.getByText('10 USDC', { exact: true }).waitFor();
        assert.doesNotMatch(await page.locator('body').innerText(), /The book is empty/);
        assert.deepEqual(writes, []);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      console.log(`${scenario}: passed`);
      await page.close();
    }
  } finally { await browser.close(); }
});
