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

/** A DAO view's arguments: none, or for `get_proposals` exactly a page the app server reads (at most 100 from an index). */
function daoViewArgs(method:string,argsBase64:unknown){
 if(method==='get_policy'||method==='get_last_proposal_id')return argsBase64===undefined||argsBase64===''||argsBase64==='e30=';
 if(method!=='get_proposals'||typeof argsBase64!=='string')return false;
 let args:any;try{args=JSON.parse(Buffer.from(argsBase64,'base64').toString('utf8'));}catch{return false;}
 return args!==null&&typeof args==='object'&&Object.keys(args).sort().join()==='from_index,limit'
  &&Number.isSafeInteger(args.from_index)&&args.from_index>=0&&Number.isSafeInteger(args.limit)&&args.limit>=1&&args.limit<=100;
}

/** Ownership and DAO reads only: access keys, and a DAO's policy and proposals. Transaction methods and other contract calls are refused. */
export async function readOwnershipQuery(request: any,fetcher:typeof fetch=fetch){
 const p=request?.params;
 if(request?.method!=='query'||!p||p.finality!=='final'||typeof p.account_id!=='string'||!/^([a-z0-9]+[._-])*[a-z0-9]+$/.test(p.account_id))throw Error('Unsupported ownership query');
 const allowed=p.request_type==='view_access_key'&&typeof p.public_key==='string'
  ||p.request_type==='call_function'&&typeof p.method_name==='string'&&daoViewArgs(p.method_name,p.args_base64);
 if(!allowed)throw Error('Only access-key and DAO policy and proposal reads are supported');
 const response=await fetcher('https://free.rpc.fastnear.com',{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(10000),body:JSON.stringify({jsonrpc:'2.0',id:request.id,method:'query',params:p})});
 if(!response.ok)throw Error('Ownership RPC unavailable');return response.json();
}
