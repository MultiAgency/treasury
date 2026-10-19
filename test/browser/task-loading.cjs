const { rpcAnswer, rpcBody } = require('./fixtures/rpc.cjs');
/** Cold provider failures must not hide independently readable tasks. All network is intercepted. */
const assert = require('node:assert/strict');
const { chromium } = require('./fixtures/browser.cjs');
const root = require('node:path').resolve(process.argv[2] || 'web/dist');
const { makeTick, recordingFor } = require('./fixtures/run.cjs');
(async () => {
 const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
 let failures = 0;
 try {
 for (const mode of (process.env.READ_MODE ? [process.env.READ_MODE] : ['failed', 'pending']))
 for (const failure of ['setup', 'overview']) for (const task of ['payment', 'run', 'stop', 'activity'])
 for (const profile of (mode === 'pending' && task === 'stop' ? ['owner', 'member', 'approve-only'] : ['owner'])) {
  if (process.env.TASK && process.env.TASK !== task) continue;
  const page = await browser.newPage(); page.setDefaultTimeout(mode === 'pending' ? 4000 : 15000);
  const writes = [], errors = [], calls = [];
  page.on('pageerror', e => errors.push(e.message));
  const tick = makeTick('quiet', {});
  await page.route('**/*', async route => {
   const { hostname, pathname: p } = new URL(route.request().url());
   if (hostname !== 'frontend.test') return route.abort();
   if (p === '/gw/me') return route.fulfill({json:{ invoices: null,agents:[{name:'treasury',owner:'owner.near',dao:false}],viewer:{account:'owner.near',access:{treasury:{canSign:profile !== 'member',canPropose:profile !== 'member',canVote:profile !== 'member',canExecute:profile !== 'member',canManage:profile !== 'member'}}}}});
   if (p.includes('/rpc/')) {
    const method = p.split('/rpc/')[1]; calls.push(method);
    if (method === failure && mode === 'pending') return; // Leave this unrelated read unanswered.
    if (method === failure) return route.fulfill({status:503,json:{json:{defined:false,code:'INTERNAL_SERVER_ERROR',message:'Fixture unavailable'}}});
    if (method === 'autopilot/stop') { writes.push(method); return route.fulfill({json: rpcAnswer(method, {on:false})}); }
    const values = {
     instance:{agentId:'fixture',executor:profile !== 'approve-only'},
     setup:{agentId:'fixture',executor:profile !== 'approve-only',wallet:null,owner:{type:'near',account_id:'owner.near',public_key:'ed25519:fixture'},grant:null,dao:null},
     overview:{agentId:'fixture',book:[],unmanaged:[],target:{},rebalance:{minLegUsd:1,maxCostBps:100},grants:[],agreed:[],notInForce:null,policy:{policy:{actions:['swap'],destinations:{mode:'only',list:[]},frozen:false,confidential:false,owner_approval:false,assets:'any',limits:{},max_actions_per_hour:10,budget:{ daily_usd: null, weekly_usd: null, monthly_usd: null },timelock_ms:0},wallet_id:'agent.near',revision:null,status:'APPLIED',provider_policy_synced:true,cooldowns:{ policy_change_available_at: null, unfreeze_available_at: null },usage:{ budget: { daily: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, weekly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, monthly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null } }, timelock: { delay_ms: 0, scheduled_count: 0 } }}, digest: null},
     'treasury/get':null, 'autopilot/get':{on:true,everyMin:60,maxUsd:10,lastRun:null,nextRun:null}, 'autopilot/evidence':{ticks:[tick],corrupt:[]}, 'autopilot/log':recordingFor(tick),
     activity:[{at:tick.at,kind:'payout',request:{},correlationId:'payment',status:'SUCCESS'}],
     'owner/actions':[], 'owner/pending':[], held:[], unresolved:[], 'inbox/list':[], 'agreements/list':[], invoices:[], reconcileBooks:[],
     paymentHistory:{items:[],complete:true}, paymentStatus:{status:'SUCCESS',request:{recipient:'payee.near',asset:'usdc',amount:'1000000'},createdAt:tick.at,approvalId:null, failureCode: null, updatedAt: null, expiresAt: null, detailError: null, evidence: { txHash: null, destinationTxHash: null, refundTxHash: null, refundTo: null, refundedAmount: null } },
     'strategy/get':null,
    };
    assert.ok(method in values, `Unexpected RPC ${method}`);
    return route.fulfill({json: rpcBody(values, method)});
   }
   if (p.startsWith('/static/')) return route.fulfill({path:root+p,contentType:p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':'font/woff2'});
   return route.fulfill({path:root+'/index.html',contentType:'text/html'});
  });
  try {
   const path = {payment:'follow/payment?payment=payment',run:'follow/run?run=fixture-run',stop:'automations',activity:'activity'}[task];
   await page.goto('http://frontend.test/a/treasury/'+path);
   if (task === 'payment') { await page.getByRole('heading',{name:'Follow this payment',exact:true}).waitFor(); await page.getByText('payee.near',{exact:false}).first().waitFor(); }
   if (task === 'run') await page.getByText('Run outcome: book on target',{exact:false}).waitFor();
   if (task === 'activity') await page.locator('#operation-payment').waitFor();
   if (task === 'stop') {
    const stop = page.getByRole('button',{name:'Turn off',exact:true});
    if (profile === 'owner') { await stop.click(); assert.deepEqual(writes,['autopilot/stop']); }
    else { await stop.waitFor(); assert.equal(await stop.isDisabled(), true); assert.deepEqual(writes,[]); }
   }
   else assert.deepEqual(writes,[]);
   assert.ok(calls.includes(failure), `The ${failure} fault must be exercised before this case can pass`);
   assert.ok(!calls.includes('treasury/get'), 'independent tasks must not request linked-treasury observations');
   assert.deepEqual(errors,[]);
   console.log('PASS',mode,failure,task,profile);
  } catch(e) { failures++; console.error('FAIL',mode,failure,task,e.message,errors); }
  await page.close();
 }
 } finally { await browser.close(); }
 process.exitCode = failures ? 1 : 0;
})();
