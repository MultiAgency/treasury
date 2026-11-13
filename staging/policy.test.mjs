import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SyntheticStore} from './store.mjs';
import {USDC,WNEAR} from './policy.mjs';
import {policyView} from './views.mjs';

test('durable rolling budgets enforce exact boundary, preserve balances on refusal and release expired spend',()=>{
 const dir=mkdtempSync(join(tmpdir(),'synthetic-budget-')),path=join(dir,'state.sqlite');
 let store=new SyntheticStore(path);const now=Date.now();
 const terms={agent:'a',from:USDC,to:WNEAR,amount:'1000000',output:'500000000000000000000000'};
 try{
  store.create('agent','a',{wallet:{wallet_id:'synthetic-a'},frozen:false,policy:{actions:['swap'],assets:'any',owner_approval:false,budget:{daily_usd:'2',weekly_usd:'3',monthly_usd:'4'}},balances:{[USDC]:'10000000'}});
  store.swap('1',terms,now);store.swap('2',terms,now);
  assert.throws(()=>store.swap('3',terms,now),/daily budget/);
  store.close();store=new SyntheticStore(path);
  assert.throws(()=>store.swap('3',terms,now),/daily budget/);
  assert.equal(store.read('agent','a').balances[USDC],'8000000');
  assert.equal(policyView(store.read('agent','a'),store.history('a'),now).usage.budget.daily.remaining_usd,'0.000000');
  store.swap('3',terms,now+86400000);
  assert.throws(()=>store.swap('4',terms,now+86400000),/weekly budget/);
  store.swap('4',terms,now+7*86400000);
  assert.throws(()=>store.swap('5',terms,now+7*86400000),/monthly budget/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('hourly action limit survives restart and does not count an identical operation twice',()=>{
 const dir=mkdtempSync(join(tmpdir(),'synthetic-hour-')),path=join(dir,'state.sqlite');let store=new SyntheticStore(path);const now=Date.now();
 const terms={agent:'a',from:USDC,to:WNEAR,amount:'1',output:'1'};
 try{
  store.create('agent','a',{policy:{actions:['swap'],assets:'any',owner_approval:false,max_actions_per_hour:1},balances:{[USDC]:'10'}});
  store.swap('1',terms,now);store.swap('1',terms,now);store.close();store=new SyntheticStore(path);
  assert.throws(()=>store.swap('2',terms,now),/Hourly/);store.swap('2',terms,now+3600000);
  assert.equal(store.read('agent','a').balances[USDC],'8');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

for(const [window,duration] of Object.entries({hourly:3600000,daily:86400000,monthly:30*86400000}))test(`${window} asset cap survives restart and expires at its boundary`,()=>{
 const dir=mkdtempSync(join(tmpdir(),'synthetic-asset-cap-')),path=join(dir,'state.sqlite');let store=new SyntheticStore(path);const now=Date.now();
 const terms={agent:'a',from:USDC,to:WNEAR,amount:'1',output:'1'};
 try{
  store.create('agent','a',{policy:{actions:['swap'],assets:'any',owner_approval:false,limits:{[window]:{[USDC]:'2'}}},balances:{[USDC]:'10'}});
  store.swap('1',terms,now);store.swap('2',terms,now);store.close();store=new SyntheticStore(path);
  assert.throws(()=>store.swap('3',terms,now),/asset cap/);assert.equal(store.read('agent','a').balances[USDC],'8');
  store.swap('3',terms,now+duration);assert.equal(store.read('agent','a').balances[USDC],'7');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
