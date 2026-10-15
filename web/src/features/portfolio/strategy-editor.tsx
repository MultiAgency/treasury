import { useEffect, useRef, useState } from "react";
import type { Strategy } from "../../../../src/strategy-digest";
import { confirmDiscard, useDirtyDraft } from "../../shared/dirty-draft";
import { Field, FieldGroup, focusInvalid } from "../../shared/form";
import { FieldSet, FieldLegend } from "@/components/ui/field";
import { parseStrategyDraft, strategyDraft } from "./strategy-form";
import { Button, Details, ErrorBox, Spinner } from "../../shared/ui";
import { useCanCall } from "../../app/viewer";

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
  const stale = Boolean(latest && latest.digest !== baseDigest);
  const [draft, setDraft] = useState(() => strategyDraft(strategy));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { heading.current?.focus(); }, []);
  const [saved, setSaved] = useState(false);
  useDirtyDraft(!saved && JSON.stringify(draft) !== JSON.stringify(strategyDraft(strategy)));
  const field = (key: "everyMin" | "maxUsd" | "minLegUsd" | "maxCost", label: string) => <Field label={label}
    inputMode={key === "maxCost" ? "decimal" : "numeric"} value={draft[key]} error={errors[key]} disabled={busy}
    onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />;
  const save = async (next: Strategy) => {
    if (busy || stale || !canSave) return;
    setBusy(true); setError(undefined);
    try { await onSave(next, baseDigest); setSaved(true); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : "The strategy could not be saved. Review its current state before trying again."); }
    finally { setBusy(false); }
  };
  return <div className="flex flex-col gap-4">
    <h3 ref={heading} tabIndex={-1} className="scroll-mt-48 font-medium">Edit strategy</h3>
    {stale && latest && <div className="flex flex-col gap-3" role="alert">
      <p>The saved strategy changed. Your draft is preserved. Compare the current settings below before reviewing your draft again.</p>
      <StrategySummary strategy={latest.strategy} nameOf={nameOf} />
      <Button variant="outline" disabled={busy} onClick={() => { setBaseDigest(latest.digest); setError(undefined); }}>Review against latest strategy</Button>
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
      <Details summary="Swap limits" open={Boolean(errors.minLegUsd || errors.maxCost)}>
        <FieldGroup className="grid gap-3 sm:grid-cols-2">{field("minLegUsd", "Minimum swap (USD)")}{field("maxCost", "Maximum swap cost (%)")}</FieldGroup>
        <p className="text-sm text-muted-foreground">The cost limit applies at the minimum received shown in each swap preview.</p>
      </Details>
      <p className="text-sm">Saving turns autopilot off. Review owner authorization next, then choose whether to enable the schedule.</p>
      <p className="text-sm text-muted-foreground">Saving does not change the signed policy. Existing operations may still settle.</p>
      <div className="flex flex-wrap justify-end gap-3"><Button type="button" variant="ghost" disabled={busy} onClick={() => { if (JSON.stringify(draft) === JSON.stringify(strategyDraft(strategy)) || confirmDiscard()) onClose(); }}>Cancel</Button><Button type="submit" disabled={busy || stale || !canSave}>{busy && <Spinner />} Save with autopilot off</Button></div>
    </form>
    <ErrorBox error={error} />
  </div>;
}
