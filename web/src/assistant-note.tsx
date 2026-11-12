import { Sparkle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { AssistantDraft } from "./server-api";

type Leg = NonNullable<Extract<AssistantDraft, { kind: "strategy" }>["legs"]>[number];

/**
 * Said in a review flow the assistant opened (#219): what it filled in, and that nothing is sent until the owner submits
 * the form and signs, exactly as without it.
 */
export function FromAssistant({ children }: { children?: ReactNode }) {
  return <div role="note" aria-label="Filled in by the assistant" className="flex gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
    <Sparkle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
    <div className="flex min-w-0 flex-col gap-1.5">
      <p><span className="font-medium">Filled in by the assistant.</span> Review every field: nothing is sent until you submit it and sign.</p>
      {children}
    </div>
  </div>;
}

/** The swaps a rebalance would make at the prices the assistant read: an estimate, quoted again when proposed. */
export function SwapPreview({ legs }: { legs: readonly Leg[] }) {
  if (!legs.length) return null;
  return <div className="flex flex-col gap-1 text-xs">
    <p className="text-muted-foreground">A rebalance would swap, at the prices read (quoted again when proposed):</p>
    <ul aria-label="Estimated swaps" className="flex flex-col gap-0.5">
      {legs.map(leg => <li key={`${leg.sell}-${leg.buy}`} className="font-mono tabular-nums">{leg.sell} → {leg.buy} · ${leg.usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</li>)}
    </ul>
  </div>;
}
