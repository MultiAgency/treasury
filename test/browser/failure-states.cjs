const { rpcValue } = require('./fixtures/rpc.cjs');
/** Offline failed-refresh checks. No server, signer or executor is started. */
const assert = require('node:assert/strict');
const { chromium } = require('./fixtures/browser.cjs');
const root = require('node:path').resolve(process.argv[2] || 'web/dist');
(async () => {
 const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
 try {
 async function open(path, options = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.clock.install(); page.setDefaultTimeout(10000);
  const state = { error: null, denied: null }, calls = [], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
   const { hostname, pathname: p } = new URL(route.request().url());
   if (hostname !== 'frontend.test') return route.abort();
   if (p === '/gw/me') return route.fulfill({ json: { agents: [{ name: 'treasury', owner: 'owner.near', dao: false }], viewer: { account: 'owner.near', access: { treasury: { canSign: !options.member, canPropose: !options.member, canVote: !options.member, canExecute: !options.member, canManage: !options.member } } } } });
   if (p.includes('/rpc/')) {
    const method = p.split('/rpc/')[1]; calls.push(method);
    if (method === state.denied) return route.fulfill({ status: options.denialStatus || 403, json: { error: 'Access denied' } });
    if (method === state.error || (options.cold && method === 'setup')) return route.fulfill({ status: 503, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Fixture unavailable' } } });
    const values = {
     instance: { agentId: 'fixture', executor: !options.approveOnly },
     setup: { agentId: 'fixture', executor: !options.approveOnly, wallet: 'agent.near', owner: { type: 'near', account_id: 'owner.near' }, grant: null, dao: null },
     overview: { agentId: 'fixture', area: options.payables ? 'payables' : 'treasury', book: [], unmanaged: [], target: {}, rebalance: { minLegUsd: 1, maxCostBps: 100 }, grants: [], agreed: [], notInForce: null, policy: { policy: { actions: ['swap'], destinations: { mode: 'only', list: [] } } } },
     'treasury/get': null, 'autopilot/get': { on: true, everyMin: 60, maxUsd: 10 },
     activity: [{ at: options.payables ? new Date().toISOString() : '2026-10-01T00:00:00Z', kind: 'payout', request: { recipient: 'payee.near', amount: '1000000', asset: 'usdc' }, correlationId: 'payment-fixture', status: 'SUCCESS', policyRevision: 1, policyDigest: 'fixture-digest' }],
     'owner/actions': options.ownerAction ? [{ correlationId: 'owner-fixture', type: 'approval_vote', stage: 'submitted' }] : [], 'owner/pending': [], held: [], unresolved: options.unresolved ? [{ key: 'unresolved-fixture', kind: 'payout', at: '2026-10-01T00:00:00Z', status: 'PROCESSING', sent: true }] : [], 'inbox/list': [], 'agreements/list': [], invoices: [], reconcileBooks: [],
     paymentHistory: { items: [], complete: true }, paymentStatus: { status: options.outcome || 'PROCESSING', request: { recipient: 'payee.near', asset: 'usdc', amount: '1000000' }, approvalId: null },
     'strategy/get': null, 'autopilot/evidence': { ticks: [] },
    };
    assert.ok(method in values, `Unexpected RPC ${method}`);
    return route.fulfill({ json: { json: rpcValue(values, method) } });
   }
   if (p.startsWith('/static/')) return route.fulfill({ path: root + p, contentType: p.endsWith('.js') ? 'application/javascript' : p.endsWith('.css') ? 'text/css' : 'font/woff2' });
   return route.fulfill({ path: root + '/index.html', contentType: 'text/html' });
  });
  await page.goto('http://frontend.test' + path);
  return { page, state, calls, errors };
 }
 for (const denialStatus of [401, 403]) {
  for (const scenario of [
   { path: '/a/treasury/activity', method: 'activity', selector: '#operation-payment-fixture' },
   { path: '/#activity', method: 'activity', selector: '#treasury-operation-payment-fixture' },
   { path: '/#activity', method: 'owner/actions', text: 'approval vote' },
   { path: '/a/treasury/follow/payment?payment=payment-fixture', method: 'paymentStatus', text: 'payee.near', cold: true },
   { path: '/a/treasury/follow/payment?payment=payment-fixture', method: 'paymentStatus', text: 'payee.near' },
   { path: '/a/treasury/follow/payment', method: 'activity', text: 'payee.near', allRecords: true },
  ]) {
   const { page, state } = await open(scenario.path, { ownerAction: true, cold: scenario.cold, payables: scenario.payables, denialStatus });
   if (scenario.allRecords) await page.getByRole('radiogroup', { name: 'Show payments', exact: true }).getByRole('radio', { name: /^All records/ }).click();
   const record = scenario.selector ? page.locator(scenario.selector) : page.getByText(scenario.text, { exact: false }).first();
   await record.waitFor();
   state.denied = scenario.method;
   await page.context().setOffline(true); await page.context().setOffline(false);
   await page.clock.fastForward(31000); await page.clock.runFor(10000);
   await record.waitFor({ state: 'hidden' });
   await page.close();
  }
  console.log(`PASS gateway HTTP ${denialStatus} hides cached activity, owner actions and payment recovery terms`);
 }

 {
  const { page, state, calls, errors } = await open('/a/treasury/activity');
  await page.locator('#operation-payment-fixture').waitFor();
  await page.getByText('Recorded policy revision 1', { exact: true }).click();
  state.error = 'activity';
  // Reconnecting requests fresh observations without remounting the page.
  await page.context().setOffline(true);
  await page.context().setOffline(false);
  await page.clock.runFor(100);
  await page.getByText(/Activity could not be refreshed/).waitFor();
  await page.locator('#operation-payment-fixture').waitFor();
  assert.ok(await page.getByText('fixture-digest', { exact: true }).isVisible(), 'expanded evidence stays open after failed refresh');
  assert.equal(await page.getByText(/No actions recorded on this instance/).count(), 0);
  state.error = null;
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await page.getByText(/Activity could not be refreshed/).waitFor({ state: 'hidden' });
  await page.locator('#operation-payment-fixture').waitFor();
  assert.deepEqual(errors, []); assert.ok(!calls.includes('recover'));
  await page.close(); console.log('PASS failed Activity refresh retains records and explicit retry restores current view');
 }
 {
  const { page, state, calls } = await open('/a/treasury/follow/payment?payment=payment-fixture', { cold: true, outcome: 'SUCCESS' });
  await page.getByText('success', { exact: true }).waitFor();
  state.error = 'paymentStatus'; await page.context().setOffline(true); await page.context().setOffline(false); await page.clock.runFor(100);
  await page.getByText(/Payment outcome could not be refreshed/).waitFor();
  await page.getByText('Last reported: success', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('payment'), 'payment-fixture');
  assert.ok(!calls.some(m => /owner\/(prepare|submit)|^pay$/.test(m)));
  await page.close(); console.log('PASS payment recovery labels retained status after failed refresh');
 }
 {
  const { page, state } = await open('/#activity', { ownerAction: true });
  await page.locator('#treasury-operation-payment-fixture').waitFor();
  state.error = 'activity'; await page.clock.fastForward(31000); await page.clock.runFor(100);
  await page.getByText(/Activity could not be refreshed/).waitFor();
  await page.locator('#treasury-operation-payment-fixture').waitFor();
  state.error = 'owner/actions'; await page.clock.fastForward(31000); await page.clock.runFor(100);
  await page.getByText(/Owner actions could not be refreshed/).waitFor();
  const owner = page.locator('#treasury-owner-owner-fixture');
  await owner.waitFor();
  assert.match(await owner.innerText(), /approval vote[\s\S]*Submission attempted.*Do not sign again/);
  await owner.getByText('Owner action reference', { exact: true }).click();
  assert.equal(await owner.getByRole('link', { name: 'Open this owner action', exact: true }).getAttribute('href'), '/a/treasury/activity#owner-owner-fixture');
  await page.close(); console.log('PASS shared Activity retains independent money and owner records');
 }
 {
  const { page, state, calls } = await open('/a/treasury/activity', { unresolved: true });
  await page.getByRole('button', { name: 'Check operation outcomes', exact: true }).waitFor();
  state.error = 'unresolved'; await page.clock.fastForward(31000); await page.clock.runFor(10000);
  await page.getByText(/Unresolved operations could not be refreshed/).waitFor();
  await page.getByText(/unresolved-fixture/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Check operation outcomes', exact: true }).count(), 0);
  assert.ok(!calls.includes('recover'));
  await page.close(); console.log('PASS stale unresolved references remain visible without recovery actions');
 }
 for (const options of [{ member: true }, { approveOnly: true }]) {
  const { page, calls } = await open('/a/treasury/automations', { cold: true, ...options });
  await page.getByText(options.member ? 'Your account cannot stop the schedule.' : 'Stop the schedule on the executor; this instance is approve-only.', { exact: true }).waitFor();
  assert.ok(await page.getByRole('button', { name: 'Turn off', exact: true }).isDisabled());
  assert.ok(!calls.includes('autopilot/stop'));
  await page.close(); console.log('PASS recovery stop explains the required permission or executor');
 }
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
