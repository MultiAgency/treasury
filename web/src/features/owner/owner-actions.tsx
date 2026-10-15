import { queries } from "../../shared/queries";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { Button, Card, CopyButton, Details, Loading, Section } from "../../shared/ui";
import { accessDenied, ReadFailure } from "../../shared/read-failure";
import type { QuerySource } from "../../shared/query-source";

type OwnerAction = Awaited<ReturnType<QuerySource["owner"]["actions"]>>[number];

/** Shared record display. Links retain the agent whose owner action is being reviewed. */
export function OwnerActionRecord({ action: a, base, idPrefix = "" }: { action: OwnerAction; base?: string; idPrefix?: string }) {
  return <Card>
    <div id={`${idPrefix}owner-${a.correlationId}`} className="scroll-mt-48">
      <p className="font-medium">{a.type.replaceAll("_", " ")} · {a.signer === "dao" ? "DAO" : "Owner wallet"}</p>
      <p className="text-sm">{a.stage === "submitted" ? "Submission attempted—checking the existing owner action’s outcome. Do not sign again." : a.stage === "prepared" ? "Prepared, with no submission attempt recorded. Review the existing action; its signing window closes " + new Date(a.expiresAt).toLocaleString() + "." : a.stage === "expired" ? "Signing window closed without a recorded submission attempt." : a.ownerSucceeded ? "Owner action succeeded." : `Owner action ended: ${a.status ?? "outcome unavailable"}.`}</p>
      {a.payment && <p className="text-sm">{a.ownerSucceeded ? `${a.payment.verdict === "reject" ? "Rejection" : "Approval"} submitted. ` : ""}{base === undefined
        ? <Link to="/follow/payment" search={{ payment: a.payment.correlationId }} className="underline">Follow the payment outcome</Link>
        : <a href={`${base}/follow/payment?payment=${encodeURIComponent(a.payment.correlationId)}`} className="underline">Follow the payment outcome</a>}</p>}
      <Details summary="Owner action reference" className="mt-2">
        <span className="flex flex-wrap items-center gap-2">
          <span className="break-all font-mono text-xs text-muted-foreground">{a.correlationId}</span>
          <CopyButton text={a.correlationId} />
        </span>
        {base !== undefined && <a href={`${base}/activity#owner-${encodeURIComponent(a.correlationId)}`} className="self-start underline">Open this owner action</a>}
      </Details>
    </div>
  </Card>;
}

/** Private durable records on this host, not a complete history across owner devices. */
export function OwnerActions() {
  const actions = useQuery({ ...queries.ownerActions, refetchInterval: 5_000, retry: false });
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
