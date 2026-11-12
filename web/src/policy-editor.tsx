import { useState, type ReactNode } from "react";
import { Button, Card, input, Spinner } from "./shared/ui";
import { daoVoteWords, policyComparison } from "./policy-view";
import { allowsAsset, BUDGET, changesOf, type AgentPolicy, type Draft, differences, draftOf, WINDOWS } from "./policy-draft";
import { reviewedPolicyOf, sameReviewedPolicy } from "./policy-review";
import { useOwnerFlow } from "./owner-flow";
import type { AssistantDraft, Identity, OverviewRead } from "./server-api";
import { FromAssistant } from "./assistant-note";
import type { agentReads } from "./queries";
import { fileLabel } from "./dao-filing";
import type { PhaseWords } from "../../apps/server/src/owner-action.ts";
import { ReviewDialog } from "./ui";

type Reads = ReturnType<typeof agentReads>;
const PHASE_WORDS: PhaseWords = {
  open: "Waiting for the signature, or for the DAO's vote.",
  submitted: "Signed; the platform is submitting it.",
  settled: "Done: the platform has the new policy, and the page reads it again.",
  expired: "It expired before it was signed or voted on. The policy is unchanged.",
  failed: "The platform couldn't apply it. The policy is unchanged.",
  unknown: "Its outcome isn't known yet. Nothing is sent again from here.",
  unconfirmed: "The policy action ended without a confirmed outcome. Read the current policy before acting again.",
};

function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: string }) {
  return <label className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-secondary/40 px-3 text-sm has-[:checked]:border-brand/45 md:min-h-9">
    <input type="checkbox" className="size-4 accent-[var(--brand-mint)]" checked={checked} onChange={event => onChange(event.target.checked)} /> {children}</label>;
}

/** A group of the editor's fields: its legend, then its fields. */
function Group({ legend, className = "", children }: { legend: string; className?: string; children: ReactNode }) {
  return <fieldset className="flex min-w-0 flex-col gap-2.5"><legend className="mb-2.5 text-xs font-medium text-muted-foreground">{legend}</legend>
    <div className={`grid gap-3 ${className}`}>{children}</div></fieldset>;
}

/** One change, "Field: before → after", with the before struck through and the after in green; the words are kept whole. */
function ChangeLine({ line }: { line: string }) {
  const match = /^(.*?): (.*) → (.*)$/.exec(line);
  if (!match) return <>{line}</>;
  const [, field, was, now] = match;
  return <><span className="text-muted-foreground">{field}</span>: <span className="text-destructive line-through decoration-1">{was}</span> → <span className="font-medium text-success-muted-foreground">{now}</span></>;
}

type Seed = Extract<AssistantDraft, { kind: "policy" }>["fields"];

/** The form with an assistant's drafted fields filled in: only the fields it names change. */
function seeded(draft: Draft, seed: Seed | undefined): Draft {
  if (!seed) return draft;
  return { ...draft,
    ...(seed.swap !== undefined && { swap: seed.swap }),
    ...(seed.owner_approval !== undefined && { ownerApproval: seed.owner_approval }),
    ...(seed.max_actions_per_hour !== undefined && { rate: seed.max_actions_per_hour === null ? "" : String(seed.max_actions_per_hour) }),
    ...(seed.budget && { budget: { daily_usd: seed.budget.daily_usd ?? "", weekly_usd: seed.budget.weekly_usd ?? "", monthly_usd: seed.budget.monthly_usd ?? "" } }) };
}

/**
 * Edits the envelope and proposes it as one policy update (#134): the owner's wallet signs it here or on the platform's
 * confirm page, or a DAO member files it for the vote, shown the terms before and after first. It is reviewed against the
 * revision it was drafted from: if the policy changes meanwhile, nothing is offered until it is read again. Destinations
 * are not edited here.
 */
export function PolicyEditor({ reads, identity, data, policy, seed, onDone }: { reads: Reads; identity: Identity; data: OverviewRead; policy: AgentPolicy; seed?: Seed; onDone: () => void }) {
  const [baseline] = useState(() => ({ draft: draftOf(policy, data.book), policy: reviewedPolicyOf(data) }));
  // An edit the assistant drafted (#219) fills the form over the policy in force; it's reviewed and signed like any other.
  const [draft, setDraft] = useState(() => seeded(baseline.draft, seed));
  const [reviewing, setReviewing] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const dao = identity.signer === "dao";
  const flow = useOwnerFlow({ reads, identity, kind: "policy_update", words: PHASE_WORDS, reviewDao: true, onFinal: outcome => { if (outcome === "succeeded") onDone(); } });
  const result = changesOf(draft, data.book, policy);
  const lines = differences(baseline.draft, draft, data.book);
  const stale = !sameReviewedPolicy(baseline.policy, reviewedPolicyOf(data));
  const invalid = submitted && "invalid" in result ? result.invalid : undefined;
  const set = (patch: Partial<Draft>) => { setReviewing(false); setDraft({ ...draft, ...patch }); };
  const dirty = lines.length > 0;
  const send = () => {
    setReviewing(false);
    if ("invalid" in result || !baseline.policy) return;
    const expectedPolicy = baseline.policy, changes = result.changes;
    void flow.start(() => reads.agent.policyEdit({ expectedPolicy, changes }));
  };
  const comparison = flow.toFile?.policy ? policyComparison(flow.toFile.policy.current, flow.toFile.policy.requested) : [];

  const field = "flex flex-col gap-1.5 text-sm";
  return <Card>
    <form noValidate className="flex min-w-0 flex-col gap-6" onSubmit={event => {
      event.preventDefault();
      setSubmitted(true);
      if (!("invalid" in result) && dirty && !stale && !flow.busy && !flow.holding) setReviewing(true);
    }}>
      {seed && <FromAssistant />}
      <Group legend="Permissions" className="sm:grid-cols-3">
        <Toggle checked={draft.swap} onChange={swap => set({ swap })}>Swaps allowed</Toggle>
        <Toggle checked={draft.ownerApproval} onChange={ownerApproval => set({ ownerApproval })}>Owner approval for every payment</Toggle>
        <Toggle checked={draft.assets === "any"} onChange={any => set({ assets: any ? "any" : data.book.map(item => item.asset) })}>Any asset</Toggle>
      </Group>
      {draft.assets !== "any" && <fieldset className="flex flex-col gap-2"><legend className="mb-2.5 text-xs font-medium text-muted-foreground">Allowed assets</legend>
        <div className="flex flex-wrap gap-2">{data.book.map(item => <Toggle key={item.asset} checked={draft.assets.includes(item.asset)}
          onChange={on => set({ assets: on ? [...draft.assets as string[], item.asset] : (draft.assets as string[]).filter(asset => asset !== item.asset) })}>{item.symbol}</Toggle>)}</div>
      </fieldset>}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-2.5"><span aria-hidden="true" className="mb-0 text-xs font-medium text-muted-foreground">Rate</span>
          <label className={field}>Actions an hour (blank for no cap)
            <input className={input} inputMode="numeric" value={draft.rate} aria-invalid={invalid === "actions an hour"} onChange={event => set({ rate: event.target.value })} /></label></div>
        <Group legend="USD budget (blank for no limit)" className="grid-cols-3">
          {BUDGET.map(([key, label]) => <label key={key} className={field}>{`USD ${label}`}
            <input className={input} inputMode="decimal" value={draft.budget[key]} aria-invalid={invalid === `the budget ${label}`} onChange={event => set({ budget: { ...draft.budget, [key]: event.target.value } })} /></label>)}
        </Group>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {WINDOWS.map(([window, label]) => <Group key={window} legend={`Caps ${label.toLowerCase()} (blank for no cap)`} className="grid-cols-3">
          {data.book.filter(item => allowsAsset(draft, item.asset)).map(item => <label key={item.asset} className={field}>{`${item.symbol} ${label.toLowerCase()}`}
            <input className={input} inputMode="decimal" value={draft.caps[window][item.asset] ?? ""} aria-invalid={invalid === `${item.symbol} ${label.toLowerCase()}`}
              onChange={event => set({ caps: { ...draft.caps, [window]: { ...draft.caps[window], [item.asset]: event.target.value } } })} /></label>)}
        </Group>)}
      </div>
      {invalid && <p role="alert" className="text-sm text-destructive">The {invalid} isn't a valid amount.</p>}
      {stale && <p role="status" className="text-sm">The policy changed since this draft began. Close the editor and open it again to edit the new one.</p>}
      {!baseline.policy && <p role="status" className="text-sm">The policy's revision isn't reported, so it can't be edited from here.</p>}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        {!dirty && <p className="mr-auto text-sm text-muted-foreground">Nothing is changed yet.</p>}
        {dirty && <p className="mr-auto text-sm text-muted-foreground">{`${lines.length} change${lines.length === 1 ? "" : "s"}`}</p>}
        <Button type="button" variant="ghost" disabled={flow.busy} onClick={() => { if (!dirty || window.confirm("Discard your changes?")) onDone(); }}>Cancel</Button>
        <Button type="submit" disabled={!dirty || stale || flow.busy || flow.holding || !baseline.policy}>{flow.busy && <Spinner />} Review the changes</Button>
      </div>
    </form>
    {flow.toFile && <div role="region" aria-label="Terms before and after" className="flex flex-col gap-3 rounded-lg border border-border p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="font-medium">Compare before you file</h3>
          <p className="text-muted-foreground">The DAO's proposal is public and names only the fields. These are the terms. Its vote must pass within {daoVoteWords()}.</p>
        </div>
        <div className="flex gap-2"><Button variant="ghost" onClick={flow.dropFiling}>Don't file</Button><Button onClick={() => void flow.fileNow()}>{flow.toFile.dao ? fileLabel(flow.toFile.dao.transaction) : "File the DAO proposal"}</Button></div>
      </div>
      {comparison.length ? <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full text-left text-xs">
        <thead><tr className="border-b border-border text-muted-foreground"><th scope="col" className="px-3 py-2 font-medium">Field</th><th scope="col" className="px-3 py-2 font-medium">Now</th><th scope="col" className="px-3 py-2 font-medium">Requested</th></tr></thead>
        <tbody>{comparison.map(row => <tr key={row.field} className="border-b border-border align-top last:border-0"><th scope="row" className="px-3 py-2 font-mono font-normal">{row.field}</th>
          <td className="break-all bg-destructive-muted px-3 py-2 font-mono">{row.was}</td><td className="break-all bg-success-muted px-3 py-2 font-mono">{row.now}</td></tr>)}</tbody></table></div>
        : <p>The platform reported no terms to compare.</p>}
    </div>}
    <div className="flex flex-col gap-2 empty:hidden">{flow.progress}</div>
    <ReviewDialog open={reviewing} busy={flow.busy} onClose={() => setReviewing(false)} title="Change this policy?"
      description={`${dao ? `A DAO member proposes it; you compare the terms, then file it, and the vote must pass within ${daoVoteWords()}.` : "Your wallet signs it, or you sign it on the platform's own page; nothing takes effect without your signature."} It replaces revision ${baseline.policy?.revision ?? "—"}.`}
      actions={<Button disabled={flow.busy} onClick={send}>{dao ? "Prepare for the DAO's vote" : "Sign and apply"}</Button>}>
      <ul aria-label="Changes" className="flex flex-col divide-y divide-border rounded-lg border border-border text-sm">{lines.map(line => <li key={line} className="px-3 py-2"><ChangeLine line={line} /></li>)}</ul>
    </ReviewDialog>
  </Card>;
}
