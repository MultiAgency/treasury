import { USDC,WNEAR,ETH,windows,usdMicros,decimalMicros } from './policy.mjs';
export function tokens(now=Date.now()) {return [
 {asset_id:USDC,symbol:'USDC',decimals:6,price:1},
 {asset_id:WNEAR,symbol:'wNEAR',decimals:24,price:2},
 {asset_id:ETH,symbol:'ETH',decimals:18,price:3000},
].map(token=>({...token,price_updated_at:new Date(now).toISOString(),price_expires_at:new Date(now+60000).toISOString()}));}
export function operationView(op){return {correlation_id:op.id,agent_id:op.agent,type:'swap',status:op.status,created_at:op.at,updated_at:op.at,failure_code:null,
 details:{action:'swap',confidential:true,amount_out:op.output,provider_request_id:op.id,request:{origin_asset:op.from,destination_asset:op.to,amount:op.amount,min_amount_out:op.output,confidential:true},evidence:{amount:op.amount,amount_out:op.output,created_at:op.at}}};}
const dollars=n=>`${n/1000000n}.${(n%1000000n).toString().padStart(6,'0')}`;
export function policyView(agent,history,now=Date.now()){
 return {policy:agent.policy,revision:1,status:'APPLIED',provider_policy_synced:true,wallet_id:agent.wallet.wallet_id,policy_hash:null,applied_at:null,transaction_hash:null,
 cooldowns:{policy_change_available_at:null,unfreeze_available_at:null},
 usage:{budget:Object.fromEntries(Object.entries(windows).map(([name,duration])=>{
  const limit=agent.policy.budget?.[`${name}_usd`];if(limit==null)return [name,{limit_usd:null,spent_usd:null,remaining_usd:null,resets_at:null}];
  const included=history.filter(op=>Date.parse(op.at)>now-duration);
  const spent=included.reduce((sum,op)=>sum+usdMicros(op.from,op.amount),0n),remaining=decimalMicros(limit)-spent;
  return [name,{limit_usd:String(limit),spent_usd:dollars(spent),remaining_usd:dollars(remaining>0n?remaining:0n),resets_at:included.length?new Date(Math.min(...included.map(op=>Date.parse(op.at)))+duration).toISOString():null}];
 })),timelock:{delay_ms:agent.policy.timelock_ms??0,scheduled_count:0}}};
}
