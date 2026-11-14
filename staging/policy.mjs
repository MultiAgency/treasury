// @ts-check
export const USDC='nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const WNEAR='nep141:wrap.near';
export const ETH='nep141:eth.omft.near';
/** @type {Readonly<Record<string, {decimals: number, micros: bigint}>>} */
export const assetPrices={[USDC]:{decimals:6,micros:1000000n},[WNEAR]:{decimals:24,micros:2000000n},[ETH]:{decimals:18,micros:3000000000n}};
/** @param {string} from @param {string} to @param {string} amount */
export function quote(from,to,amount){const a=assetPrices[from],b=assetPrices[to];if(!a||!b)throw Error('Unpriced synthetic asset');return BigInt(amount)*a.micros*10n**BigInt(b.decimals)/(10n**BigInt(a.decimals)*b.micros);}
export const windows={daily:86400000,weekly:7*86400000,monthly:30*86400000};
/** @param {string} asset @param {string} amount */
export function usdMicros(asset,amount){
 const price=assetPrices[asset];if(!price)throw Error('Unpriced synthetic asset');const units=10n**BigInt(price.decimals);return (BigInt(amount)*price.micros+units-1n)/units;
}
/** @param {string} value */
export function decimalMicros(value){
 if(!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(String(value)))throw Error('Invalid USD budget');
 const [whole,fraction='']=String(value).split('.');return BigInt(whole ?? '')*1000000n+BigInt(fraction.padEnd(6,'0'));
}
/** Synthetic budgets are rolling 24-hour, 7-day and 30-day windows, not observed provider semantics. */
/**
 * @param {import('./types.ts').PolicyState} state
 * @param {{from: string, to: string, amount: string}} swap
 * @param {readonly import('./types.ts').SwapResult[]} history
 * @param {number} now
 */
export function enforcePolicy(state,{from,to,amount},history,now){
 const policy=state.policy;if(!policy)return;
 if(state.frozen||policy.frozen||!policy.actions?.includes('swap')||policy.owner_approval!==false)throw Error('Policy refuses swap');
 if((policy.timelock_ms??0)>0)throw Error('Synthetic timelock execution is unsupported');
 if(policy.assets!=='any'&&(!policy.assets?.includes(from)||!policy.assets?.includes(to)))throw Error('Asset outside policy');
 const cap=policy.limits?.per_transaction?.[from];if(cap!=null&&BigInt(amount)>BigInt(cap))throw Error('Transaction cap exceeded');
 const hour=history.filter(op=>Date.parse(op.at)>now-3600000);
 if(policy.max_actions_per_hour!=null){if(!Number.isSafeInteger(policy.max_actions_per_hour)||policy.max_actions_per_hour<0)throw Error('Invalid hourly limit');if(hour.length>=policy.max_actions_per_hour)throw Error('Hourly action limit reached');}
 for(const [window,duration] of /** @type {const} */ ([['hourly',3600000],['daily',86400000],['monthly',30*86400000]])){
  const cap=policy.limits?.[window]?.[from];if(cap==null)continue;
  if(!/^[0-9]+$/.test(String(cap)))throw Error('Invalid asset window cap');
  const spent=history.filter(op=>op.from===from&&Date.parse(op.at)>now-duration).reduce((sum,op)=>sum+BigInt(op.amount),0n);
  if(spent+BigInt(amount)>BigInt(cap))throw Error(`${window} asset cap exceeded`);
 }
 const cost=usdMicros(from,amount);
 for(const name of /** @type {const} */ (['daily','weekly','monthly'])){
  const duration=windows[name];
  const limit=policy.budget?.[`${name}_usd`];if(limit==null)continue;
  const spent=history.filter(op=>Date.parse(op.at)>now-duration).reduce((sum,op)=>sum+usdMicros(op.from,op.amount),0n);
  if(spent+cost>decimalMicros(limit))throw Error(`${name} budget exceeded`);
 }
}
