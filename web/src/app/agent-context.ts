import { createContext, useContext } from "react";
import type { Overview } from "../shared/lib";
import type { Setup } from "../features/owner/owner";
import type { Treasury } from "../features/funding/treasury";

type Agent = { setup: Setup; data: Overview; treasury: Treasury | null };
export const AgentContext = createContext<Agent | null>(null);
export const useOptionalAgent = () => useContext(AgentContext);
export function useAgent() {
  const agent = useOptionalAgent();
  if (!agent) throw new Error("Agent observations unavailable");
  return agent;
}
