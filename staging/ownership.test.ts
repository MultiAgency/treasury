import {test} from 'node:test';
import assert from 'node:assert/strict';
import {walletLookup} from './ownership.ts';

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
