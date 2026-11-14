import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyntheticStore } from './store.mjs';

test('restart retains balances, freeze, intents and unknown operations; accepted swap replay moves funds once',()=>{
 const dir=mkdtempSync(join(tmpdir(),'synthetic-durable-')),path=join(dir,'state.sqlite');
 let store=new SyntheticStore(path);
 try {
  store.create('agent','isolated',{owner:'owner.near',frozen:false,balances:{USDC:'100',NEAR:'0'}});
  store.create('agent','retained',{frozen:true,balances:{USDC:'96'}});
  store.create('intent','pending',{status:'PENDING_SIGNATURE',nonce:'retained'});
  store.create('recovery','unknown',{status:'UNKNOWN',operationId:null});
  const terms={agent:'isolated',from:'USDC',to:'NEAR',amount:'10',output:'2'};
  const first=store.swap('op-1',terms); // Lost acknowledgement: restart without consuming result.
  store.close();store=new SyntheticStore(path);
  assert.deepEqual(store.swap('op-1',terms),first);
  assert.deepEqual(store.read('agent','isolated').balances,{USDC:'90',NEAR:'2'});
  assert.equal(store.read('agent','retained').frozen,true);
  assert.deepEqual(store.read('recovery','unknown'),{status:'UNKNOWN',operationId:null});
  assert.equal(store.read('intent','pending').nonce,'retained');
  assert.throws(()=>store.swap('op-1',{...terms,amount:'11'}),/conflict/);
  assert.throws(()=>store.swap('op-2',{...terms,agent:'retained'}),/Frozen/);
  assert.deepEqual(store.read('agent','retained').balances,{USDC:'96'});
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('an intent is consumed once and remains consumed after restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'synthetic-intent-')),path=join(dir,'state.sqlite');
 let store=new SyntheticStore(path);
 try{
  const intent={status:'PENDING_SIGNATURE',expiresAt:Date.now()+60000,message:'exact terms'};
  store.create('intent','i',intent);
  store.completeIntent('i',intent,{agent:'isolated'});
  store.close();store=new SyntheticStore(path);
  assert.throws(()=>store.completeIntent('i',intent,{agent:'duplicate'}),/consumed/);
  assert.equal(store.read('intent','i').result.agent,'isolated');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('SIGKILL after settlement commit preserves exactly one operation and balance change',async()=>{
 const {spawnSync}=await import('node:child_process');
 const dir=mkdtempSync(join(tmpdir(),'synthetic-crash-')),path=join(dir,'state.sqlite');
 const moduleUrl=new URL('./store.mjs',import.meta.url).href;
 const terms={agent:'crash',from:'USDC',to:'NEAR',amount:'10',output:'2'};
 let store;
 try {
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
   import {SyntheticStore} from ${JSON.stringify(moduleUrl)};
   const store=new SyntheticStore(${JSON.stringify(path)});
   store.create('agent','crash',{frozen:false,balances:{USDC:'100'}});
   store.swap('crashed-op',${JSON.stringify(terms)});
   process.kill(process.pid,'SIGKILL');
  `],{encoding:'utf8'});
  assert.equal(child.signal,'SIGKILL',child.stderr);
  store=new SyntheticStore(path);
  assert.equal(store.operation('crashed-op').status,'SUCCESS');
  store.swap('crashed-op',terms);
  assert.deepEqual(store.read('agent','crash').balances,{USDC:'90',NEAR:'2'});
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});


test('a missing persisted receipt refuses replay and new execution without changing balances',()=>{
 const dir=mkdtempSync(join(tmpdir(),'synthetic-corrupt-receipt-')),store=new SyntheticStore(join(dir,'state.sqlite'));
 const terms={agent:'a',from:'USDC',to:'NEAR',amount:'10',output:'2'};
 try {
  store.create('agent','a',{frozen:false,balances:{USDC:'100'}});
  store.swap('original',terms);
  store.db.prepare('UPDATE operations SET result=NULL WHERE id=?').run('original');
  const before=store.read('agent','a');
  assert.throws(()=>store.swap('original',terms),/Invalid stored JSON/);
  assert.throws(()=>store.swap('replacement',terms),/Invalid stored JSON/);
  assert.deepEqual(store.read('agent','a'),before);
  assert.equal(store.operation('replacement'),null);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('a failed intent effect rolls back its writes and leaves the exact reviewed intent open',()=>{
 const dir=mkdtempSync(join(tmpdir(),'synthetic-intent-rollback-')),store=new SyntheticStore(join(dir,'state.sqlite'));
 const intent={status:'PENDING_SIGNATURE',expiresAt:Date.now()+60000,type:'agent_freeze',request:{agent_id:'a'},
  owner:{type:'near',account_id:'owner.near',public_key:'test'},payload:{message:'exact reviewed freeze',recipient:'synthetic.test',nonce:'test'}};
 try {
  store.create('agent','a',{frozen:false,balances:{USDC:'100'}});
  store.create('intent','freeze',intent);
  assert.throws(()=>store.completeIntent('freeze',intent,{agent_id:'a'},()=>{
   const agent=store.read('agent','a');agent.frozen=true;store.replace('agent','a',agent);
   throw Error('effect failed');
  }),/effect failed/);
  assert.equal(store.read('agent','a').frozen,false);
  assert.deepEqual(store.read('intent','freeze'),intent);
  store.completeIntent('freeze',intent,{agent_id:'a'});
  assert.equal(store.read('intent','freeze').status,'SUCCESS');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
