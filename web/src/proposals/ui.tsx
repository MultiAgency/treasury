import type { ProposalView } from "@multiagency/sdk";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { amountOf, usd } from "../shared/format";
import { Badge, Button, reviewDialog, type Tone } from "../shared/ui";
import { STATE_WORDS } from "./words";

/**
 * A review dialog, open while `open`: native, so focus is trapped and Escape closes it, except while `busy` (the wallet
 * or the server is at work, and what it answers is shown here). Closing it any way calls `onClose`, and focus returns to
 * what opened it.
 */
export function ReviewDialog({ open, busy = false, onClose, title, description, children, actions }: {
  open: boolean; busy?: boolean; onClose: () => void; title: string; description: string; children?: ReactNode; actions?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId(), descriptionId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) { opener.current = document.activeElement; element.showModal(); }
    if (!open && element.open) element.close();
  }, [open]);
  return <dialog ref={dialog} aria-labelledby={titleId} aria-describedby={descriptionId} className={reviewDialog}
    onCancel={event => { if (busy) event.preventDefault(); }}
    onClose={() => { onClose(); if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus(); }}>
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 id={titleId} className="text-lg font-medium">{title}</h2>
        <p id={descriptionId} className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
      <div className="flex flex-wrap justify-end gap-3">
        <Button variant="ghost" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</Button>
        {actions}
      </div>
    </div>
  </dialog>;
}

/** The exact text the wallet will sign, as the SDK builds it: never summarised. */
export function SignedText({ text, label = "Text to sign" }: { text: string; label?: string }) {
  return <figure className="flex flex-col gap-2">
    <figcaption className="text-sm font-medium">{label}</figcaption>
    <pre tabIndex={0} aria-label={label} className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 font-mono text-xs">{text}</pre>
  </figure>;
}

const TONES: Partial<Record<ProposalView["state"], Tone>> = {
  proposed: "info", approved: "info", executing: "warning", unknown: "warning", executed: "success", stopped: "destructive",
};
export const StateBadge = ({ state }: { state: ProposalView["state"] }) => <Badge tone={TONES[state] ?? "neutral"}>{STATE_WORDS[state]}</Badge>;

const NO_BOOK: never[] = [];
/** An amount of a platform asset in words (`shared/format.ts`); any other asset in raw units. */
export const amountText = (raw: string, asset: string) => amountOf(raw, asset, NO_BOOK);
/** A quoted cost in basis points as a percentage; negative when the quote is worth more than what it spends. */
export const costText = (bps: number) => `${bps / 100}%`;

/** A proposal's swaps: each leg with its signed floor, and the quote it was proposed under. */
export function Legs({ view }: { view: ProposalView }) {
  return <ol aria-label="Swaps" className="flex flex-col gap-3">
    {view.legs.map((leg, i) => {
      const quote = view.quoted[i];
      return <li key={i} className="flex flex-col gap-1">
        <span className="font-medium">Swap {amountText(leg.amount, leg.from)} for at least {amountText(leg.minAmountOut, leg.to)}</span>
        {quote && <span className="text-sm text-muted-foreground">
          Quoted {amountText(quote.amountOut, leg.to)} · cost {costText(quote.costBps)} · {usd(quote.usdIn)} in
        </span>}
      </li>;
    })}
  </ol>;
}

export const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
