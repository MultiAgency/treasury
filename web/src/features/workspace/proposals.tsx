import { gatewayQueries } from "../../app/queries";
import { CheckCircle, WarningOctagon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { Decoded } from "../../../../src/gateway/proposals.js";
import { ago, minutesSeconds, useCountdown } from "../../shared/lib";
import { Badge, Card, Details, Section, Spinner, type Tone } from "../../shared/ui";
import { visibleProposals, useAccessState } from "../../shared/access";

import { describeProposal, matchesHistory, type HistoryFilters } from "./activity-filters";

const TYPE_WORDS: Record<string, string> = {
  agent_create: "Create the agent",
  grant_issue: "Issue a grant to the agent's server",
  grant_revoke: "Revoke a grant",
  agent_freeze: "Freeze the agent",
  agent_unfreeze: "Unfreeze the agent",
  policy_update: "Change the agent's policy",
  approval_vote: "Release or reject a held payment",
};

function Window({ expiresAt }: { expiresAt: string }) {
  const left = useCountdown(expiresAt) ?? 0;
  return left === 0 ? (
    <Badge tone="destructive">signing window closed</Badge>
  ) : (
    <Badge tone={left < 120 ? "warning" : "info"}>
      {minutesSeconds(left)} left to vote
    </Badge>
  );
}

const VERDICT: Record<Decoded["what"], [Tone, string]> = {
  agent: ["success", "Verified"],
  unknown: ["destructive", "Not prepared by this dashboard"],
  unchecked: ["warning", "Can't be checked yet"],
  past: ["neutral", "Done"],
  trezu: ["neutral", "Trezu confidential payment"],
  other: ["warning", "Signs for another key"],
};

/**
 * A proposal description in a few words. Sputnik descriptions are "* Key: value" fields joined by <br>;
 * the action field says what it asks (ours and Trezu's both set it). Anything else shows its first line.
 */
function titleOf(p: Decoded): string {
  if (p.what === "trezu") return "A payment from the DAO's confidential treasury; Trezu keeps its details private";
  const fields = p.description.split(/<br\s*\/?>/i).map((f) => f.replace(/^\s*\*\s*/, "").trim());
  const action = fields.find((f) => /^Proposal Action:/i.test(f))?.replace(/^Proposal Action:\s*/i, "").replace(/\.$/, "");
  return action || fields[0] || `Proposal #${p.id}`;
}

function Proposal({ p, dao }: { p: Decoded; dao: string }) {
  const [tone, label] =
    p.what !== "agent"
      ? VERDICT[p.what]
      : p.check.kind === "mismatch"
        ? (["destructive", "Hash doesn't match"] as const)
        : p.state === "expired"
          ? (["neutral", "Window closed"] as const)
          : p.state === "done"
            ? (["neutral", "Signed and submitted"] as const)
            : VERDICT.agent;
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">#{p.id}</span>
        <span className="flex-1">{p.what === "agent" ? `${TYPE_WORDS[p.type] ?? p.type} · ${p.agent}` : titleOf(p)}</span>
        <Badge tone={tone}>
          {tone === "success" ? <CheckCircle size={14} /> : tone === "destructive" ? <WarningOctagon size={14} /> : null}
          {label}
        </Badge>
        {p.what === "agent" && p.status === "InProgress" && p.state === "waiting" && <Window expiresAt={p.expiresAt} />}
      </div>
      <div className="text-sm text-muted-foreground">
        {p.status} · filed by {p.proposer} {ago(p.submittedAt)}
        {p.status === "InProgress" && (
          <>
            {" · "}
            <a className="underline hover:text-foreground" href={`https://trezu.app/${dao}/requests/${p.id}`} target="_blank" rel="noreferrer">
              vote in Trezu
            </a>
          </>
        )}
      </div>
      {p.what === "unknown" && (
        <p className="text-sm text-destructive-muted-foreground">
          It asks the DAO to sign as the agents' owner, but no agent here prepared it. Don't approve it unless you know where it comes from.
        </p>
      )}
      {p.what === "unchecked" && (
        <p className="text-sm text-warning-muted-foreground">
          No agent that answered prepared it, and {p.unanswered.join(" and ")} didn't answer, so it can't be checked yet. Wait for this page to
          refresh before voting.
        </p>
      )}
      {p.what === "agent" && p.check.kind === "mismatch" && <p className="text-sm text-destructive-muted-foreground">Don't approve: {p.check.reason}.</p>}
      {p.what === "agent" && p.state === "expired" && p.status === "InProgress" && (
        <p className="text-sm text-muted-foreground">
          The API's signing window closed {ago(p.expiresAt)}, so approving it now does nothing. Reject it, or let it lapse, and file the
          action again if it is still wanted.
        </p>
      )}
      {p.what !== "agent" && p.what !== "trezu" && p.description !== titleOf(p) && (
        <Details summary="Full description">
          <p className="whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">{p.description.replace(/<br\s*\/?>\s*/gi, "\n")}</p>
        </Details>
      )}
      {p.what === "agent" && p.check.kind === "verified" && (
        <Details summary="What the signature authorizes">
          {p.check.standard === "nep413" ? (
            <pre className="overflow-x-auto rounded-xl bg-muted p-3 font-mono text-xs">{JSON.stringify(p.check.message, null, 2)}</pre>
          ) : (
            <p>
              A transaction to <span className="font-mono">{p.check.receiver}</span> calling{" "}
              <span className="font-mono">{p.check.methods.join(", ")}</span>. Its policy data is encrypted for the wallet provider, so only
              its target and methods can be checked.
            </p>
          )}
          <p className="break-all font-mono text-xs text-muted-foreground">hash {p.hash}</p>
        </Details>
      )}
    </li>
  );
}

export function ProposalRecords({ dao, data, error, history = false, filters }: { dao: string; data?: Decoded[]; error: Error | null; history?: boolean; filters?: HistoryFilters }) {
  const access = useAccessState();
  // One DAO can retain accessible agents. Filter decoded private payloads even when a read begun
  // before an agent's denial returns successfully after it.
  const accessible = visibleProposals(data ?? [], access);
  const visible = filters ? accessible.filter(p => matchesHistory(describeProposal(p), filters)) : accessible;
  const open = visible.filter(p => p.status === "InProgress");
  const recent = visible.filter(p => p.status !== "InProgress");
  if (!history && data && !error && !open.length) return null;
  return <div className="flex flex-col gap-3">
        <h3 className="font-medium">{history ? "Proposal history" : "What am I voting on?"} · {dao}</h3>
        <p className="text-sm text-muted-foreground">Each request to sign as the agents' owner is matched to what an agent prepared, with its hash recomputed from that payload.</p>
        {error ? (
          <p className="text-sm text-destructive-muted-foreground">{error.message}</p>
        ) : !data ? (
          <Spinner />
        ) : (
          <ul className="flex flex-col divide-y">
            {history && open.length === 0 && recent.length === 0 && <li className="text-sm text-muted-foreground">{accessible.length ? "No proposals match these filters." : "No proposals returned by this DAO."}</li>}
            {open.map((p) => <Proposal key={p.id} p={p} dao={dao} />)}
          </ul>
        )}
        {history && !error && recent.length > 0 && <Details summary={`Recent completed proposals (${recent.length})`}>
          <ul className="flex flex-col divide-y">{recent.map(p => <Proposal key={p.id} p={p} dao={dao} />)}</ul>
        </Details>}
      </div>;
}

export function Proposals({ dao }: { dao: string }) {
  const proposals = useQuery(gatewayQueries.proposals(dao));
  return <Section title="DAO proposals" description="Proposal history returned by this DAO. Agent records remain scoped to their own area.">
    <Card><ProposalRecords dao={dao} data={proposals.data} error={proposals.error} history /></Card>
  </Section>;
}
