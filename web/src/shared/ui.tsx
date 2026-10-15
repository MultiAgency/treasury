import { Check, Copy } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge as BadgePrimitive } from "@/components/ui/badge";
import { Card as CardPrimitive, CardHeader as CardHeaderPrimitive, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty as EmptyPrimitive, EmptyContent, EmptyMedia } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ASSET_COLOR } from "./format";

export { Button };
/** Native input/select callers share the same states as the Input component. */
export { inputStyles as input } from "@/components/ui/input";

/** Maia surface only; native dialog focus and each review's authorization remain with the caller. */
export const reviewDialog =
  "m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-md overflow-y-auto overscroll-contain rounded-4xl border-0 bg-popover p-6 text-popover-foreground ring-1 ring-foreground/5 backdrop:bg-black/80 backdrop:backdrop-blur-xs";

export type Tone = "neutral" | "success" | "warning" | "info" | "destructive";

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <BadgePrimitive variant={tone}>{children}</BadgePrimitive>;
}

/** Settled operation statuses, mapped once so every list reads them the same way. */
export const statusTone = (status: string | undefined): Tone =>
  status === "SUCCESS"
    ? "success"
    : status === "FAILED" || status === "REFUNDED"
      ? "destructive"
      : status
        ? "warning"
        : "neutral";

export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Card({ className = "", size = "default", children }: { className?: string; size?: "default" | "sm"; children: ReactNode }) {
  // Existing feature cards contain direct children; keep their horizontal padding.
  return <CardPrimitive size={size} className={cn("px-(--card-spacing)", className)}>{children}</CardPrimitive>;
}

export function Spinner() {
  return <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}

/**
 * One step of a numbered flow: the current step shows its body, a finished one collapses to a
 * checked row with a one-line summary.
 */
export function Step({
  number,
  title,
  status,
  summary,
  last,
  children,
}: {
  number: number;
  title: string;
  status: "complete" | "current" | "upcoming";
  summary?: ReactNode;
  last?: boolean;
  children?: ReactNode;
}) {
  return (
    <li className="relative flex gap-4 pb-8 last:pb-0">
      {!last && <span className="absolute top-9 bottom-1 left-4 w-px bg-border" />}
      <span
        className={`grid size-8 shrink-0 place-items-center rounded-full text-sm font-medium ${
          status === "complete"
            ? "bg-success-muted text-success-muted-foreground"
            : status === "current"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground"
        }`}
      >
        {status === "complete" ? <Check size={16} weight="bold" /> : number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3 pt-1">
        <div className="flex flex-col gap-0.5">
          <h3 className={`text-lg font-medium ${status === "upcoming" ? "text-muted-foreground" : ""}`}>{title}</h3>
          {status === "complete" && summary && <p className="text-sm text-pretty break-words text-muted-foreground">{summary}</p>}
        </div>
        {status === "current" && children}
      </div>
    </li>
  );
}

/** Why an action failed, in the server's or wallet's words; nothing when it didn't. */
export function ErrorBox({ error }: { error?: string }) {
  return <div role="alert" aria-atomic="true" className={error ? undefined : "sr-only"}>
    {error && <Alert variant="destructive" role="presentation"><AlertDescription>{error}</AlertDescription></Alert>}
  </div>;
}

/** A query still on its way: what is loading, so an empty list is never shown in its place. */
export function Loading({ label }: { label: string }) {
  return (
    <p role="status" className="flex items-center gap-3 text-sm text-muted-foreground">
      <Spinner /> {label}
    </p>
  );
}

/** Reserve record space on an initial read; placeholders never represent known records. */
export function LoadingRecords({ label, rows = 3 }: { label: string; rows?: number }) {
  return <div role="status" aria-atomic="true" className="flex min-w-0 flex-col gap-3">
    <p className="text-sm text-muted-foreground">{label}</p>
    <div aria-hidden="true" className="divide-y">
      {Array.from({ length: rows }, (_, index) => <div key={index} className="flex min-h-24 flex-col justify-center gap-3 py-4">
        <Skeleton className="h-4 w-2/3 max-w-sm" />
        <Skeleton className="h-3 w-5/6 max-w-lg" />
        <Skeleton className="h-3 w-1/3 max-w-40" />
      </div>)}
    </div>
  </div>;
}

/** A query that failed: the server's words, and a retry, so a failure never reads as "nothing here". */
export function QueryError({ error, retry }: { error: { message: string }; retry: () => void }) {
  return (
    <Alert variant="destructive" className="flex flex-wrap items-center justify-between gap-3">
      <AlertDescription>{error.message}</AlertDescription>
      <Button variant="ghost" size="sm" onClick={retry}>
        Check again
      </Button>
    </Alert>
  );
}

/** An operation's settled status, with the provider's failure code when it has one. */
export function StatusBadge({ status, failureCode, children }: { status: string; failureCode?: string | null; children?: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-2 text-xs">
      {children && <span className="min-w-0 break-all">{children}</span>}
      <Badge tone={statusTone(status)}>{status.toLowerCase()}</Badge>
      {failureCode && <code className="min-w-0 break-all text-muted-foreground">{failureCode}</code>}
    </span>
  );
}

/** A rejection can occur after earlier actions; never infer non-execution from it. */
export function NotExecuted({ problems, again }: { problems: string[]; again: string }) {
  return (
    <Alert variant="warning" role="note">
      <AlertTitle>Execution stopped. Earlier actions may have completed. Review Activity before creating a new {again.toLowerCase()}.</AlertTitle>
      <AlertDescription className="flex flex-col gap-1">
        {problems.map((p) => <span key={p}>– {p}</span>)}
      </AlertDescription>
    </Alert>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; message: string }>();
  const message = result?.text === text ? result.message : "";
  const copy = async () => {
    setBusy(true);
    setResult(undefined);
    try {
      await navigator.clipboard.writeText(text);
      setResult({ text, message: "Copied." });
    } catch {
      setResult({ text, message: "Could not copy. Try again or copy the displayed text." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-2">
      <Button variant="ghost" size="sm" disabled={busy} onClick={copy}>
        <Copy data-icon="inline-start" aria-hidden="true" /> {busy ? "Copying…" : "Copy"}
      </Button>
      <span role="status" aria-atomic="true" className={message ? "text-sm text-muted-foreground" : "sr-only"}>{message}</span>
    </span>
  );
}

/** Detail most readers skip, such as identifiers and rare controls, folded under a one-line summary. */
export function Details({ summary, open, className = "", children }: { summary: string; open?: boolean; className?: string; children: ReactNode }) {
  return (
    <details open={open} className={cn("text-sm", className)}>
      <summary className="min-h-11 cursor-pointer py-3 text-muted-foreground">{summary}</summary>
      <div className="mt-2 flex flex-col gap-2">{children}</div>
    </details>
  );
}

/** A card's heading: its icon, title and what it does. */
export function CardHeader({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <CardHeaderPrimitive className="flex gap-4 px-0">
      <div className="grid size-10 shrink-0 place-items-center rounded-2xl bg-brand-muted text-brand-strong">{icon}</div>
      <div className="flex min-w-0 flex-col gap-1">
        <CardTitle asChild><h3>{title}</h3></CardTitle>
        <CardDescription>{description}</CardDescription>
      </div>
    </CardHeaderPrimitive>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

/** Fills a card's body when there is nothing to list yet. */
export function Empty({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <EmptyPrimitive>
      <EmptyMedia aria-hidden="true">{icon}</EmptyMedia>
      <EmptyContent>{children}</EmptyContent>
    </EmptyPrimitive>
  );
}

/** An asset's chart colour, as a dot beside its name. */
export const Dot = ({ symbol }: { symbol: string }) => <span className={`size-2 rounded-full ${ASSET_COLOR[symbol] ?? "bg-muted-foreground"}`} />;
