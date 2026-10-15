import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TreasuryRegistry, registrationOwner, registeredEnv, checkRegisteredAction } from '../src/gateway/treasury-registration.js';
import type { Owner } from '../src/gateway/roles.js';

const dao = {account:'team.sputnik-dao.near',signer:'dao-signer',policy:{roles:[{name:'Council',kind:{Group:['member.near']},permissions:['call:AddProposal'],vote_policy:{}}],default_vote_policy:{},proposal_bond:'0'}} as unknown as Owner;
test('wallet registration binds to the signed-in account, never a supplied owner', async()=>{
 assert.deepEqual(await registrationOwner('alice.near',{kind:'wallet'},async()=>{throw Error('unexpected lookup')}),{owner:'alice.near',kind:'wallet'});
 await assert.rejects(registrationOwner('alice.near',{kind:'wallet',owner:'bob.near'},async()=>dao));
});
test('DAO registration requires group membership and proposal permission; reads fail closed',async()=>{
 assert.deepEqual(await registrationOwner('member.near',{kind:'dao',dao:dao.account},async()=>dao),{owner:dao.account,kind:'dao'});
 await assert.rejects(registrationOwner('outsider.near',{kind:'dao',dao:dao.account},async()=>dao));
 const publicDao=structuredClone(dao); publicDao.policy!.roles=[{name:'Everyone',kind:'Everyone',permissions:['*:*'],vote_policy:{}}];
 await assert.rejects(registrationOwner('outsider.near',{kind:'dao',dao:dao.account},async()=>publicDao));
 const viewer=structuredClone(dao);viewer.policy!.roles[0]!.permissions=[];
 await assert.rejects(registrationOwner('member.near',{kind:'dao',dao:dao.account},async()=>viewer));
 await assert.rejects(registrationOwner('member.near',{kind:'dao',dao:dao.account},async()=>{throw Error('RPC unavailable')}));
});
test('registration preserves identity, settings and durable owner records across restart and duplicate requests',()=>{
 const root=mkdtempSync(join(tmpdir(),'treasury-registration-'));
 try{
  const registry=new TreasuryRegistry(join(root,'state'),[18000],2), first=registry.register('alice.near','wallet');
  assert.equal(first.port,18001);
  const settings=registry.entry(first).envFile!; writeFileSync(settings,'AGENT_ID=retained\nAUTOPILOT=off\n');
  writeFileSync(join(registry.directory(first),'retained-owner-intent.json'),'unresolved');
  const restarted=new TreasuryRegistry(join(root,'state'),[18000],2);
  assert.deepEqual(restarted.register('alice.near','wallet'),first);
  assert.equal(readFileSync(settings,'utf8'),'AGENT_ID=retained\nAUTOPILOT=off\n');
  assert.equal(readFileSync(join(registry.directory(first),'retained-owner-intent.json'),'utf8'),'unresolved');
  const second=restarted.register(dao.account,'dao');
  assert.notEqual(second.port,first.port); assert.notEqual(registry.directory(first),registry.directory(second));
  assert.match(readFileSync(restarted.entry(second).envFile!,'utf8'),/AUTOPILOT=off\nTREASURY_ACCOUNT=team.sputnik-dao.near/);
  assert.throws(()=>restarted.register('third.near','wallet'),/capacity/);
  assert.throws(()=>restarted.register('alice.near','dao'),/type differs/);
  rmSync(settings); assert.throws(()=>restarted.list(),/settings are missing/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('corrupt registry refuses instead of resetting capacity or identity',()=>{
 const root=mkdtempSync(join(tmpdir(),'treasury-registration-'));
 try{const registry=new TreasuryRegistry(join(root,'state'),[]);writeFileSync(join(registry.root,'registry.json'),'{');assert.throws(()=>registry.register('alice.near','wallet'));}finally{rmSync(root,{recursive:true,force:true});}
});
test('registered child environment cannot inherit another agent, invoice server, schedule or owner private key',()=>{
 const env=registeredEnv({name:'t',owner:'alice.near',area:'treasury',executor:true,envFile:'/private/state/.env.instance',port:18000},{AGENT_ID:'other',AGENT_GRANT_TOKEN:'secret',AGENT_OWNER_PRIVATE_KEY:'secret',INVOICES_PORT:'8080',AUTOPILOT:'on',TREASURY_ACCOUNT:'other.near',EXECUTOR:'off',NEAR_INTENTS_AGENT_API_KEY:'shared-service-key'});
 assert.equal(env.EXECUTOR,'off');assert.equal(env.AUTOPILOT,'off');assert.equal(env.ENV_FILE,'/private/state/.env.instance');
 for(const key of ['AGENT_ID','AGENT_GRANT_TOKEN','AGENT_OWNER_PRIVATE_KEY','INVOICES_PORT','TREASURY_ACCOUNT'])assert(!(key in env));
});
test('modified create requests cannot change owner, owner kind or treasury role',()=>{
 const wallet={name:'t-aaaaaaaaaaaaaaaaaaaa',owner:'alice.near',kind:'wallet' as const,port:18000};
 const action=(account_id='alice.near',role='treasury',signer='wallet')=>({json:{signer,action:{type:'agent_create',role,owner:{account_id,public_key:'fixture'}}}});
 checkRegisteredAction(wallet,action());
 assert.throws(()=>checkRegisteredAction(wallet,action('bob.near')));assert.throws(()=>checkRegisteredAction(wallet,action('alice.near','payout')));assert.throws(()=>checkRegisteredAction(wallet,action('alice.near','treasury','dao')));
 const ownedDao={...wallet,owner:dao.account,kind:'dao' as const};
 checkRegisteredAction(ownedDao,{json:{signer:'dao',action:{type:'agent_create',role:'treasury'}}});
 assert.throws(()=>checkRegisteredAction(ownedDao,action()));
});
