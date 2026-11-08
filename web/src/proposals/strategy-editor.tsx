import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { parseStrategyDraft, strategyDraft } from "./strategy-form";
import { confirmDiscard, useDirtyDraft } from "../shared/dirty-draft";
import { Field, FieldGroup, focusInvalid } from "../shared/form";
import { symbolOf } from "../shared/format";
import { Button, Details, ErrorBox, Spinner } from "../shared/ui";
import type { StrategyRead } from "./proposals-api";
import type { agentReads } from "./queries";
import { StrategyTerms } from "./strategy-terms";
import { failureText } from "./words";

/**
 * Editing the saved strategy (`strategy-form.ts`'s form and checks): targets adding up to 100%, the swap limits, and
 * autopilot's interval and ceiling. It's saved over the strategy the draft was reviewed against, by its digest, so a
 * strategy changed meanwhile isn't overwritten. A save refused as `strategy_changed`, or whose answer was lost, reads the
 * strategy again; while the strategy read differs from the reviewed one, the current one is shown and the draft is kept,
 * saved over it only once the owner has reviewed it. Saving turns autopilot off, and the strategy then needs authorizing
 * again.
 */
export function StrategyEditor({ reads, strategy, onDone }: { reads: ReturnType<typeof agentReads>; strategy: StrategyRead; onDone: (saved: boolean) => void }) {
  const client = useQueryClient();
  /** The strategy the draft is saved over: the one shown when editing began, or the current one once reviewed. */
  const [base, setBase] = useState(strategy);
  const [draft, setDraft] = useState(() => strategyDraft(strategy.strategy));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** Set after a save whose answer was lost: a changed strategy may then be this draft's own save. */
  const [maybeSaved, setMaybeSaved] = useState(false);
  const stale = !busy && strategy.digest !== base.digest;
  const dirty = JSON.stringify(draft) !== JSON.stringify(strategyDraft(base.strategy));
  // Focus moves to the editor's heading when it opens, so a keyboard or screen-reader user starts at the form.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  // Leaving for another page, or unloading this one, asks before an unsaved draft is discarded.
  useDirtyDraft(dirty && !busy);
  const field = (key: "everyMin" | "maxUsd" | "minLegUsd" | "maxCost", label: string) => <Field label={label}
    inputMode={key === "maxCost" ? "decimal" : "numeric"} value={draft[key]} error={errors[key]} disabled={busy}
    onChange={event => setDraft({ ...draft, [key]: event.target.value })} />;

  const save = async (next: NonNullable<ReturnType<typeof parseStrategyDraft>["strategy"]>) => {
    setBusy(true);
    setError(undefined);
    const saved = await reads.agent.saveStrategy(next, base.digest);
    setBusy(false);
    if (saved.ok) return onDone(true);
    const lost = saved.kind === "lost" || saved.kind === "unavailable";
    setMaybeSaved(lost);
    if (lost || (saved.kind === "refused" && saved.code === "strategy_changed")) void client.invalidateQueries({ queryKey: reads.strategy.queryKey });
    setError(lost ? "The answer was lost: it may have saved. Saving again is safe: if it did, the changed strategy is shown here instead." : failureText(saved, "autopilot"));
  };
  const review = () => {
    setBase(strategy);
    setError(undefined);
    setMaybeSaved(false);
    heading.current?.focus();
  };

  return <form noValidate className="flex flex-col gap-5" aria-label="Edit strategy" onSubmit={event => {
    event.preventDefault();
    const parsed = parseStrategyDraft(draft);
    setErrors(parsed.errors);
    if (parsed.strategy) void save(parsed.strategy);
    else focusInvalid(event.currentTarget);
  }}>
    <div className="flex flex-col gap-0.5">
      <h3 ref={heading} tabIndex={-1} className="text-base font-semibold">Edit strategy</h3>
      <p className="text-sm text-muted-foreground">Saving turns autopilot off, and the new strategy needs authorizing before autopilot or Run now can act on it. It doesn't change the signed policy.</p>
    </div>
    <FieldSet className="gap-3">
      <FieldLegend variant="label">Target allocation · total 100%</FieldLegend>
      <FieldGroup className="grid gap-3 sm:grid-cols-3">
        {Object.entries(draft.targets).map(([asset, value]) => <Field key={asset} label={`${symbolOf(asset, [])} (%)`} inputMode="decimal" disabled={busy}
          value={value} error={errors[asset] ?? errors.targets} onChange={event => setDraft({ ...draft, targets: { ...draft.targets, [asset]: event.target.value } })} />)}
      </FieldGroup>
    </FieldSet>
    <FieldSet className="gap-3">
      <FieldLegend variant="label">Schedule</FieldLegend>
      <FieldGroup className="grid gap-3 sm:grid-cols-2">
        {field("everyMin", "Run every (minutes)")}
        {field("maxUsd", "Automatic rebalance ceiling (USD)")}
      </FieldGroup>
      <p className="text-xs text-muted-foreground">$0 leaves swaps for proposals you approve. With a grant for the strategy, scheduled runs can still shield public balances.</p>
    </FieldSet>
    <Details summary="Swap limits" className="rounded-lg border border-border px-3">
      <FieldGroup className="grid gap-3 sm:grid-cols-2">{field("minLegUsd", "Minimum swap (USD)")}{field("maxCost", "Maximum swap cost (%)")}</FieldGroup>
      <p className="pb-3 text-xs text-muted-foreground">The cost limit applies at the minimum received shown in each swap's quote.</p>
    </Details>
    {stale && <div role="alert" className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-muted p-4 text-sm">
      <p>{maybeSaved ? "The saved strategy changed, and your save's answer was lost: this may be your own save. Your draft is kept. Review the current strategy before saving again."
        : "The saved strategy changed since you began editing. Your draft is kept. Review the current strategy before saving over it."}</p>
      <StrategyTerms strategy={strategy.strategy} label="Current strategy targets" />
      <Button type="button" variant="outline" className="self-start" onClick={review}>Review against the current strategy</Button>
    </div>}
    <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
      <Button type="button" variant="ghost" disabled={busy} onClick={() => { if (!dirty || confirmDiscard()) onDone(false); }}>Cancel</Button>
      <Button type="submit" disabled={busy || stale}>{busy && <Spinner />} Save with autopilot off</Button>
    </div>
    <ErrorBox error={stale ? undefined : error} />
  </form>;
}
