import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, type LinkProps } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { ownerName, useAgent, useAgentReads } from "../../app/frame";
import { AGENT } from "../../app/location";
import { useCanCall, useViewer } from "../../app/viewer";
import { scope } from "../../platform";
import { fromUnits, swaps } from "../../shared/format";
import { Badge, Button, Details, QueryError, Spinner, type Tone } from "../../shared/ui";

// An observation is only a hint for the next step. Every action is still authorized by the platform when it is taken.
const OBSERVATION_MAX_AGE = 60_000;
type Observation = { isSuccess: boolean; isError: boolean; dataUpdatedAt: number };
const observationCurrent = (query: Observation, now: number) =>
  query.isSuccess && !query.isError && query.dataUpdatedAt > 0 && now - query.dataUpdatedAt < OBSERVATION_MAX_AGE;

type Check = {
  label: string;
  status: string;
  detail: string;
  blocked: boolean;
  tone?: Tone;
  link?: { to: LinkProps["to"]; hash?: string; label: string };
};

/** A numbered stage of a real sequence, never scripted progress or inferred completion. */
export function RunStep({ id, number, title, children }: { id?: string; number: number; title: string; children: ReactNode }) {
  return <li id={id} className="flex min-w-0 scroll-mt-24 flex-col gap-5 border-t pt-6">
    <h3 className="flex items-center gap-3 text-lg font-semibold">
      <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full border text-sm">{number}</span>
      {title}
    </h3>
    {children}
  </li>;
}

/** This Treasury's readiness for a rebalance, from current observations. It authorizes nothing. */
export function useRunChecks() {
  const { setup, data } = useAgent();
  const agentReads = useAgentReads();
  const canPrepare = useCanCall("rebalance");
  const canExecute = useCanCall("executePlan");
  const setupRead = useQuery({ ...agentReads.setup, refetchInterval: 30_000 });
  const overviewRead = useQuery(agentReads.overview);
  const unresolved = useQuery({ ...agentReads.unresolved, refetchInterval: 5_000 });
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    // Expiry and stale observations change what is available without another answer.
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const observations = [setupRead, overviewRead, unresolved];
  const current = observations.every(query => observationCurrent(query, now));
  const readFailed = observations.some(query => query.isError);
  const checking = observations.some(query => query.isPending);
  const executor = setup.executor === true;
  const policyKnown = data.notInForce === null && Boolean(data.policy.policy);
  const grant = setup.grant;
  const providerGrant = data.grants.find(record => record.grant_id === grant?.id);
  const expires = grant ? Date.parse(grant.expiresAt) : NaN;
  const expired = Number.isFinite(expires) && expires <= now;
  const liveGrant = Boolean(grant && expires > now && providerGrant && !providerGrant.revoked_at
    && Date.parse(providerGrant.expires_at) > now && providerGrant.label === grant.label);
  const grantPurpose = Boolean(grant && (grant.label === "treasury" || grant.label.startsWith("treasury:")));
  const supported = swaps(data);
  const funded = data.book.some(holding => BigInt(holding.public) + BigInt(holding.confidential) > 0n);
  const unresolvedCount = unresolved.data?.length;
  const observationDetail = readFailed ? "An observation failed. Check again before preparing a new action."
    : checking ? "Checking this agent’s policy, grant and unresolved operations."
      : "Observations are over a minute old. Refresh them before preparing a new action.";
  const checks: Check[] = [
    ...(!current ? [{ label: "Observations", status: readFailed ? "Unavailable" : checking ? "Checking" : "Refresh needed", detail: observationDetail, blocked: true }] : []),
    {
      label: "Your access", status: canPrepare ? canExecute ? "Can prepare and execute" : "Can prepare" : "Review only", blocked: !canPrepare,
      detail: canPrepare ? canExecute ? "You may prepare and execute this action; each operation still requires authorization." : "You may prepare a preview. Executing it requires execution permission."
        : "Your account cannot prepare this action. You can review records and use the owner approvals available to your account.",
    },
    {
      label: "This instance", status: executor ? "Executor" : setup.executor === false ? "Approve-only" : "Unconfirmed", blocked: !executor,
      detail: executor ? "This instance submits actions for this agent." : "Run a rebalance on this agent’s executor. Existing records remain available here.",
    },
    {
      label: "Policy", status: !current ? "Unconfirmed" : policyKnown && supported ? "In force at last check" : "Review needed",
      blocked: !policyKnown || !supported,
      detail: !current ? "Refresh observations to confirm the policy."
        : !policyKnown ? data.notInForce ?? "No applied policy was reported."
          : !supported ? "The current policy does not allow swaps."
            : "The provider enforces the signed policy. The amount, assets and destinations are checked for each action.",
      link: { to: "/policy", label: "Review policy and limits" },
    },
    {
      label: "Send grant", status: !current ? "Unconfirmed" : expired ? "Expired" : liveGrant && grantPurpose ? "Live at last check" : "Review needed",
      blocked: !liveGrant || !grantPurpose,
      detail: !current ? "Refresh observations to confirm the grant."
        : !grant ? "No current grant was reported. The owner must authorize the saved strategy before new sends."
          : expired ? "The reported grant has expired. The owner must authorize a new grant."
            : !liveGrant ? "The reported grant could not be matched to a live provider record. Check the grant before proceeding."
              : !grantPurpose ? `The ${grant.label} grant does not permit this action.`
                : `${grant.label} · expires ${new Date(expires).toLocaleString()}.`,
      link: { to: "/automations", label: "Review strategy and grant" },
    },
    {
      label: "Funds", status: !current ? "Unconfirmed" : funded ? "Balance observed" : "Funding needed", blocked: !funded,
      detail: !current ? "Refresh observations to confirm balances."
        : funded ? "Observed balances are shown below. Held payouts can reserve part of a balance; each send checks what remains available."
          : "Fund the agent before previewing swaps toward its target allocation.",
      link: { to: "/funding", label: "Balances & funding" },
    },
    {
      label: "Unresolved operations", status: !current ? "Unconfirmed" : unresolvedCount ? `${unresolvedCount} unresolved` : "None recorded here",
      blocked: unresolvedCount === undefined || unresolvedCount > 0,
      detail: !current ? "Refresh the operation records before sending."
        : unresolvedCount ? "An unknown outcome blocks new sends. Review the existing operation before starting another."
          : "Held payouts remain open for approval and do not block new sends.",
      link: { to: "/activity", label: "Review Activity and recovery" },
    },
  ];
  const firstBlocker = checks.find(check => check.blocked);
  return { checks, firstBlocker, observations, current };
}

/** The first step of a run: this agent's checks, with the first blocker in front. */
export function AgentChecks({ run, open = false }: { run: ReturnType<typeof useRunChecks>; open?: boolean }) {
  const { setup, data } = useAgent();
  const viewer = useViewer();
  const cache = useQueryClient();
  const { checks, firstBlocker, observations, current } = run;
  const fetching = observations.some(query => query.isFetching);
  return <>
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <p className="max-w-prose text-muted-foreground">{firstBlocker ? "Resolve the check below before a new action." : "Observations checked. The server and provider check authorization again when you act."}</p>
      <Button variant="outline" size="sm" disabled={fetching} onClick={() => { void cache.invalidateQueries({ queryKey: [scope(AGENT!, viewer?.account ?? null)] }); }}>
        {fetching && <Spinner />} {fetching ? "Checking observations…" : "Check observations"}
      </Button>
    </div>
    {observations.map((query, index) => query.error && <QueryError key={index} error={query.error} retry={() => { void query.refetch(); }} />)}
    {firstBlocker && <div className="flex flex-col items-start gap-2 rounded-xl bg-muted px-4 py-3 text-sm">
      <p className="font-medium">{firstBlocker.label}: {firstBlocker.status}</p>
      <p className="max-w-prose text-muted-foreground">{firstBlocker.detail}</p>
      {firstBlocker.link && <Link to={firstBlocker.link.to} hash={firstBlocker.link.hash} className="underline">{firstBlocker.link.label}</Link>}
    </div>}
    <Details summary="Agent details and prerequisite checks" open={open}>
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div><dt className="text-muted-foreground">Owner</dt><dd className="break-all">{ownerName(setup)}</dd></div>
        <div><dt className="text-muted-foreground">Agent</dt><dd className="break-all">{data.agentId}</dd></div>
        <div><dt className="text-muted-foreground">Agent wallet</dt><dd className="break-all">{setup.wallet ?? "Not reported"}</dd></div>
        <div><dt className="text-muted-foreground">Your account</dt><dd className="break-all">{viewer?.account ?? "Not signed in"}</dd></div>
      </dl>
      <p className="text-sm text-muted-foreground">These observations guide your next step. They do not authorize a send.</p>
      <dl className="divide-y">
        {checks.map(check => <div key={check.label} className="grid gap-2 py-4 text-sm sm:grid-cols-[11rem_1fr]">
          <dt className="font-medium">{check.label}</dt>
          <dd className="flex min-w-0 flex-col items-start gap-2">
            <Badge tone={check.tone ?? (check.blocked ? "warning" : "neutral")}>{check.status}</Badge>
            <p className="max-w-prose break-words text-muted-foreground">{check.detail}</p>
            {check.link && <Link to={check.link.to} hash={check.link.hash} className="underline">{check.link.label}</Link>}
          </dd>
        </div>)}
      </dl>
      <Details summary={current ? "Observed balances" : "Previously reported balances · refresh needed"}>
        <ul className="divide-y">
          {data.book.map(holding => <li key={holding.asset} className="flex flex-wrap justify-between gap-2 py-3">
            <span className="font-medium">{holding.symbol}</span>
            <span className="flex flex-wrap gap-x-4 gap-y-1 break-all text-muted-foreground">
              <span>Public {fromUnits(holding.public.toString(), holding.decimals)}</span>
              <span>Confidential {fromUnits(holding.confidential.toString(), holding.decimals)}</span>
            </span>
          </li>)}
        </ul>
        {data.book.length === 0 && <p>No managed balance rows were reported.</p>}
        <p className="text-muted-foreground">Amounts are in each row’s asset. Balances do not establish the amount available after held payouts.</p>
      </Details>
    </Details>
  </>;
}
