import type {KeyLookup} from '../apps/server/src/keys.ts';

/** The sole external request supported by the synthetic service: a final access-key read. */
export function walletLookup(fetcher: typeof fetch=fetch): KeyLookup {
 return async(account,publicKey)=>{
  if(!/^([a-z0-9]+[._-])*[a-z0-9]+$/.test(account)||account.length<2||account.length>64||!/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(publicKey))return 'none';
  try{
   const response=await fetcher('https://free.rpc.fastnear.com',{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(10000),body:JSON.stringify({jsonrpc:'2.0',id:'synthetic-wallet-ownership',method:'query',params:{request_type:'view_access_key',finality:'final',account_id:account,public_key:publicKey}})});
   if(!response.ok)return 'unavailable';
   const answer=await response.json();
   if(answer.error){
    const cause=answer.error.cause?.name;
    return ['UNKNOWN_ACCESS_KEY','UNKNOWN_ACCOUNT'].includes(cause)?'none':'unavailable';
   }
   if(answer.result?.permission==='FullAccess')return 'full';
   if(answer.result?.permission?.FunctionCall)return 'limited';
   return 'unavailable';
  }catch{return 'unavailable';}
 };
}

/** Gateway ownership checks only. Transaction methods and arbitrary contract calls are refused. */
export async function readOwnershipQuery(request: any,fetcher:typeof fetch=fetch){
 const p=request?.params;
 if(request?.method!=='query'||!p||p.finality!=='final'||typeof p.account_id!=='string'||!/^([a-z0-9]+[._-])*[a-z0-9]+$/.test(p.account_id))throw Error('Unsupported ownership query');
 const allowed=p.request_type==='view_access_key'&&typeof p.public_key==='string'
  ||p.request_type==='call_function'&&p.method_name==='get_policy'&&(!p.args_base64||p.args_base64==='e30=');
 if(!allowed)throw Error('Only access-key and DAO-policy reads are supported');
 const response=await fetcher('https://free.rpc.fastnear.com',{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(10000),body:JSON.stringify({jsonrpc:'2.0',id:request.id,method:'query',params:p})});
 if(!response.ok)throw Error('Ownership RPC unavailable');return response.json();
}
