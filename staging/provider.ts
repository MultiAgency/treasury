import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { depositView,depositTransaction,auditEvents } from './evidence.mjs';
import { tokens,operationView,policyView } from './views.mjs';
import {assetPrices,quote} from './policy.mjs';
import type {SyntheticStore} from './store.mjs';
import { verifyOwner } from './verify-owner.ts';
import type { KeyLookup } from '../apps/server/src/keys.ts';

/** Synthetic provider transport. No transaction client, mainnet sender or private key exists in this process. */
export function providerServer({store,lookup,recipient,controlToken,chainRead}: {store:SyntheticStore;lookup:KeyLookup;recipient:string;controlToken:string;chainRead?:(body:any)=>Promise<any>}) {
 if(controlToken.length<32) throw Error('A separate staging control token is required');
 return createServer(async(req,res)=>{
  const send=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','x-treasury-environment':'synthetic-staging'});res.end(JSON.stringify(value));};
  try{
   const url=new URL(req.url!,'http://synthetic.invalid');
   if(req.method==='GET'&&url.pathname==='/v1/tokens')return send(200,{data:tokens()});
   if(req.method==='GET'&&url.pathname==='/healthz') return send(200,{ready:true,synthetic:true});
   let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>65536) return send(413,{error:'Request too large'});}
   const body=text?JSON.parse(text):{};
   if(req.method==='POST'&&url.pathname==='/chain'){if(!chainRead)return send(503,{error:'Ownership reads unavailable'});return send(200,await chainRead(body));}
   if(req.method==='POST'&&url.pathname==='/__staging/transactions'){
    if(!Array.isArray(body.tx_hashes)||body.tx_hashes.length>100||body.tx_hashes.some((hash:unknown)=>typeof hash!=='string'||!hash.startsWith('synthetic-')))return send(400,{error:'Only synthetic receipt identities are supported'});
    const funding=store.list('funding').filter(record=>body.tx_hashes.includes(`synthetic-${record.requestId}`));
    return send(200,{synthetic:true,transactions:funding.map(record=>depositTransaction(record,store.read('agent',record.agent)))});
   }
   if(req.method==='POST'&&url.pathname==='/__staging/transfers')return send(200,{synthetic:true,transfers:[],resume_token:null});
   if(req.method==='POST'&&url.pathname==='/__staging/fund'){
    const actual=Buffer.from(req.headers.authorization??''),expected=Buffer.from(`Bearer ${controlToken}`);
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return send(401,{error:'Staging control authorization required'});
    if(!/^[1-9][0-9]*$/.test(body.amount)||typeof body.asset!=='string'||typeof body.requestId!=='string'||!body.requestId)return send(400,{error:'Invalid synthetic funding terms'});
    store.transaction(()=>{
     const prior=store.read('funding',body.requestId);if(prior){if(JSON.stringify(prior.terms)!==JSON.stringify(body))throw Error('Funding identity conflict');return;}
     const agent=store.read('agent',body.agent);if(!agent)throw Error('Unknown agent');
     agent.balances[body.asset]=(BigInt(agent.balances[body.asset]??'0')+BigInt(body.amount)).toString();
     store.replace('agent',agent.id,agent);store.create('funding',body.requestId,{...body,terms:body,at:new Date().toISOString()});
    });return send(200,{synthetic:true});
   }
   if(req.method==='POST'&&url.pathname==='/v1/generate-intent'){
    if(!['agent_create','grant_issue','agent_freeze','agent_unfreeze'].includes(body.type))return send(400,{error:'Unsupported synthetic intent'});
    if(body.type!=='agent_create'){
     const agent=store.read('agent',body.agent_id);if(!agent)return send(404,{error:'Unknown agent'});
     body.owner=agent.owner;
     if(body.type==='grant_issue'&&(!/^[a-f0-9]{64}$/.test(body.credential)||!Number.isFinite(Date.parse(body.expires_at))||Date.parse(body.expires_at)<=Date.now()))return send(400,{error:'Invalid grant'});
    }
    if(body.owner?.type!=='near'||(body.type==='agent_create'&&!body.policy?.actions?.includes('swap')))return send(400,{error:'Unsupported synthetic owner or policy'});
    if(await lookup(body.owner.account_id,body.owner.public_key)!=='full')return send(403,{error:'Full-access owner key required'});
    const id=randomUUID(),expiresAt=Date.now()+300000;
    const intent={status:'PENDING_SIGNATURE',expiresAt,type:body.type,owner:body.owner,request:body,
     payload:{message:JSON.stringify(body),recipient,nonce:randomBytes(32).toString('base64')}};
    store.create('intent',id,intent);
    return send(200,{correlation_id:id,type:body.type,signer:body.owner,expires_at:new Date(expiresAt).toISOString(),intent:{standard:'nep413',payload:intent.payload},preview:{summary:'Create an isolated synthetic Treasury'}});
   }
   if(req.method==='POST'&&url.pathname==='/v1/submit-intent'){
    const intent=store.read('intent',body.correlation_id);
    if(!intent||intent.status!=='PENDING_SIGNATURE')return send(409,{error:'Intent is not open; read its status'});
    const signed=body.signed_data;
    if(signed?.standard!=='nep413'||signed.public_key!==intent.owner.public_key||JSON.stringify(signed.payload)!==JSON.stringify(intent.payload))return send(400,{error:'Signed intent differs from review'});
    await verifyOwner({...intent.payload,account:intent.owner.account_id,publicKey:signed.public_key,signature:signed.signature,expiresAt:intent.expiresAt,lookup});
    const id=randomBytes(32).toString('hex');
    if(intent.type==='agent_create')store.completeIntent(body.correlation_id,intent,{agent_id:id},()=>store.create('agent',id,{id,owner:intent.owner,policy:intent.request.policy,frozen:!!intent.request.policy.frozen,balances:{},grants:[],wallet:{wallet_id:`synthetic-${id}`,near_account_id:`synthetic-${id.slice(0,16)}.near`}}));
    else store.completeIntent(body.correlation_id,intent,{agent_id:intent.request.agent_id},()=>{
     const agent=store.read('agent',intent.request.agent_id);
     if(intent.type==='grant_issue')agent.grants.push({grant_id:id,agent_id:agent.id,wallet_id:agent.wallet.wallet_id,label:intent.request.label??'treasury',issued_at:new Date().toISOString(),credential:intent.request.credential,expires_at:intent.request.expires_at,revoked_at:null,revoked_reason:null,owner_epoch:1,
      owner_message:{domain:'near-intents-agent-api.agent-grant.v6',owner:agent.owner,tenant_id:'synthetic',agent_id:agent.id,wallet_id:agent.wallet.wallet_id,label:intent.request.label??'treasury',credential:intent.request.credential,network:'mainnet',issued_at_ms:Date.now(),expires_at_ms:Date.parse(intent.request.expires_at),owner_epoch:1,nonce:intent.payload.nonce,recipient:intent.payload.recipient}});
     else {agent.frozen=intent.type==='agent_freeze';agent.policy.frozen=agent.frozen;}
     store.replace('agent',agent.id,agent);
    });
    return send(200,{correlation_id:body.correlation_id,status:'SUCCESS'});
   }
   if(req.method==='GET'&&url.pathname==='/v1/status'){
    const operation=store.operation(url.searchParams.get('correlation_id'));
    if(operation)return send(200,operationView(JSON.parse(String(operation.result))));
    const intent=store.read('intent',url.searchParams.get('correlation_id'));
    return intent?send(200,{correlation_id:url.searchParams.get('correlation_id'),type:intent.type,status:intent.status,agent_id:intent.result?.agent_id??intent.request.agent_id??null,details:intent.result??null}):send(404,{error:'Unknown operation'});
   }
   const match=/^\/v1\/agents\/([a-f0-9]{64})(\/.*)?$/.exec(url.pathname);
   const agent=match&&store.read('agent',match[1]),route=match?.[2]??'';
   if(agent&&req.method==='GET'){
    if(route==='/wallet')return send(200,agent.wallet);
    if(route==='/policy')return send(200,policyView(agent,store.history(agent.id)));
    if(route==='/policy/history')return send(200,{data:[],next_cursor:null});
    if(route==='/grants')return send(200,{data:agent.grants});
    if(route==='/provider/audit'){
     const offset=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit')??100);
     if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)return send(400,{error:'Invalid page'});
     return send(200,{data:{events:auditEvents(store.history(agent.id)).slice(offset,offset+limit)}});
    }
    if(['/provider/requests','/provider/deposits','/provider/deposit_history'].includes(route))return send(200,{data:{events:[]}});
    if(route==='/history'){
     const offset=Number(url.searchParams.get('cursor')??0),limit=Number(url.searchParams.get('limit')??100);
     if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)return send(400,{error:'Invalid page'});
     const rows=[...store.history(agent.id).map(operationView),...store.list('funding').filter(record=>record.agent===agent.id).map(record=>depositView(record,agent))].sort((a,b)=>a.created_at.localeCompare(b.created_at));
     return send(200,{data:rows.slice(offset,offset+limit),next_cursor:offset+limit<rows.length?String(offset+limit):null});
    }
    if(route==='/limit-orders')return send(200,{data:[]});
   }
   if(match&&!agent)return send(404,{error:'Unknown agent'});
   if(agent&&req.method==='GET'&&route==='/balances')return send(200,{near_account_id:agent.wallet.near_account_id,source:url.searchParams.get('source'),balances:Object.entries(agent.balances).map(([asset_id,balance_raw])=>({asset_id,balance_raw:url.searchParams.get('source')==='public'?'0':balance_raw}))});
   if(agent&&req.method==='POST'&&route==='/swap'){
    const token=req.headers['x-grant-token'];
    const commitment=typeof token==='string'?createHash('sha256').update(token).digest('hex'):null;
    if(!agent.grants.some((g:any)=>g.credential===commitment&&!g.revoked_at&&Date.parse(g.expires_at)>Date.now()))return send(403,{error:'Live grant required'});
    if(agent.frozen||!agent.policy.actions.includes('swap')||agent.policy.owner_approval!==false)return send(403,{error:'Policy refuses unattended swap'});
    const from=body.origin_asset,to=body.destination_asset;
    const assets={USDC:'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',NEAR:'nep141:wrap.near'};
    if(!Object.hasOwn(assetPrices,from)||!Object.hasOwn(assetPrices,to)||from===to||body.confidential!==true||!/^[1-9][0-9]*$/.test(body.amount))return send(400,{error:'Unsupported synthetic swap'});
    if(agent.policy.assets!=='any'&&(!agent.policy.assets?.includes(from)||!agent.policy.assets?.includes(to)))return send(403,{error:'Asset outside policy'});
    if(agent.policy.timelock_ms>0)return send(403,{error:'Synthetic timelock execution is unsupported'});
    const cap=agent.policy.limits?.per_transaction?.[from];
    if(cap!=null&&BigInt(body.amount)>BigInt(cap))return send(403,{error:'Transaction cap exceeded'});
    // Synthetic fixed quote: 1 wNEAR = 2 USDC. These are test prices, never market data.
    const output=quote(from,to,body.amount).toString();
    if(output==='0')return send(400,{error:'Swap too small'});
    if(body.dry)return send(200,{quote:{amount_out:output,min_amount_out:output},warnings:[]});
    if(!/^[0-9]+$/.test(body.min_amount_out??'')||BigInt(body.min_amount_out)>BigInt(output))return send(409,{error:'Signed floor cannot be met'});
    const key=req.headers['idempotency-key'];if(typeof key!=='string'||!key)return send(400,{error:'Operation identity required'});
    const result=store.swap(key,{agent:agent.id,from,to,amount:body.amount,output,minAmountOut:body.min_amount_out});
    return send(200,{correlation_id:result.id});
   }
   if(req.method==='GET'&&match&&route===''){const agent=store.read('agent',match[1]);return agent?send(200,{...agent,status:'ACTIVE',archived:false,deleted:false}):send(404,{error:'Unknown agent'});}
   return send(404,{error:'Unsupported synthetic route'});
  }catch(error){return send(400,{error:error instanceof Error?error.message:'Synthetic request failed'});}
 });
}
