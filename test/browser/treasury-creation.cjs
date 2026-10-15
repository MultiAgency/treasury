const {runTask}=require('./fixtures/task.cjs');
const assert=require('node:assert/strict');
const {join,resolve}=require('node:path');
const {mkdirSync}=require('node:fs');
async function treasuryCreation(browser,root){
 for(const kind of ['wallet','dao']){
  const page=await browser.newPage({viewport:{width:kind==='wallet'?1280:390,height:900},reducedMotion:'reduce'});page.setDefaultTimeout(8000);
  await page.addInitScript(()=>{
   localStorage.setItem('member:selected-wallet:mainnet','fixture-wallet');
   window.walletConnects=0;
   const accounts=[{accountId:'owner.near',publicKey:'ed25519:11111111111111111111111111111111'}];
   const wallet={manifest:{id:'fixture-wallet',name:'Offline wallet',features:{signMessage:true,signDelegateActions:true},permissions:{}},getAccounts:async()=>accounts,signIn:async()=>{window.walletConnects++;return accounts},signOut:async()=>{},signMessage:async()=>{throw Error('Unexpected signing')},signAndSendTransaction:async()=>{throw Error('Unexpected onchain action')}};
   window.addEventListener('near-selector-ready',()=>window.dispatchEvent(new CustomEvent('near-wallet-injected',{detail:wallet})));
  });
  const name='t-aaaaaaaaaaaaaaaaaaaa',owner=kind==='wallet'?'owner.near':'team.sputnik-dao.near',requests=[],errors=[];
  let registered=false,prepared;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const {hostname,pathname:p}=new URL(route.request().url());if(hostname!=='frontend.test')return route.abort();
   if(p==='/gw/me')return route.fulfill({json:{selfServiceTreasury:true,agents:registered?[{name,owner,area:'treasury',dao:kind==='dao'}]:[],invoices:null,viewer:{account:'owner.near',access:registered?{[name]:{canSign:kind==='wallet',canPropose:kind==='dao',canVote:kind==='dao',canExecute:true,canManage:true}}:{}}}});
   if(p==='/gw/treasuries'){
    requests.push(p);assert.deepEqual(route.request().postDataJSON(),kind==='wallet'?{kind}:{kind,dao:owner});registered=true;return route.fulfill({json:{name}});
   }
   if(p.includes('/rpc/')){
    const method=p.split('/rpc/')[1];requests.push(method);
    if(method==='owner/prepare'){prepared=route.request().postDataJSON().json;return route.fulfill({status:400,json:{json:{defined:false,code:'BAD_REQUEST',message:'Offline check stopped before signing.'}}});}
    const values={setup:{executor:true,agentId:null,wallet:null,owner:null,grant:null,dao:kind==='dao'?{id:owner,funded:true,owner:{type:'near',account_id:'dao-signer',public_key:'fixture'}}:null},'owner/actions':[]};
    assert(method in values,`Unexpected RPC ${method}`);return route.fulfill({json:{json:values[method]}});
   }
   return route.fulfill({path:p.startsWith('/static/')?join(root,p):join(root,'index.html'),contentType:p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':p.startsWith('/static/')?'font/woff2':'text/html'});
  });
  await page.goto('http://frontend.test/');await page.getByRole('heading',{name:'New treasury',exact:true}).waitFor();
  assert.deepEqual(requests,[]);
  const walletButton=page.getByRole('button',{name:'Wallet: owner.near',exact:true});
  await walletButton.waitFor();
  await walletButton.click();await page.getByRole('menuitem',{name:'Disconnect',exact:true}).waitFor();await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button',{name:'Connect wallet',exact:true}).count(),0);
  if(kind==='dao'){await page.getByRole('radio',{name:'A DAO',exact:true}).click();await page.getByLabel('DAO account').fill(owner);}
  const out=resolve('.impeccable/review');mkdirSync(out,{recursive:true});
  await page.screenshot({path:join(out,kind==='wallet'?'create-desktop.png':'create-mobile.png'),fullPage:true});
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  const create=page.getByRole('button',{name:kind==='dao'?'Propose creating the agent':'Create agent',exact:true});
  await create.waitFor();
  await require('@playwright/test').expect(create).toBeEnabled();
  assert.equal(await page.getByRole('heading',{name:'Setup status',exact:true}).count(),0);
  assert.equal(await page.getByText('Payout agent.',{exact:true}).count(),0);
  assert.equal(await page.locator('header').count(),1,'keep only the logo and wallet header');
  assert.equal(await page.getByRole('button',{name:'Connect wallet',exact:true}).count(),0,'member connection also serves owner signing');
  assert.equal(await page.evaluate(()=>window.walletConnects),0,'restoring a supported member wallet must not reconnect');
  assert.equal(await page.getByRole('navigation',{name:'Treasury',exact:true}).count(),0);
  await page.screenshot({path:join(out,kind==='wallet'?'single-header-desktop.png':'single-header-mobile.png'),fullPage:true});
  assert(!requests.includes('owner/prepare'),'registration must not create or sign the agent');
  await create.click();
  await page.getByText('Offline check stopped before signing.',{exact:true}).first().waitFor();
  assert.equal(prepared.signer,kind);assert.equal(prepared.action.role,'treasury');
  if(kind==='wallet')assert.equal(prepared.action.owner.account_id,'owner.near');else assert.equal(prepared.action.owner,undefined);
  assert(!requests.includes('owner/submit'));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);await page.close();
 }
}
runTask([treasuryCreation]);
