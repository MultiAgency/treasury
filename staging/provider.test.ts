import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {once} from 'node:events';
import {wallet} from '../apps/server/test/fakes.ts';
import {SyntheticStore} from './store.mjs';
import {providerServer} from './provider.ts';

test('HTTP create verifies owner signature, refuses changed terms, and retains agent and consumed intent after restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'synthetic-http-')),path=join(dir,'state.sqlite');
 const owner=wallet('owner.near');let store=new SyntheticStore(path),server:Server;
 const start=async()=>{server=providerServer({store,lookup:async(a,k)=>a===owner.accountId&&k===owner.publicKey?'full':'none',recipient:'synthetic.test',controlToken:'x'.repeat(32)});server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;};
 const stop=async()=>{await new Promise<void>(r=>server.close(()=>r()));store.close();};
 let base=await start();
 const post=async(route:string,body:any)=>{const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,value:await r.json()};};
 try{
  const prepared=await post('/v1/generate-intent',{type:'agent_create',owner:{type:'near',account_id:owner.accountId,public_key:owner.publicKey},policy:{frozen:false,owner_approval:false,assets:'any',actions:['swap']}});
  assert.equal(prepared.status,200);
  const payload=prepared.value.intent.payload,signed=owner.sign(payload);
  const body={correlation_id:prepared.value.correlation_id,signed_data:{standard:'nep413',payload,public_key:signed.publicKey,signature:signed.signature}};
  assert.equal((await post('/v1/submit-intent',{...body,signed_data:{...body.signed_data,payload:{...payload,message:'changed'}}})).status,400);
  assert.equal((await post('/v1/submit-intent',body)).status,200);
  const status=await (await fetch(base+`/v1/status?correlation_id=${body.correlation_id}`)).json();
  assert.equal(status.status,'SUCCESS');const agent=status.details.agent_id;
  const token='ngt_'+'a'.repeat(43),commitment=createHash('sha256').update(token).digest('hex');
  const grant=await post('/v1/generate-intent',{type:'grant_issue',agent_id:agent,credential:commitment,expires_at:new Date(Date.now()+60000).toISOString()});
  assert.equal(grant.status,200);
  const grantPayload=grant.value.intent.payload,grantSignature=owner.sign(grantPayload);
  assert.equal((await post('/v1/submit-intent',{correlation_id:grant.value.correlation_id,signed_data:{standard:'nep413',payload:grantPayload,public_key:grantSignature.publicKey,signature:grantSignature.signature}})).status,200);
  const usdc='nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
  const fund={agent,asset:usdc,amount:'10000000',requestId:'fund-1'};
  assert.equal((await post('/__staging/fund',fund)).status,401);
  for(let i=0;i<2;i++)assert.equal((await fetch(base+'/__staging/fund',{method:'POST',headers:{authorization:'Bearer '+'x'.repeat(32),'content-type':'application/json'},body:JSON.stringify(fund)})).status,200);
  const swap={origin_asset:usdc,destination_asset:'nep141:wrap.near',amount:'1000000',min_amount_out:'500000000000000000000000',confidential:true};
  assert.equal((await post(`/v1/agents/${agent}/swap`,swap)).status,403);
  const execute=async()=>fetch(base+`/v1/agents/${agent}/swap`,{method:'POST',headers:{'x-grant-token':token,'idempotency-key':'swap-1','content-type':'application/json'},body:JSON.stringify(swap)});
  assert.equal((await execute()).status,200);
  assert.equal((await execute()).status,200);
  const settled=await(await fetch(base+'/v1/status?correlation_id=swap-1')).json();
  assert.equal(settled.status,'SUCCESS');
  assert.equal(store.read('agent',agent).balances[usdc],'9000000');

  await stop();store=new SyntheticStore(path);base=await start();
  assert.equal((await post('/v1/submit-intent',body)).status,409);
  const retained=await (await fetch(base+`/v1/agents/${agent}`)).json();
  assert.equal(retained.owner.account_id,owner.accountId);assert.equal(retained.id,agent);assert.equal(retained.balances[usdc],'9000000');
  if(process.env.STAGING_PLATFORM_SOURCE){
   const {spawn}=await import('node:child_process');
   const {pathToFileURL}=await import('node:url');
   const envFile=join(dir,'isolated.env');writeFileSync(envFile,`AGENT_ID=${agent}\n`,{mode:0o600});
   const script=`
    const original=globalThis.fetch;
    globalThis.fetch=(input,init)=>{
     const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
     if(url.origin===${JSON.stringify(base)})return original(input,init);
     if(url.hostname==='tx.main.fastnear.com'&&url.pathname==='/v0/transactions')return original(${JSON.stringify(base)}+'/__staging/transactions',init);
     if(url.hostname==='transfers.main.fastnear.com'&&url.pathname==='/v0/transfers')return original(${JSON.stringify(base)}+'/__staging/transfers',init);
     throw Error('Isolated Books test blocked external request');
    };
    const {reconcileBooks}=await import(${JSON.stringify(pathToFileURL(join(process.env.STAGING_PLATFORM_SOURCE,'src/ledger.ts')).href)});
    console.log(JSON.stringify(await reconcileBooks()));
   `;
   const child=spawn(process.execPath,['--import',process.env.STAGING_TSX_LOADER!,'--input-type=module','-e',script],{cwd:dir,env:{PATH:process.env.PATH,ENV_FILE:envFile,NEAR_INTENTS_AGENT_API_KEY:'synthetic-test-only',NEAR_INTENTS_AGENT_API_URL:base,AUTOPILOT:'off'},stdio:['ignore','pipe','pipe']});
   let output='',errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);
   const [code]=await once(child,'exit');assert.equal(code,0,errors);
   const books=JSON.parse(output.trim());assert.ok(books.length>=2);
   for(const row of books){assert.equal(row.public.drift,'0');assert.equal(row.confidential.unattributed,'0');assert.equal(row.confidential.status,'matched');}
  }
  if(process.env.STAGING_PROVIDER_SDK){
   const {AgentApi}=await import(process.env.STAGING_PROVIDER_SDK);
   const sdk=new AgentApi({apiKey:'synthetic-test-only',baseUrl:base});
   assert.equal((await sdk.getAgent(agent)).id,agent);
   assert.equal((await sdk.getWallet(agent)).wallet_id,retained.wallet.wallet_id);
   assert.equal((await sdk.getPolicy(agent)).status,'APPLIED');
   assert.equal((await sdk.getHistory(agent)).data.length,2);
   assert.equal((await sdk.listGrants(agent)).length,1);
   assert.equal((await sdk.getTokens()).length,3);
   assert.equal((await sdk.getStatus('swap-1')).status,'SUCCESS');
  }
assert.equal((await(await fetch(base+'/v1/status?correlation_id=swap-1')).json()).status,'SUCCESS');
 }finally{await stop();rmSync(dir,{recursive:true,force:true});}
});

test('starting funds credit a new agent once, as a synthetic deposit in its history',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'synthetic-starting-')),store=new SyntheticStore(join(dir,'state.sqlite')),owner=wallet('owner.near');
 const usdc='nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
 const server=providerServer({store,lookup:async()=>'full',recipient:'synthetic.test',controlToken:'x'.repeat(32),startingFunds:{asset:usdc,amount:'10000000'}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 const post=async(route:string,body:any)=>{const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,value:await r.json()};};
 try{
  const prepared=await post('/v1/generate-intent',{type:'agent_create',owner:{type:'near',account_id:owner.accountId,public_key:owner.publicKey},policy:{frozen:false,owner_approval:false,assets:'any',actions:['swap']}});
  const payload=prepared.value.intent.payload,signed=owner.sign(payload);
  const body={correlation_id:prepared.value.correlation_id,signed_data:{standard:'nep413',payload,public_key:signed.publicKey,signature:signed.signature}};
  assert.equal((await post('/v1/submit-intent',body)).status,200);
  assert.equal((await post('/v1/submit-intent',body)).status,409);
  const agent=(await (await fetch(base+`/v1/status?correlation_id=${body.correlation_id}`)).json()).details.agent_id;
  assert.equal(store.read('agent',agent).balances[usdc],'10000000');
  const history=await (await fetch(base+`/v1/agents/${agent}/history`)).json();
  assert.deepEqual(history.data.map((row:any)=>[row.type,row.details.deposit_tx_hash]),[['deposit',`synthetic-starting-${agent}`]]);
 }finally{await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(dir,{recursive:true,force:true});}
});
