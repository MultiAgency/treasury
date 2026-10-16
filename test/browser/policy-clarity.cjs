const { rpcValue } = require('./fixtures/rpc.cjs');
/** Offline policy presentation checks: no server, executor or signer is started. */
const assert = require('node:assert/strict');
const { chromium } = require('./fixtures/browser.cjs');
const root = require('node:path').resolve(process.argv[2] || 'web/dist');
(async () => {
 const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
 try {
  for (const scenario of ['round-trip', 'current', 'unsynchronized', 'unmatched-grant', 'approve-only', 'missing-evidence', 'history-error', 'history-denied', 'grant-link']) {
   const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
   page.setDefaultTimeout(6000);
   const calls = [], errors = [], proposed = [];
   let denyHistory = false;
   page.on('pageerror', e => errors.push(e.message));
   await page.route('**/*', async route => {
    const { hostname, pathname: p } = new URL(route.request().url());
    if (hostname !== 'frontend.test') return route.abort();
    if (p === '/gw/me') return route.fulfill({ json: { invoices: null, agents: [{ name: 'treasury', area: 'treasury', owner: 'owner.near', dao: false }], viewer: { account: 'owner.near', access: { treasury: { canSign: true, canPropose: true, canVote: true, canExecute: true, canManage: true } } } } });
    if (p.includes('/rpc/')) {
     const method = p.split('/rpc/')[1]; calls.push(method);
     if (denyHistory && method === 'policyHistory') return route.fulfill({ status: 403, json: { error: 'Access denied' } });
     if (scenario === 'round-trip' && method === 'owner/prepare') {
      proposed.push(route.request().postDataJSON().json.action);
      return route.fulfill({ status: 503, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Offline fixture stops before signing' } } });
     }
     if (scenario === 'history-error' && method === 'policyHistory') return route.fulfill({ status: 503, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Revision evidence unavailable' } } });
     const values = {
      instance: { agentId: 'fixture', area: 'treasury', executor: scenario !== 'approve-only' },
      setup: { agentId: 'fixture', executor: scenario !== 'approve-only', wallet: 'agent.near', owner: { type: 'near', account_id: 'owner.near' }, grant: { id: 'current', label: 'treasury:fixture', expiresAt: '2099-01-01T00:00:00Z' }, dao: { id: 'owner.sputnik-dao.near', owner: { account_id: 'owner.near' } } },
      overview: { agentId: 'fixture', area: 'treasury', digest: scenario === 'missing-evidence' ? null : 'fixture-digest', notInForce: scenario === 'missing-evidence' ? undefined : scenario === 'unsynchronized' ? 'revision 2 is not yet synchronized with the provider' : null, agreed: [], book: [], unmanaged: [], target: {}, rebalance: { minLegUsd: 1, maxCostBps: 100 },
       grants: [{ grant_id: scenario === 'unmatched-grant' ? 'different' : 'current', label: 'treasury:fixture', expires_at: '2099-01-01T00:00:00Z', issued_at: '2026-01-01T00:00:00Z', revoked_at: null }],
       policy: { status: 'APPLIED', revision: 2, policy: { actions: ['swap'], assets: 'any', budget: scenario === 'round-trip' ? { daily_usd: '25' } : {}, limits: scenario === 'round-trip' ? { daily: { 'unlisted-token': '123' } } : {}, frozen: false, owner_approval: false, confidential: true, destinations: { mode: 'only', list: [] } }, usage: { budget: {} }, cooldowns: {} } },
      'treasury/get': null, 'owner/pending': [], 'owner/actions': [], unresolved: [], held: [], 'inbox/list': [], 'autopilot/get': { on: false }, policyHistory: scenario === 'history-denied' ? [{ revision: 1, status: 'APPLIED', digest: 'private-historical-digest' }] : [],
     };
     assert.ok(method in values, `Unexpected RPC ${method}`);
     return route.fulfill({ json: { json: rpcValue(values, method) } });
    }
    return route.fulfill({ path: p.startsWith('/static/') ? root + p : root + '/index.html' });
   });
   await page.goto('http://frontend.test/a/treasury/policy' + (scenario === 'grant-link' ? '#grants' : ''));
   await page.getByRole('heading', { name: 'Current state', exact: true }).waitFor();
   await page.getByRole('heading', { name: 'Allowed actions', exact: true }).waitFor();
   await page.getByRole('heading', { name: 'Owner controls', exact: true }).waitFor();
   const state = page.getByRole('region', { name: 'Current policy and grant observations' });
   if (scenario === 'unsynchronized') assert.match(await state.innerText(), /not yet synchronized/);
   if (scenario === 'unmatched-grant') assert.match(await state.innerText(), /Current grant not confirmed/);
   if (scenario === 'approve-only') assert.match(await state.innerText(), /Approve-only/);
   if (scenario === 'missing-evidence') assert.match(await state.innerText(), /Policy check unavailable/);
   if (scenario === 'current') assert.match(await state.innerText(), /Reported in force/);
   assert.doesNotMatch(await state.innerText(), /Ready to send/);
   await page.getByText('Mandate digest and revisions', { exact: true }).click();
   if (scenario === 'missing-evidence') {
    await page.getByText(/Mandate digest unavailable/).waitFor();
    assert.equal(await page.getByText('No policy applied', { exact: true }).count(), 0);
   } else await page.locator('details').filter({ has: page.getByText('Mandate digest and revisions', { exact: true }) }).getByText('fixture-digest', { exact: true }).waitFor();
   if (scenario === 'history-error') await page.getByText(/Policy revisions could not be loaded/).waitFor();
   if (scenario === 'history-denied') {
    const record = page.getByText('private-historical-digest', { exact: true });
    await record.waitFor(); denyHistory = true;
    await page.context().setOffline(true); await page.context().setOffline(false);
    await page.getByRole('heading', { name: 'Access unavailable', exact: true }).waitFor();
    await page.getByRole('alert').filter({ hasText: 'Access denied' }).waitFor();
    await record.waitFor({ state: 'hidden' });
    assert.equal(await page.getByText('fixture-digest', { exact: true }).count(), 0);
    assert.equal(await state.count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Allowed actions', exact: true }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Owner controls', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Edit', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Check access again', exact: true }).waitFor();
   }
   if (scenario === 'grant-link') await page.getByRole('link', { name: 'Review and authorize the Portfolio strategy', exact: true }).waitFor();
   if (scenario !== 'history-denied') {
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
   }
   if (scenario === 'round-trip') {
    await page.getByLabel('USD budget a day', { exact: true }).fill('24');
    await page.getByRole('button', { name: 'Review changes', exact: true }).click();
    await page.getByText('Budget a day: $25.00 → $24.00', { exact: true }).waitFor();
    assert.equal(await page.getByText(/^Assets:/).count(), 0);
    await page.getByRole('button', { name: 'Propose in Trezu', exact: true }).click();
    await page.getByText('Offline fixture stops before signing', { exact: false }).waitFor();
    assert.equal(proposed.length, 1);
    assert.equal(proposed[0].changes.assets, 'any');
    assert.deepEqual(proposed[0].changes.limits, { daily: { 'unlisted-token': '123' } });
    assert.equal(proposed[0].changes.budget.daily_usd, '24');
    assert.ok(!calls.includes('owner/submit'));
   }
   assert.deepEqual(errors, []);
   assert.ok(!calls.some(m => /submit|revoke|stop|enable|tick|^pay$/.test(m) || (scenario !== 'round-trip' && /prepare/.test(m))));
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
   console.log('PASS policy clarity: ' + scenario); await page.close();
  }
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
