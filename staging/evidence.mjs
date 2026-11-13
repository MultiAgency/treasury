/** All receipts in this module describe synthetic funding, never mainnet transactions. */
export function depositView(funding,agent){return {
 correlation_id:`synthetic-deposit-${funding.requestId}`,agent_id:funding.agent,type:'deposit',status:'SUCCESS',created_at:funding.at,updated_at:funding.at,failure_code:null,
 details:{action:'deposit',request:{origin_asset:funding.asset,confidential:true},confidential:true,provider_request_id:null,deposit_address:agent.wallet.near_account_id,deposit_tx_hash:`synthetic-${funding.requestId}`,deposited_amount:funding.amount,amount_out:funding.amount}
};}
export function depositTransaction(funding,agent){return {receipts:[{
 receipt:{receiver_id:funding.asset.slice('nep141:'.length),receipt:{Action:{actions:[{FunctionCall:{method_name:'ft_transfer',args:Buffer.from(JSON.stringify({receiver_id:agent.wallet.near_account_id,amount:funding.amount})).toString('base64')}}]}}},
 execution_outcome:{outcome:{status:{SuccessValue:''},logs:[]}}
}]};}
export function auditEvents(operations){return operations.flatMap(op=>[
 {type:'confidential_swap_settled',request_id:op.id,status:'SUCCESS',at:op.at},
 {type:'confidential_swap',request_id:op.id,chain:'near',amount:op.amount,amount_in:op.amount,confidential:true,origin_asset:op.from,destination_asset:op.to,at:op.at}
]);}
