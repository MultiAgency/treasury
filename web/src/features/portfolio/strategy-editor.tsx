import { useEffect, useMemo, useRef, useState } from "react";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { useCanCall } from "../../app/viewer";
import { failureKind, type Strategy } from "../../platform";
import { confirmDiscard, useDirtyDraft } from "../../shared/dirty-draft";
import { Field, FieldGroup, focusInvalid } from "../../shared/form";
import { Button, Details, ErrorBox, errorMessage, Spinner } from "../../shared/ui";
import { parseStrategyDraft, strategyDraft } from "./strategy-form";

export function StrategySummary({ strategy, nameOf, advanced = true }: { strategy: Strategy; nameOf: (asset: string) => string; advanced?: boolean }) {
  return <dl className="grid gap-3 text-sm sm:grid-cols-2">
    <div><dt className="text-muted-foreground">Target allocation</dt><dd>{Object.entries(strategy.targetBps).map(([asset, bps]) => `${bps / 100}% ${nameOf(asset)}`).join(" · ")}</dd></div>
    <div><dt className="text-muted-foreground">Schedule</dt><dd>Every {strategy.autopilot.everyMin} minutes</dd></div>
    <div><dt className="text-muted-foreground">Automatic rebalance ceiling</dt><dd>${strategy.autopilot.maxUsd}{strategy.autopilot.maxUsd === 0 && " · swaps require manual execution"}</dd></div>
    {advanced && <div><dt className="text-muted-foreground">Minimum swap</dt><dd>${strategy.minLegUsd}</dd></div>}
    {advanced && <div><dt className="text-muted-foreground">Maximum swap cost</dt><dd>{strategy.maxCostBps / 100}%</dd></div>}
  </dl>;
}

/** Saves configuration with the schedule off. Owner authorization remains a separate review. */
export function StrategyEditor({ strategy, digest, latest, nameOf, onSave, onClose }: {
  strategy: Strategy;
  digest: string;
  latest?: { strategy: Strategy; digest: string };
  nameOf: (asset: string) => string;
  onSave: (strategy: Strategy, expectedDigest: string) => Promise<void>;
  onClose: () => void;
}) {
  const canSave = useCanCall("strategy/save");
  const heading = useRef<HTMLHeadingElement>(null);
  const [baseDigest, setBaseDigest] = useState(digest);
  const [busy, setBusy] = useState(false);
  /** Set after a save whose outcome is unknown: a changed strategy may then be this draft's own save. */
  const [maybeSaved, setMaybeSaved] = useState(false);
  // Not while this draft's own save runs: the strategy is read again before the editor closes.
  const stale = Boolean(!busy && latest && latest.digest !== baseDigest);
  const [draft, setDraft] = useState(() => strategyDraft(strategy));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  useEffect(() => { heading.current?.focus(); }, []);
  const [saved, setSaved] = useState(false);
  const baseline = useMemo(() => JSON.stringify(strategyDraft(strategy)), [strategy]);
  const dirty = JSON.stringify(draft) !== baseline;
  useDirtyDraft(!saved && dirty);
  const field = (key: "everyMin" | "maxUsd" | "minLegUsd" | "maxCost", label: string) => <Field label={label}
    inputMode={key === "maxCost" ? "decimal" : "numeric"} value={draft[key]} error={errors[key]} disabled={busy}
    onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />;
  const save = async (next: Strategy) => {
    if (busy || stale || !canSave) return;
    setBusy(true); setError(undefined);
    try { await onSave(next, baseDigest); setSaved(true); onClose(); }
    catch (e) { setError(errorMessage(e)); setMaybeSaved(failureKind(e) === "unknown"); }
    finally { setBusy(false); }
  };
  return <div className="flex flex-col gap-4">
    <h4 ref={heading} tabIndex={-1} className="scroll-mt-48 font-medium">Edit strategy</h4>
    {stale && latest && <div className="flex flex-col gap-3" role="alert">
      <p>{maybeSaved ? "The saved strategy changed, and your save’s outcome is unknown: it may have applied. Your draft is preserved. Review the current strategy below before saving again."
        : "The saved strategy changed. Your draft is preserved. Compare the current settings below before reviewing your draft again."}</p>
      <StrategySummary strategy={latest.strategy} nameOf={nameOf} />
      <Button variant="outline" disabled={busy} onClick={() => { setBaseDigest(latest.digest); setError(undefined); setMaybeSaved(false); }}>Review against latest strategy</Button>
    </div>}
    <form className="flex flex-col gap-4" noValidate onSubmit={(e) => {
      e.preventDefault();
      const parsed = parseStrategyDraft(draft);
      setErrors(parsed.errors);
      if (parsed.strategy) void save(parsed.strategy);
      else focusInvalid(e.currentTarget);
    }}>
      <FieldSet className="gap-3">
        <FieldLegend variant="label">Target allocation · total 100%</FieldLegend>
        <FieldGroup className="grid gap-3 sm:grid-cols-3">
          {Object.entries(draft.targets).map(([asset, value]) => <Field key={asset} label={`${nameOf(asset)} (%)`} inputMode="decimal" disabled={busy}
            value={value} error={errors[asset] ?? errors.targets}
            onChange={(e) => setDraft({ ...draft, targets: { ...draft.targets, [asset]: e.target.value } })} />)}
        </FieldGroup>
      </FieldSet>
      <FieldGroup className="grid gap-3 sm:grid-cols-2">
        {field("everyMin", "Run every (minutes)")}
        {field("maxUsd", "Automatic rebalance ceiling (USD)")}
      </FieldGroup>
      <p className="text-sm text-muted-foreground">$0 leaves swaps for manual execution. With a matching grant, scheduled runs can still shield public balances.</p>
      <Details summary="Swap limits">
        <FieldGroup className="grid gap-3 sm:grid-cols-2">{field("minLegUsd", "Minimum swap (USD)")}{field("maxCost", "Maximum swap cost (%)")}</FieldGroup>
        <p className="text-sm text-muted-foreground">The cost limit applies at the minimum received shown in each swap preview.</p>
      </Details>
      <p className="text-sm">Saving turns autopilot off. Review owner authorization next, then choose whether to enable the schedule.</p>
      <p className="text-sm text-muted-foreground">Saving does not change the signed policy. Existing operations may still settle.</p>
      <div className="flex flex-wrap justify-end gap-3"><Button type="button" variant="ghost" disabled={busy} onClick={() => { if (!dirty || confirmDiscard()) onClose(); }}>Cancel</Button><Button type="submit" disabled={busy || stale || !canSave}>{busy && <Spinner />} Save with autopilot off</Button></div>
    </form>
    <ErrorBox error={error} />
  </div>;
}
