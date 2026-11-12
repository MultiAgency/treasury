import { createContext, useContext } from "react";
import type { Identity } from "./server-api";
import type { agentReads } from "./queries";

/** The agent the signed-in account was admitted to (`Gate` in `app.tsx`), for every page of it. */
export type AgentView = { reads: ReturnType<typeof agentReads>; identity: Identity };
export const AgentContext = createContext<AgentView | undefined>(undefined);

export function useAgent(): AgentView {
  const agent = useContext(AgentContext);
  if (!agent) throw new Error("an agent page is rendered only inside its frame");
  return agent;
}
