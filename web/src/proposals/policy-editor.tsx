import { useState } from "react";
import { Button, Card, input, Spinner } from "../shared/ui";
import { daoVoteWords, policyComparison } from "./policy-view";
import { allowsAsset, BUDGET, changesOf, type AgentPolicy, type Draft, differences, draftOf, WINDOWS } from "./policy-draft";
import { reviewedPolicyOf, sameReviewedPolicy } from "./policy-review";
import { useOwnerFlow } from "./owner-flow";
import type { Identity, OverviewRead } from "./proposals-api";
import type { agentReads } from "./queries";
import { ReviewDialog } from "./ui";

type Reads = ReturnType<typeof agentReads>;
const STAGE_WORDS: Record<string, string> = {
  voting: "Waiting for the signature, or for the DAO's vote.",
  submitting: "Signed; the platform is submitting it.",
  submitted: "Done: the platform has the new policy, and the page reads it again.",
  expired: "It expired before it was signed or voted on. The policy is unchanged.",
  failed: "The platform couldn't apply it. The policy is unchanged.",
  unknown: "Its outcome isn't known yet. Nothing is sent again from here.",
};

function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: string }) {
  return <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} /> {children}</label>;
}

/**
 * Edits the envelope and proposes it as one policy update (#134): the owner's wallet signs it here or on the platform's
 * confirm page, or a DAO member files it for the vote, shown the terms before and after first. It is reviewed against the
 * revision it was drafted from: if the policy changes meanwhile, nothing is offered until it is read again. Destinations
 * are not edited here.
 */
export function PolicyEditor({ reads, identity, data, policy, onDone }: { reads: Reads; identity: Identity; data: OverviewRead; policy: AgentPolicy; onDone: () => void }) {
  const [baseline] = useState(() => ({ draft: draftOf(policy, data.book), policy: reviewedPolicyOf(data) }));
  const [draft, setDraft] = useState(baseline.draft);
  const [reviewing, setReviewing] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const dao = identity.signer === "dao";
  const flow = useOwnerFlow({ reads, identity, is: type => type === "policy_update", words: STAGE_WORDS, reviewDao: true, onFinal: stage => { if (stage === "submitted") onDone(); } });
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

  return <Card>
    <form noValidate className="flex min-w-0 flex-col gap-5" onSubmit={event => {
      event.preventDefault();
      setSubmitted(true);
      if (!("invalid" in result) && dirty && !stale && !flow.busy && !flow.holding) setReviewing(true);
    }}>
      <div className="flex flex-col gap-3">
        <Toggle checked={draft.swap} onChange={swap => set({ swap })}>Swaps allowed</Toggle>
        <Toggle checked={draft.ownerApproval} onChange={ownerApproval => set({ ownerApproval })}>Owner approval for every payment</Toggle>
        <Toggle checked={draft.assets === "any"} onChange={any => set({ assets: any ? "any" : data.book.map(item => item.asset) })}>Any asset</Toggle>
        {draft.assets !== "any" && <fieldset className="flex flex-col gap-2"><legend className="text-sm font-medium">Allowed assets</legend>
          {data.book.map(item => <Toggle key={item.asset} checked={draft.assets.includes(item.asset)}
            onChange={on => set({ assets: on ? [...draft.assets as string[], item.asset] : (draft.assets as string[]).filter(asset => asset !== item.asset) })}>{item.symbol}</Toggle>)}
        </fieldset>}
      </div>
      <label className="flex flex-col gap-1 text-sm">Actions an hour (blank for no cap)
        <input className={input} inputMode="numeric" value={draft.rate} aria-invalid={invalid === "actions an hour"} onChange={event => set({ rate: event.target.value })} /></label>
      <fieldset className="grid gap-3 sm:grid-cols-3"><legend className="text-sm font-medium">USD budget (blank for no limit)</legend>
        {BUDGET.map(([key, label]) => <label key={key} className="flex flex-col gap-1 text-sm">{`USD ${label}`}
          <input className={input} inputMode="decimal" value={draft.budget[key]} aria-invalid={invalid === `the budget ${label}`} onChange={event => set({ budget: { ...draft.budget, [key]: event.target.value } })} /></label>)}
      </fieldset>
      {WINDOWS.map(([window, label]) => <fieldset key={window} className="grid gap-3 sm:grid-cols-2"><legend className="text-sm font-medium">{`Caps ${label.toLowerCase()} (blank for no cap)`}</legend>
        {data.book.filter(item => allowsAsset(draft, item.asset)).map(item => <label key={item.asset} className="flex flex-col gap-1 text-sm">{`${item.symbol} ${label.toLowerCase()}`}
          <input className={input} inputMode="decimal" value={draft.caps[window][item.asset] ?? ""} aria-invalid={invalid === `${item.symbol} ${label.toLowerCase()}`}
            onChange={event => set({ caps: { ...draft.caps, [window]: { ...draft.caps[window], [item.asset]: event.target.value } } })} /></label>)}
      </fieldset>)}
      {invalid && <p role="alert" className="text-sm text-destructive">The {invalid} isn't a valid amount.</p>}
      {stale && <p role="status" className="text-sm">The policy changed since this draft began. Close the editor and open it again to edit the new one.</p>}
      {!baseline.policy && <p role="status" className="text-sm">The policy's revision isn't reported, so it can't be edited from here.</p>}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={!dirty || stale || flow.busy || flow.holding || !baseline.policy}>{flow.busy && <Spinner />} Review the changes</Button>
        <Button type="button" variant="ghost" disabled={flow.busy} onClick={() => { if (!dirty || window.confirm("Discard your changes?")) onDone(); }}>Cancel</Button>
      </div>
      {!dirty && <p className="text-sm text-muted-foreground">Nothing is changed yet.</p>}
    </form>
    {flow.toFile && <div role="region" aria-label="Terms before and after" className="mt-4 flex flex-col gap-2 text-sm">
      <h3 className="font-medium">Compare before you file</h3>
      <p>The DAO's proposal is public and names only the fields. These are the terms. Its vote must pass within {daoVoteWords()}.</p>
      {comparison.length ? <table className="w-full text-left"><thead><tr><th scope="col">Field</th><th scope="col">Now</th><th scope="col">Requested</th></tr></thead>
        <tbody>{comparison.map(row => <tr key={row.field}><th scope="row" className="font-normal">{row.field}</th><td className="break-all">{row.was}</td><td className="break-all">{row.now}</td></tr>)}</tbody></table>
        : <p>The platform reported no terms to compare.</p>}
      <div className="flex gap-3"><Button onClick={() => void flow.fileNow()}>File for the DAO's vote</Button><Button variant="ghost" onClick={flow.dropFiling}>Don't file</Button></div>
    </div>}
    <div className="mt-4 flex flex-col gap-2">{flow.progress}</div>
    <ReviewDialog open={reviewing} busy={flow.busy} onClose={() => setReviewing(false)} title="Change this policy?"
      description={`${dao ? `A DAO member proposes it; you compare the terms, then file it, and the vote must pass within ${daoVoteWords()}.` : "Your wallet signs it, or you sign it on the platform's own page; nothing takes effect without your signature."} It replaces revision ${baseline.policy?.revision ?? "—"}.`}
      actions={<Button disabled={flow.busy} onClick={send}>{dao ? "Prepare for the DAO's vote" : "Sign and apply"}</Button>}>
      <ul aria-label="Changes" className="flex flex-col gap-1 text-sm">{lines.map(line => <li key={line}>{line}</li>)}</ul>
    </ReviewDialog>
  </Card>;
}
