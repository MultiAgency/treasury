const assert = require('node:assert/strict');
const { runTask } = require('./fixtures/task.cjs');
const { workspaceEvidence, workspaceOpener } = require('./fixtures/workspace.cjs');
const { resolve } = require('node:path');
const { mkdirSync } = require('node:fs');

async function treasuryOnly(browser, root) {
  const { budget, setup, overview } = workspaceEvidence({policyDetails:true, grants:true});
  const book = overview('treasury');
  book.book[0].priceUpdatedAt = new Date().toISOString();
  book.policy.policy.limits = { monthly: { usdc: '100000000' } };
  const strategy = {targetBps:{usdc:10000},minLegUsd:1,maxCostBps:100,autopilot:{everyMin:60,maxUsd:10}};
  const open = workspaceOpener(root, { budget, values: () => ({setup:{...setup,executor:true},overview:book,treasury:null,unresolved:[], 'owner/actions':[],
    'strategy/get':{strategy,digest:'fixture',grantSuffix:'fixture',executor:true,on:false,grantMatches:true,unresolved:0,grant:setup.grant,readiness:{state:'ready',canEnable:true,reasons:[]}},
    'autopilot/get':{on:true,everyMin:60,maxUsd:10}}) });
  const context = await browser.newContext({viewport:{width:1280,height:1000},reducedMotion:'reduce'});
  const {page,calls,requests,errors} = await open(context,'/a/treasury/');
  await page.getByRole('heading',{name:'Signed limits',exact:true}).waitFor();
  assert.equal(await page.getByRole('region',{name:'Treasury owner',exact:true}).innerText(),'Owner\nowner.near','show the observed owner before reviewing Treasury actions');
  await page.getByRole('heading',{name:'Rebalance',exact:true}).waitFor();
  await page.getByRole('heading',{name:'Sweep',exact:true}).waitFor();
  assert.equal(await page.locator('header').getByText('Agentic',{exact:false}).count(),1,'configured agent uses the Treasury brand header');
  assert.equal(await page.getByText('Agent details',{exact:true}).count(),0,'no extra identity disclosure');
  assert.equal(await page.getByRole('link',{name:'Payables',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Execute',exact:true}).isDisabled(),true);
  assert(!requests.some(p=>p.includes('/payables/')));
  assert(!calls.some(c=>['executePlan','sweep','rebalance','autopilot/enable','owner/prepare'].includes(c)),'opening must not act');
  await page.getByRole('button',{name:'Turn off schedule',exact:true}).waitFor();
  assert(await page.getByRole('region',{name:'Schedule status'}).innerText().then(t=>t.includes('on · every 60 minutes')));
  const shots=resolve(process.env.PROTO_BROWSER_ARTIFACTS || '.test-artifacts/treasury-ui');mkdirSync(shots,{recursive:true});
  await page.screenshot({path:resolve(shots,'desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile overflow');
  await page.screenshot({path:resolve(shots,'mobile.png'),fullPage:true});
  assert.equal(await page.getByRole('link',{name:'Set targets and schedule',exact:true}).getAttribute('href'),'/a/treasury/automations');
  await page.getByRole('link',{name:'Edit policy',exact:true}).waitFor();
  await page.getByRole('link',{name:'Set targets and schedule',exact:true}).click();
  await page.getByRole('heading',{name:'Targets and schedule',exact:true}).waitFor();
  assert.equal(await page.getByText('Manual actions',{exact:true}).count(),0,'manual actions live on overview only');
  await page.getByRole('link',{name:'Back to overview',exact:true}).click();
  await page.getByRole('heading',{name:'Rebalance',exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  await context.close();
  const publicContext=await browser.newContext({viewport:{width:390,height:844}});
  const pub=await open(publicContext,'/',{public:true});
  await pub.page.getByRole('heading',{name:/Your treasury.*Your limits/}).waitFor();
  assert.deepEqual(pub.calls,[],'public page never reads private records');
  assert.equal(await pub.page.getByRole('region',{name:'Treasury owner',exact:true}).count(),0,'public entry must not disclose an owner observation');
  assert.equal(await pub.page.locator('details').count(),1,'progress is the only disclosure');
  const resources=pub.page.getByRole('navigation',{name:'NEAR Intents resources'}).getByRole('link');
  assert.equal(await resources.count(),6);
  assert.equal(await pub.page.getByRole('link',{name:'OpenAPI spec (opens in a new tab)',exact:true}).getAttribute('href'),'https://api.demo.agentsonintents.com/openapi.json');
  for(const link of await resources.all()){assert.equal(await link.getAttribute('target'),'_blank');assert.equal(await link.getAttribute('data-slot'),'button');}
  assert.equal(await pub.page.locator('header').getByRole('button',{name:'Connect wallet',exact:true}).count(),1);
  assert.equal(await pub.page.locator('details[open]').count(),0,'progress starts collapsed');
  await pub.page.screenshot({path:resolve(shots,'landing-mobile.png'),fullPage:true});
  await pub.page.setViewportSize({width:1280,height:900});
  await pub.page.screenshot({path:resolve(shots,'landing-desktop.png'),fullPage:true});
  await publicContext.close();
}
async function treasuryOwnerIdentity(browser, root) {
  const { budget, setup, overview } = workspaceEvidence({policyDetails:true, grants:true});
  const longOwner = 'a'.repeat(59) + '.near';
  for (const scenario of [
    { name: 'dao', owner: {type:'near',account_id:'dao-signer.near'}, dao: {id:'agentic.sputnik-dao.near',funded:true,owner:{type:'near',account_id:'dao-signer.near'}}, label:'agentic.sputnik-dao.near (by proposal)' },
    { name: 'long-wallet', owner: {type:'near',account_id:longOwner}, dao:null, label:longOwner },
    { name: 'unavailable', owner:null, dao:null, label:"the owner's wallet" },
  ]) {
    const open = workspaceOpener(root, {budget, values: () => ({
      setup:{...setup,executor:true,owner:scenario.owner,dao:scenario.dao},overview:overview('treasury'),treasury:null,
      unresolved:[],'owner/actions':[],'autopilot/get':{on:false,everyMin:60,maxUsd:10},
    })});
    const context = await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
    const {page,calls,errors} = await open(context,'/a/treasury/');
    const identity = page.getByRole('region',{name:'Treasury owner',exact:true});
    await identity.getByText(scenario.label,{exact:true}).waitFor();
    for (const width of [320,390,1280]) {
      await page.setViewportSize({width,height:900});
      assert(await identity.isVisible(),`${scenario.name}: owner stays visible at ${width}px`);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${scenario.name}: no overflow at ${width}px`);
      if (width !== 320) {
        const shots=resolve(process.env.PROTO_BROWSER_ARTIFACTS || '.test-artifacts/treasury-ui');mkdirSync(shots,{recursive:true});
        await page.screenshot({path:resolve(shots,`owner-${scenario.name}-${width}.png`),fullPage:false});
      }
    }
    assert.deepEqual(errors,[]);
    assert(!calls.some(method=>['executePlan','sweep','rebalance','autopilot/enable','owner/prepare'].includes(method)),'identity inspection must not act');
    await context.close();
  }
}
runTask([treasuryOnly, treasuryOwnerIdentity]);
