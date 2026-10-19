const path = require('node:path');
const { rpcBody } = require('./rpc.cjs');

/** Explicit read-only payment and schedule evidence for owner-facing status checks. */
async function openOwnerStatus(browser, root, scenario, width) {
  const page = await browser.newPage({viewport:{width,height:900}});
  page.setDefaultTimeout(5000);
  const treasury = scenario.startsWith('schedule-');
  const name = treasury ? 'treasury' : 'payables';
  const dao = scenario === 'dao';
  const at = new Date().toISOString();
  const expiresAt = '2030-01-01T00:00:00Z';
  const request = {asset:'usdc',amount:'123456789',recipient:'payee.near',confidential:true};
  const errors = [], writes = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), p = url.pathname;
    if (url.hostname !== 'frontend.test') return route.abort();
    if (p === '/gw/me') return route.fulfill({json:{agents:[{name,owner:dao?'owner.sputnik-dao.near':'owner.near',dao}],invoices:null,viewer:{account:'owner.near',access:{[name]:{canSign:!dao,canPropose:true,canVote:true,canExecute:true,canManage:true}}}}});
    if (p === '/gw/proposals') return route.fulfill({json:[{id:42,hash:'fixture-hash',status:'Approved',votes:{'owner.near':'Approve'},submittedAt:at}]});
    if (p.includes('/rpc/')) {
      const method = p.split('/rpc/')[1];
      const values = {
        get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup:{executor:false,agentId:'fixture',wallet:'agent.near',owner:{type:'near',account_id:dao?'owner.sputnik-dao.near':'owner.near',public_key:'ed25519:fixture'},grant:{id:'grant-fixture',label:treasury?'treasury':'payout',expiresAt},dao:null},
        overview:{agentId:'fixture',digest:'fixture',notInForce:null,agreed:[],unmanaged:[],target:{usdc:1},rebalance:{minLegUsd:1,maxCostBps:100},book:[{asset:'usdc',symbol:'USDC',decimals:6,public:0n,confidential:10000000n,usd:10,price:1,priceUpdatedAt:null,priceExpiresAt:null}],policy:{policy:{actions:treasury?['swap','transfer']:['transfer'],frozen:false,destinations:{mode:'only',list:[]},assets:'any',budget:{daily_usd:null,weekly_usd:null,monthly_usd:null},limits:{},confidential:false,owner_approval:false,max_actions_per_hour:10,timelock_ms:0},usage:{budget:{daily:{limit_usd:null,spent_usd:'0',remaining_usd:null,resets_at:null},weekly:{limit_usd:null,spent_usd:'0',remaining_usd:null,resets_at:null},monthly:{limit_usd:null,spent_usd:'0',remaining_usd:null,resets_at:null}},timelock:{delay_ms:0,scheduled_count:0}},cooldowns:{policy_change_available_at:null,unfreeze_available_at:null},wallet_id:'agent.near',revision:null,status:'APPLIED',provider_policy_synced:true},grants:[]},
        'treasury/get':null,held:[],unresolved:treasury?[{key:'unresolved-fixture',at,kind:'swap',sent:true,status:'PROCESSING',request:{}}]:[],activity:[],invoices:[],'inbox/list':[],'agreements/list':[],
        'owner/pending':dao?[{correlationId:'owner-record',type:'approval_vote',hash:'fixture-hash',intent:{standard:'nep413',payload:{message:'{}',recipient:'fixture',nonce:'fixture'}},delegate:null,state:'done',expiresAt,payment:{correlationId:'payment',verdict:'approve'}}]:[],
        'owner/status':{stage:'submitted',status:'SUCCESS'},
        'owner/actions':['approved','rejected'].includes(scenario)?[{correlationId:'owner-record',type:'approval_vote',signer:'wallet',stage:'settled',expiresAt,ownerSucceeded:true,status:scenario==='rejected'?'FAILED':'SUCCESS',payment:{correlationId:'payment',verdict:scenario==='rejected'?'reject':'approve'},failureCode:null}]:[],
        paymentHistory:{items:[{correlationId:'payment',at}],complete:true},
        paymentStatus:{status:scenario==='rejected'?'FAILED':'SUCCESS',failureCode:null,createdAt:at,updatedAt:at,request,approvalId:scenario==='unknown'?null:'approval',expiresAt,detailError:null, evidence: { txHash: null, destinationTxHash: null, refundTxHash: null, refundTo: null, refundedAmount: null } },
        'autopilot/get':{on:scenario==='schedule-on',everyMin:60,maxUsd:10,lastRun:null,nextRun:null},'autopilot/evidence':{ticks:[],corrupt:[]},
      };
      if (!(method in values)) { writes.push(method); return route.abort(); }
      return route.fulfill({json: rpcBody(values, method)});
    }
    if (p.startsWith('/static/')) return route.fulfill({path:root+p,contentType:p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':'font/woff2'});
    return route.fulfill({path:path.join(root,'index.html'),contentType:'text/html'});
  });
  return { page, errors, writes, treasury, dao, name };
}
module.exports = { openOwnerStatus };
