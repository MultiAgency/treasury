import { useEffect, useRef, useState } from "react";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { parseStrategyDraft, strategyDraft } from "../features/portfolio/strategy-form";
import { confirmDiscard } from "../shared/dirty-draft";
import { Field, FieldGroup, focusInvalid } from "../shared/form";
import { symbolOf } from "../shared/format";
import { Button, Details, ErrorBox, Spinner } from "../shared/ui";
import type { StrategyRead } from "./proposals-api";
import type { agentReads } from "./queries";
import { failureText } from "./words";

/**
 * Warns before leaving the page with unsaved changes. The proposals page has no router: every navigation is a page
 * load, so the browser's own prompt covers it (the owner UI's `useDirtyDraft` needs TanStack Router).
 */
function useUnsavedDraft(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}

/**
 * Editing the saved strategy (the owner UI's form and its checks): targets adding up to 100%, the swap limits, and
 * autopilot's interval and ceiling. It's saved over the strategy shown, by its digest, so a strategy changed meanwhile
 * isn't overwritten; the draft is kept for review. Saving turns autopilot off, and the strategy then needs authorizing
 * again. After a lost answer the draft is kept: saving again is safe, since a strategy the first save already changed is
 * refused (`strategy_changed`) rather than saved twice.
 */
export function StrategyEditor({ reads, strategy, onDone }: { reads: ReturnType<typeof agentReads>; strategy: StrategyRead; onDone: (saved: boolean) => void }) {
  const [draft, setDraft] = useState(() => strategyDraft(strategy.strategy));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dirty = JSON.stringify(draft) !== JSON.stringify(strategyDraft(strategy.strategy));
  // Focus moves to the editor's heading when it opens, so a keyboard or screen-reader user starts at the form.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  useUnsavedDraft(dirty && !busy);
  const field = (key: "everyMin" | "maxUsd" | "minLegUsd" | "maxCost", label: string) => <Field label={label}
    inputMode={key === "maxCost" ? "decimal" : "numeric"} value={draft[key]} error={errors[key]} disabled={busy}
    onChange={event => setDraft({ ...draft, [key]: event.target.value })} />;

  const save = async (next: NonNullable<ReturnType<typeof parseStrategyDraft>["strategy"]>) => {
    setBusy(true);
    setError(undefined);
    const saved = await reads.agent.saveStrategy(next, strategy.digest);
    setBusy(false);
    if (saved.ok) return onDone(true);
    setError(saved.kind === "lost" || saved.kind === "unavailable"
      ? "The answer was lost: it may have saved. Saving again is safe: if it did, the strategy has changed and this save is refused." : failureText(saved, "autopilot"));
  };

  return <form noValidate className="flex flex-col gap-4" aria-label="Edit strategy" onSubmit={event => {
    event.preventDefault();
    const parsed = parseStrategyDraft(draft);
    setErrors(parsed.errors);
    if (parsed.strategy) void save(parsed.strategy);
    else focusInvalid(event.currentTarget);
  }}>
    <h3 ref={heading} tabIndex={-1} className="text-base font-semibold">Edit strategy</h3>
    <FieldSet className="gap-3">
      <FieldLegend variant="label">Target allocation · total 100%</FieldLegend>
      <FieldGroup className="grid gap-3 sm:grid-cols-3">
        {Object.entries(draft.targets).map(([asset, value]) => <Field key={asset} label={`${symbolOf(asset, [])} (%)`} inputMode="decimal" disabled={busy}
          value={value} error={errors[asset] ?? errors.targets} onChange={event => setDraft({ ...draft, targets: { ...draft.targets, [asset]: event.target.value } })} />)}
      </FieldGroup>
    </FieldSet>
    <FieldGroup className="grid gap-3 sm:grid-cols-2">
      {field("everyMin", "Run every (minutes)")}
      {field("maxUsd", "Automatic rebalance ceiling (USD)")}
    </FieldGroup>
    <p className="text-sm text-muted-foreground">$0 leaves swaps for proposals you approve. With a grant for the strategy, scheduled runs can still shield public balances.</p>
    <Details summary="Swap limits">
      <FieldGroup className="grid gap-3 sm:grid-cols-2">{field("minLegUsd", "Minimum swap (USD)")}{field("maxCost", "Maximum swap cost (%)")}</FieldGroup>
      <p className="text-sm text-muted-foreground">The cost limit applies at the minimum received shown in each swap's quote.</p>
    </Details>
    <p className="text-sm">Saving turns autopilot off, and the new strategy needs authorizing before autopilot or Run now can act on it. It doesn't change the signed policy.</p>
    <div className="flex flex-wrap justify-end gap-3">
      <Button type="button" variant="ghost" disabled={busy} onClick={() => { if (!dirty || confirmDiscard()) onDone(false); }}>Cancel</Button>
      <Button type="submit" disabled={busy}>{busy && <Spinner />} Save with autopilot off</Button>
    </div>
    <ErrorBox error={error} />
  </form>;
}
