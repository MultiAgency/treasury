import { gatewayQueries } from "../app/queries";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Kind } from "../features/evidence/beats";
import { BASE, kindOf, type Overview, short } from "./lib";

import { useAgent } from "../app/agent-context";
import { deniedAt, useAccessState } from "./access";

/**
 * The other agents behind the same hosted dashboard (their names, kinds, wallets and state), and this
 * page's own agent as the gateway lists it, with its owner. None locally.
 */
export function useSiblings() {
  const authorization = useAccessState();
  // Share the shell's session so sibling permissions change with the workspace permissions.
  const gateway = useQuery(gatewayQueries.session);
  const agents = (gateway.data?.agents ?? []).filter(agent => !deniedAt(authorization, `/a/${agent.name}`));
  const names = agents.filter((a) => `/a/${a.name}` !== BASE).map((a) => a.name);
  const results = useQueries({
    queries: names.map(name => gatewayQueries.sibling(name)),
  });
  return {
    hosted: Boolean(gateway.data),
    /** The signed-in account's access to each agent, for an action on a sibling rather than this page's agent. */
    access: gateway.data?.viewer?.access ?? {},
    self: agents.find((a) => `/a/${a.name}` === BASE),
    siblings: names.flatMap((name, i) => {
      const data = results[i]?.data;
      return data ? [{ name, kind: kindOf(data.overview) as Kind, wallet: data.setup.wallet, overview: data.overview as Overview }] : [];
    }),
  };
}

/** The agent each area runs on, as people know it. */
export const AGENT_NAME: Record<Kind, string> = { facilitator: "the payout agent", treasury: "the treasury agent" };

/**
 * An account as people know it: a known wallet by its label, any other 64-character account shortened.
 * Named accounts (alice.near, the DAO) read fine as they are.
 */
export const namer = (known: Map<string, string>) => (account: string) =>
  known.get(account) ?? (/^[0-9a-f]{64}$/.test(account) ? short(account) : account);

/** On an agent's own pages: its wallet is "this agent", the other agents' wallets go by role. */
export function useNameOf() {
  const { setup } = useAgent();
  const { siblings } = useSiblings();
  const known = new Map<string, string>();
  if (setup.wallet) known.set(setup.wallet, "this agent");
  for (const s of siblings) if (s.wallet) known.set(s.wallet, AGENT_NAME[s.kind]);
  return namer(known);
}
