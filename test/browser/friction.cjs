const { rpcAnswer, rpcBody } = require('./fixtures/rpc.cjs');
const { runSuite } = require('./fixtures/task.cjs');
/** Offline regressions: all requests are fulfilled locally or aborted; no executor runs.
 * PLAYWRIGHT_MODULE=/path/to/playwright-core BROWSER_EXECUTABLE=/path/to/chrome
 * node test/browser/friction.cjs /path/to/frontend-build
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('./fixtures/browser.cjs');
const root = path.resolve(process.argv[2] || 'web/dist');
const results = [];

runSuite(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    for (const draft of ['2', '120', 'copy-success', 'copy-failure', 'grant_missing', 'duplicate_held_payout', 'single-asset', 'topup']) {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      page.setDefaultTimeout(5000);
      const copying = draft.startsWith('copy-');
      const refusal = draft === 'grant_missing' || draft === 'duplicate_held_payout';
      if (copying) await page.addInitScript(fail => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          writeText: async text => {
            if (fail) throw new Error('Clipboard denied by fixture');
            window.copiedText = text;
          },
        } });
      }, draft === 'copy-failure');
      let settings = { on: true, everyMin: 60, maxUsd: 10, lastRun: null, nextRun: null };
      const writes = [];
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'frontend.test') return route.abort();
        const p = url.pathname;
        if (p === '/gw/me') return route.fulfill({ json: { agents: draft === 'topup' ? [{ name: 'treasury', owner: 'owner.near', dao: false }, { name: 'payables', owner: 'owner.near', dao: false }] : [], invoices: null, viewer: { account: 'owner.near', access: { treasury: { canSign: true, canPropose: true, canVote: true, canExecute: true, canManage: true }, payables: { canSign: true, canPropose: true, canVote: true, canExecute: true, canManage: true } } } } });
        if (p.includes('/rpc/')) {
          const method = p.split('/rpc/')[1];
          if (method === 'autopilot/stop') {
            writes.push({ method }); settings.on = false;
            return route.fulfill({ json: rpcAnswer(method, { on: false }) });
          }
          const values = {
            get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup: { executor: true, agentId: 'fixture', wallet: 'agent.near', owner: { type: 'near', account_id: 'owner.near', public_key: 'ed25519:fixture' }, grant: { id: 'grant-fixture', label: 'treasury', expiresAt: '2030-01-01T00:00:00Z' }, dao: null },
            overview: { agentId: 'fixture', digest: 'sha256:' + 'a'.repeat(64), notInForce: null, agreed: [], unmanaged: [], target: { usdc: 1 }, rebalance: { minLegUsd: 1, maxCostBps: 100 }, book: [{ asset: 'usdc', symbol: 'USDC', decimals: 6, public: 0n, confidential: 10000000n, usd: 10, price: 1, priceUpdatedAt: null, priceExpiresAt: null }], policy: { status: 'APPLIED', revision: 1, policy: { actions: ['swap'], owner_approval: false, frozen: false, destinations: { mode: 'only', list: [{ action: 'transfer', address: 'payee.near', confidential: true }] }, assets: 'any', budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, limits: {}, confidential: false, max_actions_per_hour: 10, timelock_ms: 0 }, usage: { budget: { daily: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, weekly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, monthly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null } }, timelock: { delay_ms: 0, scheduled_count: 0 } }, cooldowns: { policy_change_available_at: null, unfreeze_available_at: null }, wallet_id: 'agent.near', provider_policy_synced: true }, grants: [] },
            'treasury/get': null, held: [], unresolved: copying ? [{ key: 'fixture-operation', at: new Date().toISOString(), kind: 'swap', sent: true, status: 'PROCESSING', request: {} }] : [], 'inbox/list': [], 'agreements/list': [], activity: [], 'owner/pending': [], 'owner/actions': [], paymentHistory: { items: [], complete: true }, 'autopilot/get': settings, 'autopilot/evidence': { ticks: [], corrupt: [] }, 'strategy/get': { strategy: { targetBps: { usdc: 10000 }, minLegUsd: 1, maxCostBps: 100, autopilot: { everyMin: 60, maxUsd: 10 } }, digest: 'fixture', executor: true, grantMatches: true, readiness: { state: 'ready', canEnable: true, reasons: [] }, observedAt: '2026-10-15T12:00:00Z', grantSuffix: 'fixture', on: false, unresolved: 0, grant: null }, invoices: [],
            ...(refusal || draft === 'topup' ? { pay: { outcome: 'refused', code: draft === 'topup' ? 'grant_missing' : draft } } : {}),
          };
          if (draft === 'topup' && method === 'overview') {
            values.overview.policy.policy.actions = p.includes('/payables/') ? ['transfer'] : ['swap'];
            values.overview.policy.policy.destinations.list.push({ action: 'transfer', address: 'agent.near', confidential: true });
          }
          if (!(method in values)) return route.fulfill({ status: 400, json: { error: 'Unexpected fixture request' } });
          return route.fulfill({ json: rpcBody(values, method) });
        }
        if (p.startsWith('/static/')) return route.fulfill({ path: root + p, contentType: p.endsWith('.js') ? 'application/javascript' : p.endsWith('.css') ? 'text/css' : 'font/woff2' });
        return route.fulfill({ path: path.join(root, 'index.html'), contentType: 'text/html' });
      });
      try {
        await page.goto(draft === 'topup' ? 'http://frontend.test/a/payables/' : `http://frontend.test/a/treasury/${copying ? 'activity' : refusal || draft === 'single-asset' ? 'funding' : 'automations'}`);
        if (refusal || draft === 'single-asset') await page.getByText('Send money to a payee', { exact: true }).click();
        if (draft === 'topup') {
          await page.getByText('Funding and budget details', { exact: true }).click();
          await page.getByLabel('USDC to send', { exact: true }).fill('1');
          await page.getByRole('button', { name: 'Top up from the treasury', exact: true }).click();
          await page.getByRole('dialog').getByRole('button', { name: 'Send payment', exact: true }).click();
          const next = page.getByRole('link', { name: 'Review the grant', exact: true });
          await next.waitFor();
          assert.equal(await next.getAttribute('href'), '/a/treasury/policy#grants', 'Top-up feedback must refer to its treasury agent, not the current Payables agent');
          results.push({ test: 'top-up refusal targets the treasury agent', pass: true });
          continue;
        }
        if (draft === 'single-asset') {
          await page.getByLabel('Recipient’s NEAR account', { exact: true }).waitFor();
          assert.equal(await page.locator('select[name=asset]').count(), 0, 'One available asset needs no selector');
          assert.equal(await page.getByRole('button', { name: 'payee.near', exact: true }).count(), 0, 'Recipient input already offers the payee');
          assert.equal(await page.locator('datalist option[value="payee.near"]').count(), 1);
          results.push({ test: 'single asset and one recipient picker', pass: true });
          continue;
        }
        if (refusal) {
          await page.getByLabel('Recipient’s NEAR account', { exact: true }).fill('payee.near');
          await page.getByLabel('Amount', { exact: true }).fill('1');
          await page.getByRole('button', { name: 'Review payment', exact: true }).click();
          await page.getByRole('dialog').getByRole('button', { name: 'Send payment', exact: true }).click();
          const next = page.getByRole('link', { name: draft === 'grant_missing' ? 'Review the grant' : 'Review the existing held payout', exact: true });
          await next.waitFor();
          assert.equal(await next.getAttribute('href'), draft === 'grant_missing' ? '/a/treasury/policy#grants' : '/a/treasury/');
          const details = page.getByText('Refusal code', { exact: true });
          await details.focus(); await page.keyboard.press('Space');
          await page.getByText(draft, { exact: true }).waitFor();
          results.push({ test: `${draft}: actionable link and accessible code`, pass: true });
          continue;
        }
        if (copying) {
          await page.getByRole('button', { name: 'Copy', exact: true }).first().click();
          if (draft === 'copy-success') {
            await page.getByRole('status').filter({ hasText: /Copied/ }).waitFor();
            assert.match(await page.evaluate(() => window.copiedText), /fixture-operation/);
          } else {
            await page.getByRole('status').filter({ hasText: /Could not copy|Copy failed/ }).waitFor();
            assert.equal(await page.getByRole('button', { name: 'Copy', exact: true }).first().isEnabled(), true);
          }
          results.push({ test: draft, pass: true });
          continue;
        }
        await page.getByRole('button', { name: 'Edit strategy', exact: true }).click();
        await page.getByLabel('Run every (minutes)', { exact: true }).fill(draft);
        const stopResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/rpc/autopilot/stop'));
        await page.getByRole('button', { name: 'Turn off', exact: true }).click();
        await stopResponse;
        assert.deepEqual(writes, [{ method: 'autopilot/stop' }], 'Stopping must use saved settings, never an unfinished draft');
        assert.equal(settings.on, false);
        assert.equal(settings.everyMin, 60);
        results.push({ test: `Turn off with ${draft === '2' ? 'invalid' : 'valid unsaved'} interval`, pass: true });
      } catch (error) {
        results.push({ test: copying || refusal || draft === 'single-asset' || draft === 'topup' ? draft : `Turn off with draft ${draft}`, pass: false, error: error.message });
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = results.every(result => result.pass) ? 0 : 1;
});
