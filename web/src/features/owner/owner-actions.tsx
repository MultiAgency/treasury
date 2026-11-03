import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { reads, type OwnerActionRecord as Record } from "../../platform";
import { AGENT } from "../../app/location";
import { useViewer } from "../../app/viewer";
import { accessDenied, Button, Card, CopyButton, Details, Loading, ReadFailure, Section } from "../../shared/ui";

/** One recorded owner action: where it stands, and its reference to follow it by. */
export function OwnerActionRecord({ action: a }: { action: Record }) {
  return <Card>
    <div id={`owner-${a.correlationId}`} className="scroll-mt-48">
      <p className="font-medium">{a.type.replaceAll("_", " ")} · {a.signer === "dao" ? "DAO" : "Owner wallet"}</p>
      <p className="text-sm">{a.stage === "submitted" ? "Submission attempted—checking the existing owner action’s outcome. Do not sign again." : a.stage === "prepared" ? "Prepared, with no submission attempt recorded. Review the existing action; its signing window closes " + new Date(a.expiresAt).toLocaleString() + "." : a.stage === "expired" ? "Signing window closed without a recorded submission attempt." : a.ownerSucceeded ? "Owner action succeeded." : `Owner action ended: ${a.status ?? "outcome unavailable"}.`}</p>
      {/* Payments are followed on the operation status page: this app has no page of its own for one payment. */}
      {a.payment && <p className="text-sm">{a.ownerSucceeded ? `${a.payment.verdict === "reject" ? "Rejection" : "Approval"} submitted. ` : ""}<Link to="/activity" className="underline">Follow the payment outcome</Link></p>}
      <Details summary="Owner action reference" className="mt-2">
        <span className="flex flex-wrap items-center gap-2">
          <span className="break-all font-mono text-xs text-muted-foreground">{a.correlationId}</span>
          <CopyButton text={a.correlationId} />
        </span>
      </Details>
    </div>
  </Card>;
}

/** Private durable records on this host, not a complete history across owner devices. */
export function OwnerActions() {
  const viewer = useViewer();
  const actions = useQuery(reads(AGENT!, viewer?.account ?? null).ownerActions);
  const records = accessDenied(actions.error) ? [] : actions.data ?? [];
  const refreshControl = useRef<HTMLButtonElement>(null);
  const failure = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const refresh = () => {
    restoreFocus.current = document.activeElement === refreshControl.current || Boolean(failure.current?.contains(document.activeElement));
    void actions.refetch();
  };
  useEffect(() => {
    if (actions.isFetching || !restoreFocus.current) return;
    restoreFocus.current = false;
    // An explicit read can replace its focused control; background reads never move focus.
    if (document.activeElement !== document.body) return;
    const control = actions.error ? failure.current?.querySelector("button") : refreshControl.current;
    control?.focus({ preventScroll: true });
  }, [actions.error, actions.isFetching]);
  const hash = useLocation({ select: location => location.hash });
  useEffect(() => {
    if (hash.startsWith("owner-") && actions.data) document.getElementById(hash)?.scrollIntoView({ block: "start" });
  }, [hash, actions.data]);
  return <Section title="Owner actions" description="Actions recorded on this instance. Owner approval and payment settlement are separate outcomes."
    action={!actions.error && <Button ref={refreshControl} variant="outline" size="sm" disabled={actions.isFetching} aria-busy={actions.isFetching} onClick={refresh}>Refresh owner actions</Button>}>
    {actions.error && <div ref={failure}><ReadFailure label="Owner actions" error={actions.error} retry={refresh} retained={actions.data !== undefined} updatedAt={actions.dataUpdatedAt} /></div>}
    {actions.isSuccess && actions.dataUpdatedAt > 0 && <p className="text-xs text-muted-foreground">Owner actions last loaded <time dateTime={new Date(actions.dataUpdatedAt).toISOString()}>{new Date(actions.dataUpdatedAt).toLocaleString()}</time>.</p>}
    {actions.isPending && <Loading label="Checking owner actions…" />}
    {actions.isSuccess && !actions.data.length && <p className="text-sm text-muted-foreground">No owner actions are recorded on this instance. Another instance may hold the record.</p>}
    {records.map(a => <OwnerActionRecord key={a.correlationId} action={a} />)}
  </Section>;
}
