import { Link, useLocation } from "@tanstack/react-router";
import { useState } from "react";
import type { Overview, Setup } from "../../platform";
import { ownerName } from "../../app/frame";
import { connect, useWallet } from "../../app/wallet";
import { ago } from "../../shared/format";
import { Badge, Button, Card, Details, ErrorBox, Section, Spinner } from "../../shared/ui";
import { ConfirmButton } from "../owner/confirm-button";
import { PendingNote, useOwnerAction, useSigner } from "../owner/owner";

/**
 * The agent's grants, including ended access. A live grant's token permits acting inside the policy;
 * revoking stops it at once, short of a freeze, which stops every grant. A Treasury grant is issued
 * bound to the saved strategy, on the Strategy page.
 */
export function Grants({ data, setup }: { data: Overview; setup: Setup }) {
  const hash = useLocation({ select: location => location.hash });
  const wallet = useWallet();
  const action = useOwnerAction(setup);
  const { viaDao, canSign, needsWallet, connectedNotOwner } = useSigner(setup);
  const [revoking, setRevoking] = useState<string>();
  // An earlier revocation whose outcome isn't known, recorded on this page or another: no other is signed meanwhile.
  const waiting = action.pending(["grant_revoke"]);
  const blocked = action.busy || Boolean(action.unknown) || Boolean(waiting) || !canSign;
  const now = Date.now();
  const live = data.grants.filter((g) => !g.revoked_at && Date.parse(g.expires_at) > now);
  const ended = data.grants.filter((g) => g.revoked_at || Date.parse(g.expires_at) <= now);
  const history = <ul className="flex flex-col divide-y">
    {ended.map((g) => {
      return <li key={g.grant_id} className="flex flex-col gap-1 py-3 text-sm first:pt-0 last:pb-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="break-all">{g.label}</span>
          <Badge tone={g.revoked_at ? "destructive" : "neutral"}>{g.revoked_at ? "Revoked" : "Expired"}</Badge>
        </span>
        <span className="text-muted-foreground">
          issued {ago(g.issued_at)} · {g.revoked_at ? <>revoked <time dateTime={g.revoked_at} title={new Date(g.revoked_at).toLocaleString()}>{ago(g.revoked_at)}</time></>
            : <>expired <time dateTime={g.expires_at} title={new Date(g.expires_at).toLocaleString()}>{ago(g.expires_at)}</time></>}
        </span>
      </li>;
    })}
  </ul>;

  const revoke = async (grantId: string) => {
    setRevoking(grantId);
    await action.run({ type: "grant_revoke", grantId });
    setRevoking(undefined);
  };

  const issueButton = <Link to="/automations" className="text-sm underline">Review strategy authorization</Link>;
  // With no live grant the agent can't act at all: issuing one is the whole page, not a fold.
  if (live.length === 0)
    return (
      <Section title="Grants" description="No live grant: the agent can't send until the owner issues one.">
        <Card className="!bg-[var(--inset)]">
          {issueButton}
          {connectedNotOwner && <p className="text-xs text-muted-foreground">Only {ownerName(setup)} can revoke or issue grants. Connect that account.</p>}
          {ended.length > 0 && <Details summary={`Ended grants (${ended.length})`}>{history}</Details>}
          <PendingNote action={action} waiting={waiting} setup={setup} />
          {action.label && <p className="text-sm text-muted-foreground">{action.label}</p>}
          <ErrorBox error={action.error} />
        </Card>
      </Section>
    );

  const revokeButton = (g: (typeof live)[number]) => {
    const held = g.grant_id === setup.grant?.id;
    const label = revoking === g.grant_id && action.busy ? <Spinner /> : viaDao ? "Propose to revoke" : needsWallet ? "Connect to revoke" : "Revoke";
    return needsWallet ? (
      <Button size="sm" variant="outline" disabled={wallet.status === "connecting"} onClick={() => connect().catch(() => {})}>
        {label}
      </Button>
    ) : held ? (
      <ConfirmButton
        label={label}
        disabled={blocked}
        path="owner/prepare"
        title="Revoke the current grant?"
        description="The agent stops: nothing moves until the owner issues a new grant. Operations it already committed still finish."
        confirm="Revoke"
        variant="danger"
        onConfirm={() => revoke(g.grant_id)}
      />
    ) : (
      <Button size="sm" variant="danger" disabled={blocked} onClick={() => revoke(g.grant_id)}>
        {label}
      </Button>
    );
  };

  return (
    <Section title="Grants" description="Who may act inside the policy, and until when."
      action={<Details summary="Issue or renew a grant" open={hash === "grants"} className="dash-header-disclosure">{issueButton}</Details>}
      info={<>Revoking a grant stops it at once; operations it already committed still finish.{viaDao ? " Each revocation is one DAO proposal." : ""} A new grant replaces the current one once the owner signs it. A treasury grant's label carries the strategy in force, so signing it approves that strategy for the autopilot. Other grants and operations already committed by the provider need separate review.</>}>
      <div className="overflow-hidden rounded-lg bg-inset shadow-hairline">
        <div className="hidden grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-3 border-b px-3 py-2 text-xs font-medium text-muted-foreground sm:grid" aria-hidden="true">
          <span>Grant</span><span>Status</span><span>Expires</span><span className="w-20 text-right">Action</span>
        </div>
        <ul aria-label="Live grants" className="flex flex-col divide-y">
          {live.map((g) => (
            <li key={g.grant_id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-3 py-2.5 text-sm sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
              <span className="flex min-w-0 items-center gap-2"><span className="size-2 shrink-0 rounded-full bg-[var(--dash-brand)]" aria-hidden="true" /><span className="break-all font-mono text-[13px]">{g.label}</span></span>
              <span className="col-start-1 flex flex-wrap items-center gap-1.5 sm:col-start-auto"><Badge tone="success">Live</Badge>{g.grant_id === setup.grant?.id && <Badge tone="brand">Current</Badge>}</span>
              <span className="col-start-1 text-muted-foreground sm:col-start-auto" title={new Date(g.expires_at).toLocaleString()}>Expires {ago(g.expires_at)}</span>
              <div className="col-start-2 row-span-3 row-start-1 flex justify-end sm:col-start-auto sm:row-span-1 sm:row-start-auto sm:w-20">
                {revokeButton(g)}
              </div>
            </li>
          ))}
        </ul>
      </div>
      {connectedNotOwner && <p className="text-xs text-muted-foreground">Only {ownerName(setup)} can revoke or issue grants. Connect that account.</p>}
      <div className="flex flex-col">
        {ended.length > 0 && <Details summary={`Ended grants (${ended.length})`}>{history}</Details>}
      </div>
      <PendingNote action={action} waiting={waiting} setup={setup} />
      {action.label && <p className="text-sm text-muted-foreground">{action.label}</p>}
      <ErrorBox error={action.error} />
    </Section>
  );
}
