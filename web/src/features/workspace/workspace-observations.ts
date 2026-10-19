import type { GatewayAgent } from "../../app/session";
import { kindOf } from "../../shared/format";
import { useQueries } from "@tanstack/react-query";

import { clientFor } from "../../shared/client";
import { queriesFor } from "../../shared/queries";
import { deniedAt, useAccessState } from "../../shared/access";
import { legacy } from "@legacy";

/** Independent reads retain useful results when another check fails or is slow. */
export function useFleet(agents: GatewayAgent[]) {
  const access = useAccessState();
  const definitions = agents.map(({ name }) => queriesFor(clientFor(`/a/${name}`), `/a/${name}`));
  const setup = useQueries({ queries: definitions.map(q => ({ ...q.setup, refetchInterval: 30_000, retry: false })) });
  const overview = useQueries({ queries: definitions.map(q => ({ ...q.overview, refetchInterval: 30_000, retry: false })) });
  // Agreement requests belong to Payables; the Treasury build has no such reads.
  const needsAgreements = agents.map((agent, i) => !legacy ? false : agent.area ? agent.area === "payables" : overview[i]?.data ? kindOf(overview[i]!.data!) === "facilitator" : true);
  const held = useQueries({ queries: definitions.map(q => ({ ...q.held, refetchInterval: 30_000, retry: false })) });
  const unresolved = useQueries({ queries: definitions.map(q => ({ ...q.unresolved, refetchInterval: 30_000, retry: false })) });
  const autopilot = useQueries({ queries: definitions.map(q => ({ ...q.autopilot, refetchInterval: 30_000, retry: false })) });
  const surface = legacy;
  const agreements = useQueries({ queries: surface ? agents.map(({ name }, i) => ({ ...surface.fleetAgreements(name), enabled: needsAgreements[i], refetchInterval: 30_000, retry: false })) : [] });
  const inbox = useQueries({ queries: definitions.map(q => ({ ...q.inbox, refetchInterval: 30_000, retry: false })) });
  return agents.map(({ name }, i) => {
    const reads = [setup[i]!, overview[i]!, held[i]!, unresolved[i]!, autopilot[i]!, inbox[i]!, ...(needsAgreements[i] && agreements[i] ? [agreements[i]] : [])];
    const labels = ["agent setup", "policy and balances", "held payouts", "unresolved operations", "autopilot settings", "inbox", "agreement requests"];
    const denied = deniedAt(access, `/a/${name}`);
    const observations = { setup: setup[i]!.data, overview: overview[i]!.data, held: held[i]!.data,
      unresolved: unresolved[i]!.data, autopilot: autopilot[i]!.data, inbox: inbox[i]!.data, agreements: agreements[i]?.data };
    const data = denied ? {} as Partial<typeof observations> : observations;
    return { name, data, denied, reads: { overview: overview[i]!, autopilot: autopilot[i]! }, error: reads.find(r => r.error)?.error,
      incomplete: reads.flatMap((r, index) => r.isPending || r.error ? [labels[index]!] : []),
      isPending: reads.some(r => r.isPending),
      dataUpdatedAt: Math.min(...reads.map(r => r.dataUpdatedAt)),
      complete: reads.every(r => r.data !== undefined),
      refetch: () => Promise.all(reads.map(r => r.refetch())),
    };
  });
}
export type AgentState = ReturnType<typeof useFleet>[number]["data"];
