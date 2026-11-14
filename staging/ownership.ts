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

/** `v1.signer`'s key for a DAO: exactly a path, the DAO as predecessor, and the Ed25519 domain. */
function derivedKeyArgs(argsBase64:unknown){
 if(typeof argsBase64!=='string')return false;
 let args:any;try{args=JSON.parse(Buffer.from(argsBase64,'base64').toString('utf8'));}catch{return false;}
 return args!==null&&typeof args==='object'&&Object.keys(args).sort().join()==='domain_id,path,predecessor'&&args.domain_id===1
  &&typeof args.path==='string'&&args.path.length>0&&args.path.length<=64&&typeof args.predecessor==='string'&&/^([a-z0-9]+[._-])*[a-z0-9]+$/.test(args.predecessor);
}

/**
 * Ownership and DAO reads only: access keys, a DAO's policy and proposals, `v1.signer`'s key for a DAO, and the chain's
 * status (where a DAO's signature search starts). Transaction methods and other contract calls are refused.
 */
export async function readOwnershipQuery(request: any,fetcher:typeof fetch=fetch){
 if(request?.method==='status'&&(request.params===undefined||Array.isArray(request.params)&&request.params.length===0)){
  const response=await fetcher('https://free.rpc.fastnear.com',{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(10000),body:JSON.stringify({jsonrpc:'2.0',id:request.id,method:'status',params:[]})});
  if(!response.ok)throw Error('Ownership RPC unavailable');return response.json();
 }
 const p=request?.params;
 if(request?.method!=='query'||!p||p.finality!=='final'||typeof p.account_id!=='string'||!/^([a-z0-9]+[._-])*[a-z0-9]+$/.test(p.account_id))throw Error('Unsupported ownership query');
 const allowed=p.request_type==='view_access_key'&&typeof p.public_key==='string'
  ||p.request_type==='call_function'&&p.account_id==='v1.signer'&&p.method_name==='derived_public_key'&&derivedKeyArgs(p.args_base64)
  ||p.request_type==='call_function'&&p.account_id!=='v1.signer'&&typeof p.method_name==='string'&&daoViewArgs(p.method_name,p.args_base64);
 if(!allowed)throw Error('Only access-key, DAO, v1.signer key and status reads are supported');
 const response=await fetcher('https://free.rpc.fastnear.com',{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(10000),body:JSON.stringify({jsonrpc:'2.0',id:request.id,method:'query',params:p})});
 if(!response.ok)throw Error('Ownership RPC unavailable');return response.json();
}
