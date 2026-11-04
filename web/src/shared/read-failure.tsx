import { failureKind } from "../platform";
import { QueryError } from "./ui";

/** A rejected permission check must not expose previously cached private records. */
export const accessDenied = (error: unknown) => failureKind(error) === "forbidden" || failureKind(error) === "session";

/** Cached records remain evidence of an earlier read, never confirmation of current state. */
export function ReadFailure({ label, error, retry, retained, updatedAt }: {
  label: string; error: { message: string }; retry: () => void; retained: boolean; updatedAt?: number;
}) {
  retained = retained && !accessDenied(error);
  return <div className="flex flex-col gap-2 text-sm">
    <p className="text-warning-muted-foreground">{label} could not be {retained ? "refreshed" : "loaded"}. {retained
      ? `Showing last loaded records${updatedAt ? ` from ${new Date(updatedAt).toLocaleString()}` : ""}; current state is not confirmed.`
      : "No current records are available from this check; this does not mean there are none."}</p>
    <QueryError error={error} retry={retry} />
  </div>;
}
