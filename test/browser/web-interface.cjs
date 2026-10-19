const assert = require('node:assert/strict');
const { assertResponsive } = require('./fixtures/layout.cjs');
const { rpcBody, rpcMalformed, UNAVAILABLE } = require('./fixtures/rpc.cjs');
const { openWorkspaceNavigation } = require('./fixtures/navigation.cjs');
/**
 * Offline UI regressions. Every request is fulfilled locally or aborted; no executor runs.
 * Build with pnpm build:web. Then run this file with Playwright installed externally:
 * PLAYWRIGHT_MODULE=/path/to/playwright-core BROWSER_EXECUTABLE=/path/to/chrome node test/browser/web-interface.cjs [build-directory]
 * Omit BROWSER_EXECUTABLE to use Playwright's installed Chromium.
 */
const {chromium}=require('./fixtures/browser.cjs');
const root=require('node:path').resolve(process.argv[2]||'web/dist');
const results=[];
let pageErrors=[];
const budget=Object.fromEntries(['daily','weekly','monthly'].map(p=>[p,{limit_usd:'100',remaining_usd:'90',spent_usd:'10',resets_at:null}]));
const setup={executor:true,agentId:'fixture',wallet:'agent.near',owner:{type:'near',account_id:'owner.near',public_key:'ed25519:fixture'},grant:{id:'grant',label:'treasury',expiresAt:'2030-01-01T00:00:00Z'},dao:{id:'owner.sputnik-dao.near',owner:{type:'near',account_id:'owner.near',public_key:'ed25519:fixture'},funded:false}};
const overview=kind=>({agentId:'fixture',digest:'sha256:'+'a'.repeat(64),grants:[],rebalance:{minLegUsd:1,maxCostBps:100},notInForce:null,agreed:['payee.near'],unmanaged:[],target:{usdc:1},book:[{asset:'usdc',symbol:'USDC',decimals:6,public:0n,confidential:10000000n,usd:10,price:1,priceUpdatedAt:null,priceExpiresAt:null}],policy:{status:'APPLIED',revision:1,policy:{actions:kind==='treasury'?['swap','transfer']:['transfer'],owner_approval:false,frozen:false,destinations:{mode:'only',list:[{action:'transfer',address:'payee.near',confidential:true},{action:'transfer',address:'treasury.near',confidential:true}]},assets:'any',budget:{daily_usd:null,weekly_usd:null,monthly_usd:null},limits:{},confidential:false,max_actions_per_hour:10,timelock_ms:0},usage:{budget,timelock:{delay_ms:0,scheduled_count:0}},cooldowns:{policy_change_available_at:null,unfreeze_available_at:null},wallet_id:'agent.near',provider_policy_synced:true}});
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE});
async function pageFor(path,options={}){const page=await browser.newPage({viewport:{width:options.width||390,height:900},reducedMotion:'reduce'});page.setDefaultTimeout(5000);page.on('pageerror',error=>pageErrors.push(error.message));if(options.clock)await page.clock.install();const calls=[];const requests=[];let failedGateway=!!options.gatewayError;let releaseDelayed;const delayed=new Promise(resolve=>{releaseDelayed=resolve;});
await page.route('**/*',async r=>{const u=new URL(r.request().url()),p=u.pathname;if(u.hostname!=='frontend.test')return r.abort();
if(p==='/gw/me'){if(options.gatewayDelay)await new Promise(ok=>setTimeout(ok,1200));if(failedGateway)return r.fulfill({status:503,json:{error:'Fixture gateway unavailable'}});return r.fulfill({json:{agents:options.public?[]:[{name:'treasury',area:'treasury',owner:'owner.near',dao:false},{name:'payables',area:'payables',owner:options.dao?setup.dao.id:'owner.near',dao:!!options.dao}],invoices:null,viewer:options.public?null:{account:'owner.near',access:{treasury:{canSign:true,canPropose:true,canVote:true,canExecute:true,canManage:true},payables:{canSign:!options.dao,canPropose:true,canVote:true,canExecute:true,canManage:true}}}}});}
if(p==='/gw/proposals')return r.fulfill({json:[]});
if(p.includes('/rpc/')){const m=p.split('/rpc/')[1];calls.push(m);requests.push({method:m,body:r.request().postDataJSON()});if(options.hold===m)await delayed;if(options.delay===m)await new Promise(ok=>setTimeout(ok,1200));if(options.error===m)return r.fulfill({status:500,json:{json:{defined:false,code:'INTERNAL_SERVER_ERROR',message:'Fixture read unavailable'}}});const values={get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup,overview:overview(path.includes('payables')?'payables':'treasury'),'treasury/get':options.linked?{accountId:'treasury.near',dao:null,confidential:false,balances:{near:'0',usdc:'0'},payees:[]}:null,held:[],unresolved:[],'inbox/list':[],'agreements/list':options.agreements?[{id:'a',payee:'payee.near',amount:'1000000',status:'requested',origin:'payee',at:new Date().toISOString(), note: ''}]:[],activity:[],'owner/pending':[],'owner/actions':[],policyHistory:[],'autopilot/get':{on:false,everyMin:60,maxUsd:10,lastRun:null,nextRun:null},'autopilot/evidence':{ticks:[],corrupt:[]},'strategy/get':options.ready?{strategy:{targetBps:{usdc:10000},minLegUsd:1,maxCostBps:100,autopilot:{everyMin:60,maxUsd:10}},digest:'fixture-strategy',grantSuffix:'fixture',executor:true,on:false,grantMatches:true,unresolved:0,grant:setup.grant,observedAt:new Date().toISOString(),readiness:{state:'off',canEnable:true,reasons:[]}}:{strategy:{targetBps:{usdc:10000},minLegUsd:1,maxCostBps:100,autopilot:{everyMin:60,maxUsd:10}},digest:'fixture-strategy',grantSuffix:'fixture',executor:true,on:false,grantMatches:false,unresolved:0,grant:setup.grant,observedAt:new Date().toISOString(),readiness:{state:'authorization-required',canEnable:false,reasons:[]}},pay:{outcome:'settled',status:'PENDING_APPROVAL',correlationId:'payment-fixture',failureCode:null},'treasury/unlink':null,'agreements/decline':null};if(options.values)Object.assign(values,options.values);if(options.notInForce)values.overview.notInForce=options.notInForce;if(options.policy)values.overview.policy.policy={...values.overview.policy.policy,...options.policy};if(options.revision)values.overview.policy.revision=options.revision;if(options.digest)values.overview.digest=options.digest;if(options.approvalUnknown)values.overview.policy.policy.owner_approval=undefined;
// A malformed answer is rejected client-side; nothing can be confirmed.
if(options.approvalUnknown&&m==='overview')return r.fulfill({json:rpcMalformed(m,values.overview)});return r.fulfill({json: rpcBody(values, m)});}
if(p.startsWith('/static/'))return r.fulfill({path:root+p,contentType:p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':'font/woff2'});return r.fulfill({path:root+'/index.html',contentType:'text/html'});});await page.goto('http://frontend.test'+path);if(options.gatewayError)await page.getByRole('alert').waitFor();else if(!options.fast)await page.getByRole('heading',{level:1}).waitFor();return {page,calls,requests,release:()=>releaseDelayed(),recover:()=>failedGateway=false};}
async function recipient(page) {
 const summary=page.locator('summary').filter({hasText:/^Send money to a payee$/});
 await summary.waitFor();
 if(!await summary.evaluate(e=>e.parentElement.open))await summary.click();
 return page.getByLabel("Recipient’s NEAR account", {exact:true});
}
async function check(name,work){
 if(process.env.WIG_CASE&&!new RegExp(process.env.WIG_CASE).test(name))return;
 pageErrors=[];
 try{const detail=await work();assert.deepEqual(pageErrors,[], 'Unexpected browser error');results.push({name,pass:detail===true,detail});}
 catch(e){results.push({name,pass:false,detail:e.message});}
 finally{for(const context of browser.contexts())await context.close();}
}
await check('agreement forms expose labelled controls',async()=>{
 const {page}=await pageFor('/a/payables/payees');
 await page.getByText('Offer terms (a purchase order, a bounty or grant award)',{exact:true}).click();
 await page.getByText('Add a payee without agreement terms',{exact:true}).click();
 await page.locator('[name=offer-payee]').waitFor();
 return page.locator('input,select,textarea').evaluateAll(controls=>{
  const visible=controls.filter(control=>control.getClientRects().length>0);
  return visible.length>0&&visible.every(control=>[...(control.labels||[])].some(label=>label.textContent.trim())||control.getAttribute('aria-label')?.trim()||control.getAttribute('aria-labelledby')?.split(/\s+/).some(id=>document.getElementById(id)?.textContent.trim()));
 });
});
await check('Steward instructions keep their label and guidance after typing',async()=>{
 const {page,calls}=await pageFor('/a/treasury/steward',{width:320});
 const field=page.getByRole('textbox',{name:'Instructions (optional)',exact:true});await field.fill('Review the current allocation.');
 return await field.evaluate(element=>element.labels?.[0]?.textContent==='Instructions (optional)'&&document.getElementById(element.getAttribute('aria-describedby'))?.textContent.includes('Leave empty for a routine review')&&element.getBoundingClientRect().height>=44)
  &&!calls.some(method=>/steward|executePlan/.test(method))&&await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
});
await check('4 decline confirmation',async()=>{const {page,calls}=await pageFor('/a/payables/payees',{agreements:true});await page.getByRole('button',{name:'Decline',exact:true}).click();return !calls.includes('agreements/decline')&&await page.getByRole('dialog').count()===1;});
await check('5 named modal and cancel focus',async()=>{const {page}=await pageFor('/a/treasury/automations',{ready:true});await page.getByRole('button',{name:'Turn on',exact:true}).first().click();const d=page.getByRole('dialog',{name:'Let the agent act on its own?'});return await d.count()===1&&await page.evaluate(()=>document.activeElement.textContent==='Cancel');});
await check('narrow DAO confirmation keeps both actions visible and cancellation restores focus',async()=>{
 const at=new Date().toISOString(),request={amount:'1000000',asset:'usdc',recipient:'payee.near',confidential:true};
 const {page,calls}=await pageFor('/a/payables/follow/payment?payment=payment-one',{width:320,dao:true,values:{
  held:[{correlationId:'payment-one',approvalId:'approval-one',at,request,kind:'payout'}],invoices:[],
  paymentHistory:{items:[{correlationId:'payment-one',at}],complete:true},
  paymentStatus:{status:'PENDING_APPROVAL',request,approvalId:'approval-one',createdAt:at,expiresAt:'2030-01-01T00:00:00Z', failureCode: null, updatedAt: null, detailError: null, evidence: { txHash: null, destinationTxHash: null, refundTxHash: null, refundTo: null, refundedAmount: null } },
 }});
 const trigger=page.getByRole('button',{name:'Propose rejection',exact:true});await trigger.click();
 const modal=page.getByRole('dialog',{name:'Reject this held payout?',exact:true});await modal.waitFor();
 const cancel=modal.getByRole('button',{name:'Cancel',exact:true});
 if(!await cancel.evaluate(e=>e===document.activeElement))throw Error('Cancel did not receive initial focus');
 await modal.getByRole('button',{name:'Continue to DAO rejection',exact:true}).waitFor();
 const geometry=await modal.evaluate(dialog=>{const d=dialog.getBoundingClientRect();return [...dialog.querySelectorAll('button')].map(button=>{const b=button.getBoundingClientRect();return {label:button.textContent,left:b.left,right:b.right,height:b.height,inside:b.left>=d.left&&b.right<=d.right};});});
 if(geometry.some(button=>!button.inside||button.height<44))return geometry;
 await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});
 await page.waitForFunction(()=>document.activeElement?.textContent==='Propose rejection');
 await trigger.click();await cancel.click();await modal.waitFor({state:'hidden'});
 return await trigger.evaluate(e=>e===document.activeElement)&&!calls.some(method=>/^owner\/(prepare|submit)$/.test(method));
});
await check('long failure code wraps outside its short status badge',async()=>{
 const failureCode='PROVIDER_REPORTED_A_FAILURE_WITH_AN_UNBROKEN_REFERENCE_'+ 'x'.repeat(100);
 const {page}=await pageFor('/a/treasury/funding',{width:320,values:{pay:{outcome:'settled',status:'FAILED',correlationId:'payment-fixture',failureCode}}});
 await (await recipient(page)).fill('payee.near');await page.getByLabel('Amount',{exact:true}).fill('1');
 await page.getByRole('button',{name:'Review payment',exact:true}).click();
 await page.getByRole('dialog',{name:'Review payment'}).getByRole('button',{name:'Send payment',exact:true}).click();
 const code=page.getByText(failureCode,{exact:true});await code.waitFor();
 if(await code.evaluate(e=>Boolean(e.closest('[data-slot="badge"]'))))throw Error('failure detail is trapped inside a badge');
 return await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
});
await check('7 date validation',async()=>{const {page,calls}=await pageFor('/a/payables/payees',{agreements:true});await page.getByLabel('Terms hold until',{exact:true}).fill('');await page.getByRole('button',{name:'Agree to these terms'}).click();return !calls.includes('agreements/propose')&&await page.locator('input[type=date][aria-invalid=true]').count()>0;});
await check('10 draft guard',async()=>{const {page}=await pageFor('/a/payables/payees');await page.getByText('Offer terms (a purchase order, a bounty or grant award)',{exact:true}).click();const draftInput=page.locator('[name=offer-payee]');await draftInput.fill('draft.near');let guarded=false;page.on('dialog',async d=>{guarded=true;await d.dismiss();});await page.getByRole('navigation',{name:'Area utilities',exact:true}).getByRole('link',{name:'Balances & funding',exact:true}).click();await page.waitForTimeout(100);return guarded&&/\/payees\/?$/.test(page.url())||{guarded,url:page.url()};});
await check('bootstrap failure is announced and retry restores the public page',async()=>{
 const {page,recover}=await pageFor('/',{gatewayError:true,public:true});
 await page.getByRole('alert').waitFor();
 const retry=page.getByRole('button',{name:'Retry',exact:true});await retry.waitFor();
 const refreshed=page.waitForResponse(response=>new URL(response.url()).pathname==='/gw/me'&&response.ok());
 recover();await retry.click();await refreshed;
 await page.getByRole('alert').filter({hasText:'Fixture gateway unavailable'}).waitFor({state:'hidden'});
 await page.getByRole('heading',{level:1}).waitFor();return true;
});
await check('13 reduced motion',async()=>{const {page,release}=await pageFor('/a/treasury/automations',{hold:'autopilot/get',fast:true});await page.getByText('Checking autopilot settings…',{exact:true}).waitFor();const stopped=await page.locator('.animate-spin').evaluateAll(xs=>xs.length>0&&xs.every(x=>getComputedStyle(x).animationName==='none'));release();return stopped;});

await check('payment review: Enter, exact terms, focus trap, Escape and one submission',async()=>{
 const {page,calls,requests}=await pageFor('/a/treasury/funding');
 await (await recipient(page)).fill('payee.near');
 const amount=page.getByPlaceholder('Amount',{exact:true});await amount.fill('1.234567');await amount.press('Enter');
 const modal=page.getByRole('dialog',{name:'Review payment',exact:true});await modal.waitFor();
 if(calls.includes('pay')||!await modal.getByText('1.234567 USDC',{exact:true}).count()||!await modal.getByText('payee.near',{exact:true}).count())throw Error('review terms mismatch');
 if(!await modal.getByRole('button',{name:'Cancel',exact:true}).evaluate(e=>e===document.activeElement))throw Error('initial focus not Cancel');
 await page.keyboard.press('Shift+Tab');
 // Native dialogs may allow focus to browser chrome (represented by body), but never underlying controls.
 if(!await modal.evaluate(e=>e.contains(document.activeElement)||document.activeElement===document.body))throw Error('focus escaped into background controls');
 await page.keyboard.press('Tab');
 await amount.evaluate(e=>e.focus());if(!await modal.evaluate(e=>e.contains(document.activeElement)))throw Error('background input accepted focus while modal');
 await page.keyboard.press('Escape');await modal.waitFor({state:'detached'});if(calls.includes('pay'))throw Error('Escape submitted');
 await page.getByRole('button',{name:'Review payment',exact:true}).click();await modal.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.waitForFunction(()=>document.activeElement.textContent.includes('Review payment'));if(!await page.getByRole('button',{name:'Review payment',exact:true}).evaluate(e=>e===document.activeElement))throw Error('trigger focus');
 await page.getByRole('button',{name:'Review payment',exact:true}).click();await modal.getByRole('button',{name:'Send payment'}).click();
 await page.getByText('Held payout',{exact:true}).waitFor();
 await assertResponsive(page, 'confirmed payment');
 const sent=requests.filter(x=>x.method==='pay');return sent.length===1&&sent[0].body.json.amount==='1234567'&&sent[0].body.json.recipient==='payee.near'||sent;
});
await check('return review and unlink cancellation do not submit',async()=>{
 const {page,calls}=await pageFor('/a/treasury/funding',{linked:true});
 await page.getByText('Money out: return funds to treasury.near',{exact:true}).click();
 const form=page.getByRole('button',{name:'Review return'}).locator('..');await form.getByLabel('Amount',{exact:true}).fill('2');
 await page.getByRole('button',{name:'Review return'}).click();const modal=page.getByRole('dialog',{name:'Review payment'});
 if(!await modal.getByText('treasury.near',{exact:true}).count())return false;
 await page.keyboard.press('Escape');await page.getByText('Treasury settings',{exact:true}).click();await page.getByRole('button',{name:'Unlink this treasury'}).click();
 await page.getByRole('dialog',{name:'Unlink this treasury?'}).getByRole('button',{name:'Cancel'}).click();
 return !calls.includes('pay')&&!calls.includes('treasury/unlink');
});
await check('validation focuses the first field and names the error',async()=>{
 const {page,calls}=await pageFor('/a/payables/payees');await page.getByText('Offer terms (a purchase order, a bounty or grant award)',{exact:true}).click();await page.getByRole('button',{name:'Offer',exact:true}).click();
 const payee=page.locator('[name=offer-payee]');await page.waitForFunction(()=>document.activeElement.getAttribute('name')==='offer-payee');
 return !calls.includes('agreements/offer')&&await payee.evaluate(e=>e===document.activeElement&&e.getAttribute('aria-invalid')==='true'&&Boolean(document.getElementById(e.getAttribute('aria-describedby'))?.textContent));
});
await check('policy caps: labels, inline errors, dirty cancel',async()=>{
 const {page}=await pageFor('/a/treasury/policy');await page.getByRole('button',{name:'Edit',exact:true}).click();
 const cap=page.getByLabel('USDC per payment cap',{exact:true});await cap.fill('invalid');await page.getByRole('button',{name:'Review changes'}).click();
 await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-invalid')==='true');
 if(!await cap.evaluate(e=>e===document.activeElement&&e.getAttribute('aria-invalid')==='true'))return false;
 let prompted=false;page.on('dialog',async d=>{prompted=true;await d.dismiss();});await page.getByRole('button',{name:'Cancel',exact:true}).click();
 return prompted&&await cap.inputValue()==='invalid';
});
await check('navigation focuses main; public disclosures make no private requests',async()=>{
 const {page}=await pageFor('/a/treasury/funding');await page.getByRole('navigation',{name:'Area',exact:true}).getByRole('link',{name:'Strategy',exact:true}).click();
 await page.waitForTimeout(100);if(!await page.getByRole('main').evaluate(e=>e===document.activeElement))return false;
 const pub=await pageFor('/',{public:true});await pub.page.keyboard.press('Tab');if(!await pub.page.getByRole('link',{name:'Skip to main content'}).evaluate(e=>e===document.activeElement))return false;
 await pub.page.keyboard.press('Enter');if(!await pub.page.getByRole('main').evaluate(e=>e===document.activeElement))return false;
 await pub.page.getByText('View requirements',{exact:true}).first().click();return await pub.page.getByRole('main').count()===1&&pub.calls.length===0;
});
await check('startup announces loading before the gateway responds',async()=>{
 const {page}=await pageFor('/',{public:true,gatewayDelay:true,fast:true});await page.getByRole('status').getByText('Loading dashboard…',{exact:true}).waitFor();return true;
});
await check('light/dark input and focus contrast',async()=>{
 const {page}=await pageFor('/a/payables/payees');
 await page.getByText('Offer terms (a purchase order, a bounty or grant award)',{exact:true}).click();
 for(const scheme of ['light','dark']){
  await page.emulateMedia({colorScheme:scheme});await page.waitForTimeout(50);
  const field=page.locator('[name=offer-payee]');await field.focus();
  const ratios=await field.evaluate(e=>{
   const styles=getComputedStyle(e),card=getComputedStyle(document.documentElement).getPropertyValue('--card');
   const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
   const lum=(color)=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=card;ctx.fillRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);const a=[...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return a[0]*.2126+a[1]*.7152+a[2]*.0722;};
   const bg=lum(card),ratio=c=>(Math.max(lum(c),bg)+.05)/(Math.min(lum(c),bg)+.05);
   return {border:ratio(styles.borderColor),focus:ratio(styles.outlineColor),text:ratio(styles.color)};
  });if(ratios.border<3||ratios.focus<3||ratios.text<4.5)return {scheme,...ratios};
 }return true;
});
await check('expanded agreement, funding and policy forms fit mobile and desktop',async()=>{
 for(const path of ['/a/payables/payees','/a/treasury/funding','/a/treasury/policy']){
  const {page}=await pageFor(path);
  if(path.endsWith('/payees'))await page.getByText('Offer terms (a purchase order, a bounty or grant award)',{exact:true}).click();
  if(path.endsWith('/funding'))await recipient(page);
  if(path.endsWith('/policy'))await page.getByRole('button',{name:'Edit',exact:true}).click();
  await assertResponsive(page,path);
  await page.close();
 }return true;
});
await check('missing approval requirement cannot confirm a payment',async()=>{
 // A malformed answer is rejected client-side; nothing can be confirmed.
 const {page,calls}=await pageFor('/a/treasury/funding',{approvalUnknown:true});
 await page.locator('main').filter({hasText:'Some agent details could not be loaded.'}).getByText(UNAVAILABLE,{exact:true}).waitFor({timeout:15000});
 const enabled=name=>page.getByRole('button',{name,exact:true}).and(page.locator(':enabled')).count();
 return await enabled('Review payment')===0&&await enabled('Send payment')===0&&!calls.includes('pay');
});

await check('policy freshness: preserve draft and review every reversal after refresh',async()=>{
 const options={policy:{owner_approval:false},revision:1,error:'owner/prepare'};
 const {page,requests}=await pageFor('/a/treasury/policy',options);
 await page.getByRole('button',{name:'Edit',exact:true}).click();
 await page.getByLabel('Actions an hour',{exact:true}).fill('5');
 await page.getByRole('button',{name:'Review changes',exact:true}).click();
 options.policy.owner_approval=true;options.revision=2;options.digest='sha256:'+'b'.repeat(64);
 await page.getByRole('button',{name:'Refresh',exact:true}).click();
 await page.getByText('Revision 2',{exact:false}).waitFor();
 if(await page.getByRole('button',{name:'Propose in Trezu',exact:true}).count())throw Error('stale signing still offered');
 if(!await page.getByRole('button',{name:'Review changes',exact:true}).isDisabled())throw Error('stale review enabled');
 if(await page.getByLabel('Actions an hour',{exact:true}).inputValue()!=='5')throw Error('draft lost');
 await page.getByRole('button',{name:'Compare draft with current policy',exact:true}).click();
 await page.getByRole('button',{name:'Review changes',exact:true}).click();
 await page.getByText('Owner approval: every payment → not required',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Propose in Trezu',exact:true}).click();
 await page.waitForTimeout(150);
 const body=requests.find(r=>r.method==='owner/prepare')?.body.json.action;
 return requests.filter(r=>r.method==='owner/prepare').length===1&&!requests.some(r=>r.method==='owner/submit')&&body?.expectedPolicy.revision===2&&body.expectedPolicy.digest===options.digest&&body.changes.owner_approval===false;
});
await check('policy freshness: payment and return confirmation refuse drift and permit explicit re-review',async()=>{
 for(const linked of [false,true]){
  const options={linked,clock:true,policy:{owner_approval:true},revision:1};
  const {page,requests}=await pageFor('/a/treasury/funding',options);
  if(linked)await page.getByText('Money out: return funds to treasury.near',{exact:true}).click();
  else await (await recipient(page)).fill('payee.near');
  const trigger=page.getByRole('button',{name:linked?'Review return':'Review payment',exact:true});
  const amount=trigger.locator('..').getByLabel('Amount',{exact:true});
  // The manual payment button's immediate parent contains its amount field too.
  await amount.fill('1');await trigger.click();
  options.policy.owner_approval=false;options.revision=2;options.digest='sha256:'+'b'.repeat(64);
  await page.clock.fastForward(31000);await page.waitForTimeout(200);
  const modal=page.getByRole('dialog');
  if(!await modal.getByRole('button',{name:'Send payment'}).isDisabled())throw Error('stale payment can send');
  await modal.getByRole('alert').getByText(/policy changed/).waitFor();
  if(requests.some(r=>r.method==='pay'))throw Error('stale payment submitted');
  await modal.getByRole('button',{name:'Cancel',exact:true}).click();
  if(await amount.inputValue()!=='1')throw Error('payment draft lost');
  await trigger.click();await page.getByRole('dialog').getByText(/Not required by the reviewed policy/).waitFor();
  await page.getByRole('dialog').getByRole('button',{name:'Send payment'}).click();await page.waitForTimeout(150);
  const sent=requests.filter(r=>r.method==='pay');
  if(sent.length!==1||sent[0].body.json.expectedPolicy?.revision!==2||sent[0].body.json.expectedPolicy?.digest!==options.digest)throw Error('new policy not bound');
  await page.close();
 }
 return true;
});
await check('policy freshness: owner can review safeguards while the agent is frozen',async()=>{
 const {page,requests}=await pageFor('/a/treasury/policy',{policy:{frozen:true},notInForce:'the agent is frozen',error:'owner/prepare'});
 await page.getByRole('button',{name:'Edit',exact:true}).click();
 await page.getByLabel('Actions an hour',{exact:true}).fill('5');
 if(await page.getByRole('button',{name:'Review changes',exact:true}).isDisabled())throw Error('freeze prevents owner policy review');
 await page.getByRole('button',{name:'Review changes',exact:true}).click();
 await page.getByRole('button',{name:'Propose in Trezu',exact:true}).click();await page.waitForTimeout(150);
 if(requests.filter(r=>r.method==='owner/prepare').length!==1||requests.some(r=>r.method==='owner/submit')||!requests.some(r=>r.method==='owner/prepare'&&r.body.json.action.expectedPolicy?.revision===1))return false;
 const frozen=await pageFor('/a/treasury/funding',{policy:{frozen:true},notInForce:'the agent is frozen'});
 await (await recipient(frozen.page)).fill('payee.near');
 await frozen.page.getByLabel('Amount',{exact:true}).fill('1');
 await frozen.page.getByRole('button',{name:'Review payment',exact:true}).click();
 return await frozen.page.getByRole('dialog').getByRole('button',{name:'Send payment'}).isDisabled()&&!frozen.calls.includes('pay');
});
console.log(JSON.stringify(results,null,2));await browser.close();process.exitCode=results.length > 0 && results.every(x=>x.pass)?0:1;})();
