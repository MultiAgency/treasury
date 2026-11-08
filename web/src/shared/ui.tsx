import { CaretRight, Copy } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge as BadgePrimitive } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

export { Button };
/** Native input/select callers share the same states as the Input component. */
export { inputStyles as input } from "@/components/ui/input";

/** The review dialog's surface only; native dialog focus and each review's authorization remain with the caller. */
export const reviewDialog =
  "m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-md overflow-y-auto overscroll-contain rounded-xl border border-border-strong bg-popover p-5 text-sm text-popover-foreground shadow-[0_24px_80px_rgb(0_0_0/0.7)] backdrop:bg-black/70";

export type Tone = "neutral" | "success" | "warning" | "info" | "destructive" | "brand";

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <BadgePrimitive variant={tone}>{children}</BadgePrimitive>;
}

export const statusTone = (status: string | undefined): Tone =>
  status === "SUCCESS" ? "success" : status === "FAILED" || status === "REFUNDED" ? "destructive" : status ? "warning" : "neutral";

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex min-w-0 flex-col gap-5 rounded-xl border border-border bg-card p-4 text-sm text-card-foreground sm:p-5", className)}>{children}</div>;
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

export function Spinner() {
  return <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}

/** Why an action failed, in the server's or wallet's words; nothing when it didn't. */
export function ErrorBox({ error }: { error?: string }) {
  return <div role="alert" aria-atomic="true" className={error ? undefined : "sr-only"}>
    {error && <Alert variant="destructive" role="presentation"><AlertDescription>{error}</AlertDescription></Alert>}
  </div>;
}

/** A query still on its way: what is loading, so an empty list is never shown in its place. */
export function Loading({ label }: { label: string }) {
  return <p role="status" className="flex items-center gap-3 text-sm text-muted-foreground"><Spinner /> {label}</p>;
}

/** A query that failed: the server's words, and a retry, so a failure never reads as "nothing here". */
export function QueryError({ error, retry }: { error: { message: string }; retry: () => void }) {
  return <Alert variant="destructive" className="flex flex-wrap items-center justify-between gap-3">
    <AlertDescription>{error.message}</AlertDescription>
    <Button variant="outline" size="sm" onClick={retry}>Check again</Button>
  </Alert>;
}

export function StatusBadge({ status, failureCode, children }: { status: string; failureCode?: string | null; children?: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-2 text-xs">
      {children && <span className="min-w-0 break-all">{children}</span>}
      <Badge tone={statusTone(status)}>{status.toLowerCase()}</Badge>
      {failureCode && <code className="min-w-0 break-all text-muted-foreground">{failureCode}</code>}
    </span>
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
  return <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-2">
    <Button variant="ghost" size="sm" disabled={busy} onClick={copy}>
      <Copy data-icon="inline-start" aria-hidden="true" /> {busy ? "Copying…" : "Copy"}
    </Button>
    <span role="status" aria-atomic="true" className={message ? "text-sm text-muted-foreground" : "sr-only"}>{message}</span>
  </span>;
}

/** Detail most readers skip, such as identifiers and rare controls, folded under a one-line summary. */
export function Details({ summary, open, className = "", children }: { summary: string; open?: boolean; className?: string; children: ReactNode }) {
  return <details open={open} className={cn("text-sm", className)}>
    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 py-2 text-muted-foreground hover:text-foreground md:min-h-8 [&::-webkit-details-marker]:hidden">
      <CaretRight aria-hidden="true" className="size-3 shrink-0 transition-transform [details[open]>summary>&]:rotate-90" />{summary}
    </summary>
    <div className="mt-2 flex flex-col gap-2">{children}</div>
  </details>;
}

/** A long identifier, shortened in the middle. */
export const short = (id: string, max = 20) => (id.length > max ? `${id.slice(0, 8)}…${id.slice(-6)}` : id);

/** An error's words for a person. */
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
