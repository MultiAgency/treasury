import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge as BadgePrimitive } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

export { Button };

export type Tone = "neutral" | "success" | "warning" | "info" | "destructive";

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <BadgePrimitive variant={tone}>{children}</BadgePrimitive>;
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

/** A long identifier, shortened in the middle. */
export const short = (id: string, max = 20) => (id.length > max ? `${id.slice(0, 8)}…${id.slice(-6)}` : id);

/** An error's words for a person. */
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
