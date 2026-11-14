import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readOwnershipQuery,walletLookup} from './ownership.ts';

test('wallet lookup sends only a final access-key query to the pinned read-only RPC',async()=>{
 const lookup=walletLookup(async(url,options)=>{
  assert.equal(url,'https://free.rpc.fastnear.com');
  const request=JSON.parse(String(options?.body));
  assert.equal(request.method,'query');assert.equal(request.params.request_type,'view_access_key');assert.equal(request.params.finality,'final');
  return new Response(JSON.stringify({result:{permission:'FullAccess'}}));
 });
 assert.equal(await lookup('owner.near','ed25519:11111111111111111111111111111111'),'full');
 assert.equal(await lookup('https://another-host','ed25519:111'),'none');
});
test('RPC outages and malformed responses never authorize a wallet',async()=>{
 for(const response of [new Response('{}'),new Response('down',{status:503}),new Response(JSON.stringify({error:{cause:{name:'UNKNOWN_ACCESS_KEY'}}}))]){
  assert.notEqual(await walletLookup(async()=>response)('owner.near','ed25519:11111111111111111111111111111111'),'full');
 }
});

const daoView=(method_name:string,args?:object|string)=>({jsonrpc:'2.0',id:'dao',method:'query',params:{request_type:'call_function',finality:'final',account_id:'agentic.sputnik-dao.near',method_name,
 ...(args!==undefined&&{args_base64:typeof args==='string'?args:Buffer.from(JSON.stringify(args)).toString('base64')})}});
test('DAO policy and proposal views reach the pinned read-only RPC unchanged',async()=>{
 for(const request of [daoView('get_policy'),daoView('get_last_proposal_id',{}),daoView('get_proposals',{from_index:0,limit:100}),daoView('get_proposals',{from_index:4100,limit:1})]){
  const forwarded=await readOwnershipQuery(request,async(url,options)=>{
   assert.equal(url,'https://free.rpc.fastnear.com');
   assert.deepEqual(JSON.parse(String(options?.body)).params,request.params);
   return new Response(JSON.stringify({result:{}}));
  });
  assert.deepEqual(forwarded,{result:{}});
 }
});
test('other contract calls, arguments and unfinalized reads are refused without a request',async()=>{
 const never=async()=>{throw Error('no request expected');};
 for(const request of [daoView('add_proposal',{}),daoView('get_proposal',{id:1}),daoView('get_last_proposal_id',{x:1}),daoView('get_policy','not base64 json'),
  daoView('get_proposals',{from_index:0,limit:101}),daoView('get_proposals',{from_index:-1,limit:10}),daoView('get_proposals',{from_index:0}),daoView('get_proposals',{from_index:0,limit:10,extra:1}),
  {...daoView('get_policy'),params:{...daoView('get_policy').params,finality:'optimistic'}},{method:'broadcast_tx_commit',params:[]}]){
  await assert.rejects(readOwnershipQuery(request,never));
 }
});
const signerKey=(args:object)=>({jsonrpc:'2.0',id:'key',method:'query',params:{request_type:'call_function',finality:'final',account_id:'v1.signer',method_name:'derived_public_key',args_base64:Buffer.from(JSON.stringify(args)).toString('base64')}});
test('the chain status and v1.signer key for a DAO reach the pinned read-only RPC',async()=>{
 for(const request of [{jsonrpc:'2.0',id:'s',method:'status',params:[]},signerKey({path:'agent-owner',predecessor:'agentic.sputnik-dao.near',domain_id:1})]){
  const forwarded=await readOwnershipQuery(request,async(url,options)=>{
   assert.equal(url,'https://free.rpc.fastnear.com');
   const sent=JSON.parse(String(options?.body));
   assert.equal(sent.method,request.method);assert.deepEqual(sent.params,request.params);
   return new Response(JSON.stringify({result:{}}));
  });
  assert.deepEqual(forwarded,{result:{}});
 }
});
test('other v1.signer calls, key arguments and status parameters are refused without a request',async()=>{
 const never=async()=>{throw Error('no request expected');};
 const key={path:'agent-owner',predecessor:'agentic.sputnik-dao.near',domain_id:1};
 for(const request of [{method:'status',params:['x']},signerKey({...key,domain_id:0}),signerKey({path:'agent-owner',predecessor:'agentic.sputnik-dao.near'}),signerKey({...key,extra:1}),
  signerKey({...key,predecessor:'Not An Account'}),{...signerKey(key),params:{...signerKey(key).params,method_name:'sign'}},
  {...signerKey(key),params:{...signerKey(key).params,account_id:'agentic.sputnik-dao.near'}},{...daoView('get_policy'),params:{...daoView('get_policy').params,account_id:'v1.signer'}}]){
  await assert.rejects(readOwnershipQuery(request,never));
 }
});
