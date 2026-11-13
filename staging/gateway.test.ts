import {randomBytes} from 'node:crypto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readdirSync,readFileSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {AddressInfo} from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {pathToFileURL} from 'node:url';
import {wallet} from '../apps/server/test/fakes.ts';
import {SyntheticStore} from './store.mjs';
import {providerServer} from './provider.ts';
import {appClient,setupMessage,consentMessage,proposalText} from '../apps/server/node_modules/@multiagency/sdk/dist/contract/index.js';

const source=process.env.STAGING_PLATFORM_SOURCE,loader=process.env.STAGING_TSX_LOADER;
test('actual gateway reserves an isolated treasury using the replacement ownership RPC', {skip:!source||!loader,timeout:60000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'synthetic-gateway-')),owner=wallet('owner.near');
 let store=new SyntheticStore(join(dir,'provider.sqlite'));
 const providerOptions={store,recipient:'synthetic.test',controlToken:'x'.repeat(32),lookup:async(a:string,k:string)=>a===owner.accountId&&k===owner.publicKey?'full':'none',chainRead:async (body:any)=>{
  if(body.method==='query'&&body.params.request_type==='view_access_key'&&body.params.account_id===owner.accountId&&body.params.public_key===owner.publicKey)return {jsonrpc:'2.0',id:body.id,result:{permission:'FullAccess',nonce:1,block_height:1,block_hash:'11111111111111111111111111111111'}};
  if(body.method==='query'&&body.params.method_name==='get_policy')return {jsonrpc:'2.0',id:body.id,error:{name:'HANDLER_ERROR',cause:{name:'UNKNOWN_ACCOUNT',info:{requested_account_id:body.params.account_id}},code:-32000,message:'Server error'}};
  throw Error('Unsupported test ownership query');
 }};
 let provider=providerServer(providerOptions);
 const requests:string[]=[];provider.on('request',req=>{let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>requests.push(req.method+' '+req.url+' '+text));});
 provider.listen(0,'127.0.0.1');await once(provider,'listening');const providerBase=`http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
 const probe=createServer();probe.listen(0,'::1');await once(probe,'listening');const port=(probe.address() as AddressInfo).port;await new Promise<void>(r=>probe.close(()=>r()));
 const host=`localhost:${port}`,base=`http://${host}`;
 const guard=join(dir,'isolated-network.cjs');
 copyFileSync(new URL('./gateway-network.cjs',import.meta.url),guard);

 writeFileSync(join(dir,'dashboard.json'),JSON.stringify({host,headless:true,appSetup:['treasury'],agents:[]}));
 const {AppCredentials}=await import(pathToFileURL(join(source!,'src/gateway/app-access.ts')).href);
 const issued=new AppCredentials(join(dir,'.app-access')).issue({deployment:'synthetic-journey',host,days:1,label:'Isolated local test'});
 const child=spawn(process.execPath,['--import',loader!,join(source!,'src/gateway/server.ts')],{cwd:dir,env:{PATH:process.env.PATH,NODE_ENV:'test',NODE_OPTIONS:`--require ${guard}`,PORT:String(port),SESSION_SECRET:'isolated-gateway-session-secret-32-characters',NEAR_INTENTS_AGENT_API_KEY:'synthetic-only',NEAR_INTENTS_AGENT_API_URL:providerBase,NEAR_RPC_URL:providerBase+'/chain',AUTOPILOT:'off'},stdio:['ignore','pipe','pipe']});
 let logs='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>logs+=chunk);
 try{
  const deadline=Date.now()+20000;
  while(!logs.includes('on port')){if(child.exitCode!==null||Date.now()>deadline)throw Error(logs);await new Promise(r=>setTimeout(r,50));}
  const app=appClient({base:base as `http://${string}`,credential:issued.token});
  const nonce=await app.consents.nonce();assert.ok(nonce.ok,JSON.stringify(nonce));
  const message=setupMessage({host,deployment:'synthetic-journey',organization:'owner--near',owner:owner.accountId,area:'treasury',expiresAt:new Date(Date.now()+300000).toISOString()});
  const signed=owner.sign({message,recipient:host,nonce:nonce.value.nonce});
  const reserved=await app.setup({message,nonce:nonce.value.nonce,publicKey:signed.publicKey,signature:signed.signature});
  assert.ok(reserved.ok,JSON.stringify(reserved));
  const listed=await app.consents.list('owner--near');assert.ok(listed.ok,JSON.stringify(listed));
  const readyUntil=Date.now()+15000;
  while(true){const current=await app.identity(reserved.value.agent);if(current.ok)break;if(Date.now()>readyUntil)throw Error(JSON.stringify(current)+' '+logs);await new Promise(r=>setTimeout(r,100));}
  const agent=app.agent('owner--near',reserved.value.agent);
  const prepared=await agent.call('owner/prepare',{action:{type:'agent_create',role:'treasury',owner:{type:'near',account_id:owner.accountId,public_key:owner.publicKey}},signer:'wallet'});
  assert.ok(prepared.ok,JSON.stringify(prepared)+' '+JSON.stringify(requests)+' '+logs+' '+readdirSync(join(dir,'.hosted')).filter(x=>x.endsWith('.log')).map(x=>readFileSync(join(dir,'.hosted',x),'utf8')).join('\n'));
  assert.equal(prepared.value.intent?.standard,'nep413',JSON.stringify(prepared));
  const intent=prepared.value.intent!;
  const signedIntent=owner.sign(intent.payload);
  const submitted=await agent.call('owner/submit',{correlationId:prepared.value.correlationId,signedData:{...intent,public_key:signedIntent.publicKey,signature:signedIntent.signature}});
  assert.ok(submitted.ok,JSON.stringify(submitted)+" "+JSON.stringify(requests)+" "+logs);
  const identity=await app.identity(reserved.value.agent);assert.ok(identity.ok,JSON.stringify(identity));assert.ok(identity.value.agentId);
  const nextNonce=await app.consents.nonce();assert.ok(nextNonce.ok);
  const consent=consentMessage({host,deployment:'synthetic-journey',organization:'owner--near',owner:owner.accountId,agent:reserved.value.agent,agentId:identity.value.agentId,scopes:['read','treasury','owner'],expiresAt:new Date(Date.now()+3600000).toISOString()});
  const consentSignature=owner.sign({message:consent,recipient:host,nonce:nextNonce.value.nonce});
  const connected=await app.consents.submit({message:consent,nonce:nextNonce.value.nonce,publicKey:consentSignature.publicKey,signature:consentSignature.signature});assert.ok(connected.ok,JSON.stringify(connected));
  const strategy=await agent.call('strategy/get');assert.ok(strategy.ok,JSON.stringify(strategy));
  const grant=await agent.call('owner/prepare',{action:{type:'grant_issue',label:'treasury',expectedStrategyDigest:strategy.value.digest},signer:'wallet'});assert.ok(grant.ok,JSON.stringify(grant));
  const grantIntent=grant.value.intent!;assert.equal(grantIntent.standard,'nep413');const grantSigned=owner.sign(grantIntent.payload);
  const authorized=await agent.call('owner/submit',{correlationId:grant.value.correlationId,signedData:{...grantIntent,public_key:grantSigned.publicKey,signature:grantSigned.signature}});assert.ok(authorized.ok,JSON.stringify(authorized));
  const usdc='nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',near='nep141:wrap.near';
  const funded=await fetch(providerBase+'/__staging/fund',{method:'POST',headers:{authorization:'Bearer '+'x'.repeat(32),'content-type':'application/json'},body:JSON.stringify({agent:identity.value.agentId,asset:usdc,amount:'10000000',requestId:'isolated-gateway-funding'})});assert.equal(funded.status,200);
  const proposal=await agent.call('proposals/create',{requestId:'isolated-gateway-proposal',legs:[{from:usdc,to:near,amount:'1000000'}],expiresAt:new Date(Date.now()+3600000).toISOString()});assert.ok(proposal.ok,JSON.stringify(proposal)+" "+logs+" "+JSON.stringify(requests.slice(-15)));
  const approvalMessage=proposalText(proposal.value,'approve'),approvalNonce=randomBytes(32).toString('base64'),approvalSignature=owner.sign({message:approvalMessage,recipient:host,nonce:approvalNonce});
  const approved=await agent.call('proposals/approve',{id:proposal.value.id,signed:{message:approvalMessage,nonce:approvalNonce,publicKey:approvalSignature.publicKey,signature:approvalSignature.signature}});assert.ok(approved.ok,JSON.stringify(approved));
  const executed=await agent.call('proposals/execute',{id:proposal.value.id});assert.ok(executed.ok,JSON.stringify(executed));assert.equal(executed.value.state,'executed',JSON.stringify(executed));
  if(process.env.STAGING_BROWSER==='true'){
   const next=await agent.call('proposals/create',{requestId:'isolated-browser-proposal',legs:[{from:usdc,to:near,amount:'1000000'}],expiresAt:new Date(Date.now()+3600000).toISOString()});assert.ok(next.ok,JSON.stringify(next));
   const {browserJourney}=await import('./browser-journey.mjs');
   await browserJourney({gateway:base,credential:issued.token,dir,owner,agent:reserved.value.agent,proposal:next.value.id,restartProvider:async()=>{
    const boundPort=(provider.address() as AddressInfo).port;
    await new Promise<void>(r=>provider.close(()=>r()));store.close();
    store=new SyntheticStore(join(dir,'provider.sqlite'));
    provider=providerServer({...providerOptions,store});provider.listen(boundPort,'127.0.0.1');await once(provider,'listening');
   }});
   assert.equal(store.history(identity.value.agentId).length,2,'interrupted browser execution settles once');
  }



 }finally{
  if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}
  await new Promise<void>(r=>provider.close(()=>r()));store.close();rmSync(dir,{recursive:true,force:true});
 }
});
