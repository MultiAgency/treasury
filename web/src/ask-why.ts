// "Ask why" (#264): a button beside a proposal or the risk level that opens the treasury assistant with the question
// already in its box. Nothing is sent by opening it: the owner reads the question and sends it. Held in memory only, and
// handed to the one assistant panel mounted for the agent. With its extension: test/ask-why.test.ts loads this module under Node.

type Listener = (agent: string, question: string) => void;
const listeners = new Set<Listener>();

/** Opens `agent`'s assistant with `question` filled in. With no assistant mounted (none configured), nothing happens. */
export function askWhy(agent: string, question: string) { for (const listener of listeners) listener(agent, question); }

/** The panel's side: told of each ask. Returns the unsubscribe. */
export function onAskWhy(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** The question for a proposal: its ID is in it, so the assistant reads that proposal (`get_proposal`). */
export const proposalQuestion = (id: string) => `Why was proposal ${id} made, and what happens if I approve it?`;

/** The question for the risk level: the assistant reads the latest risk report (`get_risk_report`). */
export const RISK_QUESTION = "Why is the risk level what it is, and what would change it?";
