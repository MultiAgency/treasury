import assert from 'node:assert/strict';
import {createServer as httpServer,                    } from 'node:http';

import {once} from 'node:events';
import {join,resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
import {chromium,         } from '../web/node_modules/playwright/index.mjs';
import {createServer} from '../apps/server/src/http.ts';
import {createPlatform} from '../apps/server/src/platform.ts';
import {createCredential} from '../apps/server/src/credential.ts';
import {createSessions} from '../apps/server/src/sessions.ts';
import {createSignIn} from '../apps/server/src/signin.ts';
import {createDaoRequests} from '../apps/server/src/dao-requests.ts';
import {standInDaos} from '../apps/server/src/dao.ts';
import {loadPage} from '../apps/server/src/page.ts';

export async function browserJourney({gateway,credential,dir,owner,agent,proposal,restartProvider}                                                                                                                       ){
 let handle                =(_req,res)=>res.writeHead(503).end();
 const server=httpServer((req,res)=>handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://localhost:${(server.address()               ).port}`;
 const file=join(dir,'treasury-credential');writeFileSync(file,credential,{mode:0o600});
 const lookup=async(account       ,key       )=>account===owner.accountId&&key===owner.publicKey?'full'         :'none'         ;
 handle=createServer({platform:createPlatform({origin:gateway,credential:createCredential(file),timeoutMs:15000}),signIn:createSignIn({recipient:new URL(origin).host,ttlMs:300000,perMinute:100,keyLookup:lookup}),sessions:createSessions({idleMs:1800000,maxMs:43200000}),publicOrigin:origin,deployment:'synthetic-journey',trustedProxyHops:0,ownerRequestsPerMinute:1000,audit:{append:async()=>{}},consentsPerDay:100,daoFilingsPerDay:100,keyLookup:lookup,daos:standInDaos({}),daoRequests:await createDaoRequests(join(dir,'dao-requests.json')),page:await loadPage(resolve('web/dist'))});
 const browser=await chromium.launch();let page               ;const errors         =[];
 try{
  const context=await browser.newContext({reducedMotion:'reduce'});
  await context.route('**/*',route=>{
   const url=new URL(route.request().url());
   if(url.origin===origin||url.protocol==='data:')return route.continue();
   if(url.pathname.endsWith('/manifest.json'))return route.fulfill({json:{version:'1.0.0',wallets:[]}});
   return route.abort();
  });
  await context.exposeFunction('__syntheticSign',(payload    )=>owner.sign(payload));
  // tsx preserves function names with this helper; Playwright serializes the injected function alone.
  await context.addInitScript({content:'globalThis.__name = (value) => value;'});
  await context.addInitScript(({account,publicKey})=>{
   const accounts=[{accountId:account,publicKey}];
   const wallet={manifest:{id:'synthetic-owner',name:'Synthetic owner wallet',type:'injected',icon:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',features:{signMessage:true}},signIn:async()=>accounts,getAccounts:async()=>accounts,signOut:async()=>{},signAndSendTransaction:async()=>{throw Error('Real transactions are disabled in synthetic tests');},signMessage:(payload    )=>(window       ).__syntheticSign({...payload,nonce:btoa(String.fromCharCode(...new Uint8Array(payload.nonce)))})};
   window.addEventListener('near-selector-ready',()=>window.dispatchEvent(new CustomEvent('near-wallet-injected',{detail:wallet})));
   localStorage.setItem('proposals:selected-wallet:mainnet','synthetic-owner');
  },{account:owner.accountId,publicKey:owner.publicKey});
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.goto(`${origin}/agents/${agent}/proposals/${proposal}`);
  await page.getByRole('button',{name:'Sign in with wallet'}).click();
  await page.getByText('Synthetic owner wallet',{exact:true}).click({timeout:10000});
  await page.getByRole('button',{name:'Approve',exact:true}).click();
  await page.getByRole('dialog',{name:'Approve this proposal?'}).getByRole('button',{name:'Sign and approve'}).click();
  await page.getByRole('button',{name:'Review execution',exact:true}).click();
  let interrupted=false;
  await context.route(`**/api/agents/${agent}/proposals/${proposal}/execute`,async route=>{
   const response=await route.fetch();assert.equal(response.status(),200);
   await restartProvider();interrupted=true;await route.abort('failed');
  },{times:1});
  await page.getByRole('dialog',{name:'Execute this proposal?'}).getByRole('button',{name:'Execute swaps'}).click();
  await page.getByText('Executed',{exact:true}).waitFor();
  assert.equal(interrupted,true);
  await page.reload();
  await page.getByText('Executed',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Review execution',exact:true}).count(),0);
  if (process.env.STAGING_FREEZE_BOTTOM === 'true') {
    assert.equal(await page.getByRole('region',{name:'Emergency stop'}).evaluate(element => Boolean(element.compareDocumentPosition(document.querySelector('[aria-labelledby="state-title"]')) & Node.DOCUMENT_POSITION_PRECEDING)),true);
  }
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.keyboard.press('Tab');
 }catch(error){throw new Error(String(error)+' '+JSON.stringify(errors)+'\n'+(page?await page.locator('body').innerText():''));}finally{await browser.close();await new Promise      (r=>server.close(()=>r()));}
}
