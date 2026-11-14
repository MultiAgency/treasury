// Compile-only contracts: pnpm typecheck:staging checks these; no database is opened.
import { SyntheticStore } from '../store.mjs';
import { decimalMicros, enforcePolicy, quote } from '../policy.mjs';
import type { Agent, Intent, SwapResult } from '../types.ts';

export function checkContracts(store: SyntheticStore, agent: Agent, intent: Intent) {
 store.create('agent', agent.id, agent);
 const found = store.read('agent', agent.id);
 if (found) { const balances: Record<string, string> = found.balances; void balances; }
 // @ts-expect-error Missing records must be checked before accessing balances.
 store.read('agent', agent.id).balances;
 // @ts-expect-error Wrong record collection.
 store.create('funding', agent.id, agent);
 // @ts-expect-error Atomic amounts remain decimal strings.
 store.swap('op', {agent: agent.id, from: 'a', to: 'b', amount: 1, output: '1'});
 // @ts-expect-error Balance writes must contain atomic strings.
 store.replace('agent', agent.id, {...agent, balances: {a: 1}});
 const swap: SwapResult = store.swap('op', {agent: agent.id, from: 'a', to: 'b', amount: '1', output: '1'});
 enforcePolicy(agent, swap, store.history(agent.id), Date.now());
 store.transaction(() => 7);
 // @ts-expect-error SQLite transactions must complete synchronously.
 store.transaction(async () => 7);
 store.completeIntent('intent', intent, {agent_id: agent.id}, () => { store.replace('agent', agent.id, agent); });
 // @ts-expect-error Intent effects must commit synchronously with consumption.
 store.completeIntent('intent', intent, {agent_id: agent.id}, async () => {});
 // @ts-expect-error Stored receipt timestamps must be strings.
 enforcePolicy(agent, swap, [{...swap, at: 0}], Date.now());
 // @ts-expect-error Budget arithmetic accepts decimal strings, not floating-point dollars.
 decimalMicros(0.1);
 // @ts-expect-error Quotes use atomic decimal strings.
 quote('a', 'b', 1);
 // @ts-expect-error Unpriced asset lookup must be checked.
 const units: string = agent.balances.missing;
 void units;
}
