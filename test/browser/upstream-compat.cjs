const { rpcBody } = require('./fixtures/rpc.cjs');
const { runSuite } = require('./fixtures/task.cjs');
/** Offline only: all requests are fulfilled by fixtures or aborted. */
const assert = require('node:assert/strict');
const { chromium } = require('./fixtures/browser.cjs');
const root = require('node:path').resolve(process.argv[2] || 'web/dist');

runSuite(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    for (const scenario of ['recipient', 'public-recipient', 'grants', 'ended-grants']) {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      page.setDefaultTimeout(8000);
      const writes = [];
      const at = '2020-01-01T00:00:00Z', future = '2099-01-01T00:00:00Z';
      const grants = [
        { grant_id: 'expired', label: 'expired-history', issued_at: at, expires_at: at, revoked_at: null, agent_id: 'fixture', wallet_id: 'agent.near', owner_epoch: 1, owner_message: {} },
        { grant_id: 'revoked', label: 'revoked-history', issued_at: at, expires_at: future, revoked_at: at, agent_id: 'fixture', wallet_id: 'agent.near', owner_epoch: 1, owner_message: {} },
        ...(scenario === 'ended-grants' ? [] : [{ grant_id: 'live', label: 'live-access', issued_at: at, expires_at: future, revoked_at: null, agent_id: 'fixture', wallet_id: 'agent.near', owner_epoch: 1, owner_message: {} }]),
      ];
      await page.route('**/*', async route => {
        const u = new URL(route.request().url()), p = u.pathname;
        if (u.hostname !== 'frontend.test') return route.abort();
        if (p === '/gw/me') return route.fulfill({ json: { agents: [{ name: 'treasury', owner: 'owner.near', dao: false }], invoices: null,
          viewer: { account: 'owner.near', access: { treasury: { canSign: true, canPropose: true, canVote: true, canExecute: true, canManage: true } } } } });
        if (p.includes('/rpc/')) {
          const method = p.split('/rpc/')[1];
          if (['pay', 'owner/prepare', 'owner/submit', 'agreements/offer'].includes(method)) writes.push({ method, body: route.request().postDataJSON() });
          const values = {
            get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup: { executor: true, agentId: 'fixture', wallet: 'agent.near', owner: { type: 'near', account_id: 'owner.near', public_key: 'ed25519:fixture' },
              grant: scenario === 'ended-grants' ? null : { id: 'live', label: 'live-access', expiresAt: future }, dao: null },
            overview: { agentId: 'fixture', digest: 'sha256:' + 'a'.repeat(64), notInForce: null, agreed: ['payee.near'], grants,
              unmanaged: [], target: { usdc: 1 }, rebalance: { minLegUsd: 1, maxCostBps: 100 },
              book: [{ asset: 'usdc', symbol: 'USDC', decimals: 6, public: 0n, confidential: 10000000n, usd: 10, price: 1, priceUpdatedAt: null, priceExpiresAt: null }],
              policy: { status: 'APPLIED', revision: 1, policy: { actions: ['swap', 'transfer'], owner_approval: true, frozen: false,
                destinations: { mode: 'only', list: [{ action: 'transfer', address: 'payee.near', confidential: scenario !== 'public-recipient' }] },
                assets: ['usdc'], budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, limits: {}, confidential: false, max_actions_per_hour: 10, timelock_ms: 0 }, usage: { budget: { daily: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, weekly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, monthly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null } }, timelock: { delay_ms: 0, scheduled_count: 0 } }, cooldowns: { policy_change_available_at: null, unfreeze_available_at: null }, wallet_id: 'agent.near', provider_policy_synced: true } },
            'treasury/get': null, held: [], unresolved: [], 'inbox/list': [], 'agreements/list': [], activity: [],
            'owner/pending': [], 'owner/actions': [], policyHistory: [], paymentHistory: { items: [], complete: true },
            'autopilot/get': { on: false, everyMin: 60, maxUsd: 10, lastRun: null, nextRun: null }, 'autopilot/evidence': { ticks: [], corrupt: [] }, 'strategy/get': {}, invoices: [],
            pay: { outcome: 'refused', code: 'duplicate_held_payout' },
          };
          return route.fulfill({ json: rpcBody(values, method) });
        }
        if (p.startsWith('/static/')) return route.fulfill({ path: root + p, contentType: p.endsWith('.js') ? 'application/javascript' : p.endsWith('.css') ? 'text/css' : 'font/woff2' });
        return route.fulfill({ path: root + '/index.html', contentType: 'text/html' });
      });
      if (scenario.includes('recipient')) {
        await page.goto('http://frontend.test/a/treasury/funding');
        await page.getByText('Send money to a payee', { exact: true }).click();
        await page.getByLabel('Recipient’s NEAR account', { exact: true }).fill('nearcom:Payee.near');
        await page.getByLabel('Amount', { exact: true }).fill('1');
        await page.getByRole('button', { name: 'Review payment', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        assert.match(await dialog.innerText(), /payee\.near/);
        assert.doesNotMatch(await dialog.innerText(), /nearcom:/);
        assert.match(await dialog.innerText(), scenario === 'public-recipient' ? /Public balance/ : /Confidential balance/);
        assert.doesNotMatch(await page.locator('body').innerText(), /policy doesn't list this account/);
        if (scenario === 'public-recipient') assert.match(await page.locator('body').innerText(), /legacy public balance/);
        assert.equal(writes.length, 0, 'Review must not send');
        await dialog.getByRole('button', { name: 'Send payment', exact: true }).click();
        await page.getByRole('link', { name: 'Review the existing held payout', exact: true }).waitFor();
        assert.equal(writes.length, 1);
        assert.equal(writes[0].body.json.recipient, 'payee.near');
        assert.equal(writes[0].body.json.confidential, scenario !== 'public-recipient');
      } else {
        await page.goto('http://frontend.test/a/treasury/policy');
        const grants = page.locator('#grants');
        await grants.waitFor();
        assert.equal(await page.getByText('expired-history', { exact: true }).isVisible(), false);
        await grants.getByText(/Ended grants \(/).click();
        await page.getByText('expired-history', { exact: true }).waitFor();
        await page.getByText('revoked-history', { exact: true }).waitFor();
        assert.match(await page.locator('body').innerText(), /Expired/);
        assert.match(await page.locator('body').innerText(), /Revoked/);
        if (scenario === 'ended-grants') {
          assert.match(await page.locator('body').innerText(), /No live grant/);
          assert.equal(await page.getByRole('list', { name: 'Live grants' }).count(), 0);
          assert.equal(await page.getByText('Current', { exact: true }).count(), 0);
        } else {
          const controls = page.getByRole('list', { name: 'Live grants' });
          assert.ok(await controls.getByRole('button').first().isVisible(), 'revocation does not require opening history');
          assert.doesNotMatch(await controls.innerText(), /expired-history|revoked-history/);
        }
        assert.equal(writes.length, 0);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      console.log(`${scenario}: passed`);
      await page.close();
    }
  } finally { await browser.close(); }
});
