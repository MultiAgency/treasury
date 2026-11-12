import { ago } from "../shared/format";
import { whatIfRows } from "./agents-view";
import type { RiskWhatIf } from "./proposals-api";
import { when } from "./ui";

/** The same source-dated deterministic comparison, whether it came from the form or a conversation. */
export function WhatIfResult({ result }: { result: NonNullable<RiskWhatIf["result"]> }) {
  return <div className="flex flex-col gap-2" role="status">
    <p className="text-sm"><span className="font-medium">If {result.label}:</span></p>
    <dl aria-label="What-if result" className="grid gap-2 text-sm sm:grid-cols-2">
      {whatIfRows(result).map(row => <div key={row.term} className="rounded-lg border border-border bg-background/40 p-3">
        <dt className="text-xs text-muted-foreground">{row.term}</dt>
        <dd className="font-medium tabular-nums">{row.now} → {row.after}</dd>
        <dd className="text-xs text-muted-foreground">{row.detail}</dd>
      </div>)}
    </dl>
    <p className="text-xs text-muted-foreground">On the assessment recorded <time dateTime={result.basedOn.at} title={when(result.basedOn.at)}>{ago(result.basedOn.at)}</time> (log record {result.basedOn.seq}).</p>
  </div>;
}
