const { rpcValue } = require('./fixtures/rpc.cjs');
/** Offline browser regressions. Every request is fulfilled by a fixture or aborted.
 * PLAYWRIGHT_MODULE=/path/to/playwright-core BROWSER_EXECUTABLE=/path/to/chrome
 * node test/browser/recovery-gaps.cjs /path/to/build
 */
const { openWorkspaceNavigation } = require('./fixtures/navigation.cjs');
const assert = require('node:assert/strict');
const { chromium } = require('./fixtures/browser.cjs');
const root = require('node:path').resolve(process.argv[2] || 'web/dist');
const results = [];
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.BROWSER_EXECUTABLE});
  try {
    for (const scenario of ['treasury-submitted','treasury-prepared','treasury-succeeded','treasury-read-error','treasury-ready','wallet-rejected','wallet-approved','overview-error','treasury-error']) {
      if (process.env.SCENARIO && process.env.SCENARIO !== scenario) continue;
      const treasury = scenario.startsWith('treasury-') && scenario !== 'treasury-error';
      const page = await browser.newPage({viewport:{width:390,height:900}});
      page.setDefaultTimeout(5000);
      const at = new Date(Date.now()-3600000).toISOString();
      const expiresAt = new Date(Date.now()+3600000).toISOString();
      const request = {asset:'usdc',amount:'123456789',recipient:'payee.near',confidential:true};
      const writes=[];
      await page.route('**/*', async route => {
        const u=new URL(route.request().url()), p=u.pathname;
        if(u.hostname!=='frontend.test') return route.abort();
        if(p==='/gw/me') return route.fulfill({json:{agents:[{name:'payables',owner:'owner.near',dao:false}],invoices:null,viewer:{account:'owner.near',access:{payables:{canSign:true,canPropose:true,canVote:true,canExecute:true,canManage:true}}}}});
        if(p.includes('/rpc/')) {
          const method=p.split('/rpc/')[1];
          if(['owner/prepare','owner/submit','pay','recover'].includes(method)) writes.push(method);
          if((scenario==='overview-error' && method==='overview') || (scenario==='treasury-error' && method==='treasury/get') || (scenario==='treasury-read-error' && method==='owner/actions')) return route.fulfill({status:500,json:{json:{defined:false,code:'INTERNAL_SERVER_ERROR',message:'Fixture read unavailable'}}});
          const held=treasury || scenario.startsWith('wallet-');
          const values={
            get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup:{executor:false,agentId:'fixture',wallet:'agent.near',owner:{type:'near',account_id:'owner.near'},grant:{label:'payout',expiresAt},dao:treasury?{id:'fixture.sputnik-dao.near',owner:{account_id:'owner.near'}}:null},
            overview:{agentId:'fixture',digest:'fixture',notInForce:null,agreed:[],unmanaged:[],target:{usdc:1},rebalance:{minLegUsd:1,maxCostBps:100},book:[{asset:'usdc',symbol:'USDC',decimals:6,public:'0',confidential:'10000000',usd:10,price:1}],policy:{policy:{actions:treasury?['swap','transfer']:['transfer'],frozen:false,destinations:{mode:'only',list:[]},assets:'any',budget:{},limits:{}},usage:{budget:{}},cooldowns:{}}},
            'treasury/get':null,held:held?[{at,kind:'remote',request,correlationId:'payment',approvalId:'approval'}]:[],unresolved:[],activity:[{at,kind:'payout',request,correlationId:'recorded-payment',status:'PROCESSING'}],'inbox/list':[],'agreements/list':[],'owner/pending':[],
            'owner/actions':scenario==='treasury-ready'?[]:[{correlationId:'owner-record',type:'approval_vote',signer:treasury?'dao':'wallet',stage:scenario==='treasury-prepared'?'prepared':scenario==='treasury-succeeded'||scenario.startsWith('wallet-')?'settled':'submitted',expiresAt:scenario==='treasury-prepared'?expiresAt:'2020-01-01T00:00:00Z',ownerSucceeded:scenario==='treasury-succeeded'||scenario.startsWith('wallet-'),status:scenario==='wallet-rejected'?'FAILED':null,payment:{correlationId:'payment',verdict:scenario==='wallet-rejected'?'reject':'approve'}}],
            paymentHistory:{items:[],complete:true},
            paymentStatus:{status:scenario==='wallet-rejected'?'FAILED':scenario==='wallet-approved'?'SUCCESS':'PENDING_APPROVAL',failureCode:null,createdAt:at,updatedAt:at,request,approvalId:'approval',expiresAt,detailError:null},
            'autopilot/get':{on:false,everyMin:60,maxUsd:10},'autopilot/evidence':{ticks:[]},'strategy/get':{},invoices:[],ledger:[],reconcileBooks:[],
          };
          return route.fulfill({json:{json:rpcValue(values, method)}});
        }
        if(p.startsWith('/static/')) return route.fulfill({path:root+p,contentType:p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':'font/woff2'});
        return route.fulfill({path:root+'/index.html',contentType:'text/html'});
      });
      try {
        await page.goto('http://frontend.test/a/payables/'+(scenario.endsWith('-error')&&!treasury?'activity':scenario.startsWith('wallet-')?'follow/payment?payment=payment':''));
        if (treasury) {
          const approval=page.getByRole('button',{name:'File proposal and vote',exact:true});
          await approval.waitFor();
          if(scenario==='treasury-ready') assert.equal(await approval.isEnabled(),true);
          else {
            if(scenario==='treasury-read-error') await page.getByText('Fixture read unavailable',{exact:false}).first().waitFor();
            else await page.getByRole('link',{name:'Review the existing owner action',exact:true}).waitFor();
            assert.equal(await approval.isEnabled(),false);
            assert.equal(await page.getByRole('button',{name:'Propose rejection',exact:true}).isEnabled(),false);
            await page.reload(); await approval.waitFor();
            assert.equal(await approval.isEnabled(),false,'Reload must preserve recovery gating');
          }
        } else if(scenario.startsWith('wallet-')) {
          await page.getByText('Payment history and public visibility',{exact:true}).click();
          const verb=scenario==='wallet-rejected'?'Rejected':'Approved';
          await page.getByRole('heading',{name:verb+" by the owner's wallet",exact:true}).waitFor();
          assert.doesNotMatch(await page.locator('body').innerText(),/No proposal or wallet (approval|decision) evidence was recovered/);
        } else {
          await page.getByRole('heading',{name:'Owner actions',exact:true}).waitFor({timeout:15000});
          await page.locator('#owner-owner-record').waitFor();
          await page.locator('#operation-recorded-payment').waitFor();
          await page.getByRole('heading',{name:'Operation history',exact:true,level:2}).waitFor();
          await openWorkspaceNavigation(page);
          assert.equal(await page.getByRole('link',{name:'Activity',exact:true}).count()>0,true);
          if(await page.getByRole('button',{name:'Close',exact:true}).isVisible()) await page.getByRole('button',{name:'Close',exact:true}).click();
          assert.equal(await page.getByRole('button',{name:/Run now|Sign approval|Check operation outcomes/}).count(),0,'Fallback is read-only');
        }
        if (scenario === 'treasury-submitted' || scenario === 'treasury-succeeded') {
          await page.getByRole('link', { name: 'Review the existing owner action', exact: true }).click();
          await page.getByRole('link', { name: 'Follow the payment outcome', exact: true }).click();
          await page.getByRole('heading', { name: 'Follow this payment', exact: true, level: 2 }).waitFor();
          assert.equal(new URL(page.url()).searchParams.get('payment'), 'payment');
          assert.doesNotMatch(await page.locator('body').innerText(), /This page isn't part of/);
          await page.reload();
          await page.getByRole('heading', { name: 'Follow this payment', exact: true, level: 2 }).waitFor();
        }
        assert.deepEqual(writes,[]);
        results.push({scenario,pass:true});
      } catch(e) {results.push({scenario,pass:false,error:e.message});}
      await page.close();
    }
  } finally {await browser.close();}
  console.log(JSON.stringify(results,null,2)); process.exitCode=results.length > 0 && results.every(r=>r.pass)?0:1;
})();
