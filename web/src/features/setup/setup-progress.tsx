import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { useState } from "react";
import type { Overview, Setup } from "../../platform";
import { useAgentReads } from "../../app/frame";
import { accessDenied, ReadFailure } from "../../shared/read-failure";
import { Button, Loading, Section } from "../../shared/ui";
import { nextSetupStep, setupBlock, setupRecordNote } from "./setup-state";

/** The recorded setup actions, read before another is offered. Reads only: nothing is signed or submitted here. */
export function useSetupActions(creationOnly = false) {
  const reads = useAgentReads();
  const query = useQuery({ ...reads.ownerActions, retry: false });
  const records = accessDenied(query.error) || query.isError ? undefined : query.data;
  return { query, setupKey: reads.setup.queryKey, ...setupBlock(records, creationOnly) };
}

/** The setup actions this instance recorded, with a check that reads them and setup again. */
export function SetupActions({ state, compact = false }: { state: ReturnType<typeof useSetupActions>; compact?: boolean }) {
  const cache = useQueryClient();
  const { query, records } = state;
  if (query.isSuccess && !records.length) return null;
  return <Section title={compact ? "Setup status" : "Existing setup actions"} description={compact ? undefined : "Records on this instance only. Check an existing request before preparing another one."}>
    {query.isPending && <Loading label="Checking existing setup actions…" />}
    {query.error && <ReadFailure label="Setup actions" error={query.error} retry={() => query.refetch()} retained={query.data !== undefined} updatedAt={query.dataUpdatedAt} />}
    {records.length > 0 && <ul aria-label="Recorded setup actions" className="flex flex-col gap-3 text-sm">{records.map(a => <li key={a.correlationId} className="flex flex-col gap-1">
      <p className="font-medium">{a.type.replaceAll("_", " ")} · {a.signer === "dao" ? "DAO proposal" : "Owner wallet"}</p>
      <p>{setupRecordNote(a)}</p>
      <p className="break-all font-mono text-xs">{a.correlationId}</p>
    </li>)}</ul>}
    <Button variant="outline" size="sm" className="self-start" disabled={query.isFetching} onClick={() => {
      void query.refetch();
      void cache.invalidateQueries({ queryKey: state.setupKey, exact: true });
    }}>Check setup status</Button>
  </Section>;
}

/**
 * The setup's next step, in the frame under the header, for an agent that exists. Without a grant: what is still to do.
 * Once a grant is reported where this page first saw none, on the same page: where to continue. Otherwise nothing.
 */
export function SetupNextStep({ setup, overview }: { setup: Setup; overview?: Overview }) {
  const pathname = useLocation({ select: location => location.pathname });
  const [entry] = useState({ withoutGrant: !setup.grant, pathname });
  if (!setup.grant) return <IncompleteSetup setup={setup} overview={overview} />;
  if (!entry.withoutGrant || pathname !== entry.pathname) return null;
  const policyKnown = overview?.notInForce === null;
  return <Section title="Continue to your next task" description="An agent and grant are now reported. Each action still requires its own authorization and balance checks.">
    <Button asChild variant="outline" size="sm" className="h-auto max-w-full self-start whitespace-normal"><Link to={policyKnown ? "/automations" : "/policy"}>{policyKnown ? "Continue to Strategy" : "Review policy and permissions"}</Link></Button>
    <p className="text-sm">A grant report does not settle every owner action. <Link to="/activity" className="underline">Review existing action outcomes in Activity</Link>.</p>
  </Section>;
}

function IncompleteSetup({ setup, overview }: { setup: Setup; overview?: Overview }) {
  const state = useSetupActions();
  const next = nextSetupStep(setup, overview);
  return <Section title="Continue setup" description="An agent is configured. Wallet connection, owner approval, policy application and a live grant are separate steps.">
    {state.blocked ? <SetupActions state={state} /> : <>
      <p className="text-sm">{next.policy}</p>
      <p className="text-sm">{next.grant}</p>
      <Button asChild variant="outline" size="sm" className="h-auto max-w-full self-start whitespace-normal"><Link to={next.to}>{next.link}</Link></Button>
      <p className="text-sm text-muted-foreground">Continue in Strategy to review the allocation and schedule separately. Existing records remain available.</p>
    </>}
  </Section>;
}
