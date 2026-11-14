import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('packaged guard starts in the hosted-agent environment without staging-only variables',()=>{
 const guard=fileURLToPath(new URL('./gateway-network.cjs',import.meta.url));
 const script=`Promise.resolve().then(()=>fetch('https://api.dev.multiagency.ai/')).then(()=>process.exit(2)).catch(error=>{if(!error.message.includes('blocked'))process.exit(3);});`;
 const child=spawnSync(process.execPath,['--require',guard,'-e',script],{encoding:'utf8',env:{PATH:process.env.PATH,NEAR_INTENTS_AGENT_API_URL:'https://persistent-synthetic-provider-staging.up.railway.app'}});
 assert.equal(child.status,0,child.stderr);
});

test('a DAO signature search reaches real FastNEAR transactions, synthetic receipts stay with the provider',()=>{
 const guard=fileURLToPath(new URL('./gateway-network.cjs',import.meta.url));
 const script=`
  const seen=[];globalThis.fetch=async(input)=>{seen.push(String(input));return new Response('{}');};
  require(${JSON.stringify(guard)});
  const post=(path,body)=>fetch('https://tx.main.fastnear.com/v0'+path,{method:'POST',body:body===undefined?undefined:JSON.stringify(body)});
  (async()=>{
   await post('/account',{account_id:'agentic.sputnik-dao.near',is_predecessor:true});
   await post('/transactions',{tx_hashes:['Di5i5yNo8eSP2kG4jwfAznvQTg3GqFgxyFQdbLVZWZ7R']});
   await post('/transactions',{tx_hashes:['synthetic-request-1']});
   for(const body of [{tx_hashes:['synthetic-request-1','Di5i5yNo8eSP2kG4jwfAznvQTg3GqFgxyFQdbLVZWZ7R']},{tx_hashes:[]},undefined]){
    if(await Promise.resolve().then(()=>post('/transactions',body)).then(()=>true,error=>!error.message.includes('blocked')))process.exit(4);
   }
   process.stdout.write(JSON.stringify(seen));
  })().catch(()=>process.exit(5));`;
 const child=spawnSync(process.execPath,['-e',script],{encoding:'utf8',env:{PATH:process.env.PATH,STAGING_PROVIDER_ORIGIN:'https://persistent-synthetic-provider-staging.up.railway.app'}});
 assert.equal(child.status,0,child.stderr);
 assert.deepEqual(JSON.parse(child.stdout),['https://tx.main.fastnear.com/v0/account','https://tx.main.fastnear.com/v0/transactions','https://persistent-synthetic-provider-staging.up.railway.app/__staging/transactions']);
});
