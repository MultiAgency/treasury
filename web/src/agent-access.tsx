import { mayCall } from "@multiagency/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, CopyButton, ErrorBox, input, Loading, QueryError, Spinner } from "./shared/ui";
import type { Identity } from "./proposals-api";
import type { agentReads } from "./queries";
import { ReviewDialog, when } from "./ui";
import { failureText } from "./words";

type Reads = ReturnType<typeof agentReads>;
const LIFETIMES = [[1, "1 day"], [7, "7 days"], [30, "30 days"]] as const;
type Shown = { token: string; label: string };

/**
 * Access for software acting for the owner (#139): a token for this agent, good for at most 30 days, that reads it and
 * proposes a rebalance for the owner to decide, and nothing else. Shown once when made; the list shows when each was
 * last used and revokes it. Disconnecting the agent revokes them all.
 */
export function AgentAccess({ reads, identity }: { reads: Reads; identity: Identity }) {
  const client = useQueryClient();
  const tokens = useQuery(reads.tokens);
  const [days, setDays] = useState<number>(7);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Shown>();
  const [revoking, setRevoking] = useState<{ id: string; label: string }>();
  const [error, setError] = useState<string>();
  const refresh = () => client.invalidateQueries({ queryKey: reads.tokens.queryKey });
  // The server's own rule for who may issue: whoever may propose for the agent (a wallet owner, or a DAO member who may file).
  const mayIssue = mayCall(identity.access, "proposals/create");

  const create = async () => {
    setBusy(true);
    setError(undefined);
    setShown(undefined);
    const made = await reads.agent.issueToken({ days, ...(label.trim() && { label: label.trim() }) });
    setBusy(false);
    if (made.ok) { setShown({ token: made.value.token, label: made.value.view.label }); setLabel(""); }
    else setError(failureText(made, "owner-action"));
    void refresh();
  };
  const revoke = async (id: string) => {
    setBusy(true);
    setError(undefined);
    const done = await reads.agent.revokeToken(id);
    setBusy(false);
    setRevoking(undefined);
    if (!done.ok) setError(failureText(done, "owner-action"));
    void refresh();
  };

  return <section aria-labelledby="agent-access-title" className="flex flex-col gap-3 border-t pt-4">
    <h3 id="agent-access-title" className="font-medium">Access for your agent</h3>
    <p className="text-sm">A token lets software acting for you read this agent and propose a rebalance for you to approve or reject. It can't approve, execute, freeze, move funds or change anything else. It ends on its date or when you revoke it, and disconnecting the agent revokes every one. <a className="underline" href="/api/agent-api">What a token may call</a>.</p>
    {mayIssue && <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); void create(); }}>
      <label className="flex flex-col gap-1 text-sm">Name (optional)
        <input className={input} maxLength={40} value={label} onChange={event => setLabel(event.target.value)} /></label>
      <label className="flex flex-col gap-1 text-sm">Lasts
        <select className={input} value={days} onChange={event => setDays(Number(event.target.value))}>
          {LIFETIMES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
      <Button type="submit" variant="outline" disabled={busy}>{busy && <Spinner />} Create a token</Button>
    </form>}
    {shown && <div role="status" className="flex flex-col gap-2 rounded-2xl p-3 ring-1 ring-foreground/10">
      <p className="text-sm font-medium">Copy this token now{shown.label ? ` (${shown.label})` : ""}: it is shown only once.</p>
      <code className="break-all text-sm" data-testid="new-token">{shown.token}</code>
      <div className="flex gap-3"><CopyButton text={shown.token} /><Button variant="ghost" onClick={() => setShown(undefined)}>I have copied it</Button></div>
    </div>}
    {tokens.isPending ? <Loading label="Reading the tokens…" />
      : tokens.isError ? <QueryError error={tokens.error} retry={() => tokens.refetch()} />
      : tokens.data.length === 0 ? <p className="text-sm text-muted-foreground">No tokens yet.</p>
      : <ul aria-label="Access tokens" className="flex flex-col gap-2 text-sm">
        {tokens.data.map(token => <li key={token.id} className="flex flex-wrap items-center justify-between gap-3">
          <span>{token.label || "Unnamed"} · ends {when(token.expiresAt)} · {token.lastUsedAt ? `last used ${when(token.lastUsedAt)}` : "never used"}</span>
          {mayIssue && <Button variant="outline" size="sm" disabled={busy} onClick={() => setRevoking({ id: token.id, label: token.label || "Unnamed" })}>Revoke</Button>}
        </li>)}
      </ul>}
    <ErrorBox error={error} />
    <ReviewDialog open={revoking !== undefined} busy={busy} onClose={() => setRevoking(undefined)} title="Revoke this token?"
      description={`${revoking?.label ?? ""} stops working at once. Software that holds it can no longer read this agent or propose for you.`}
      actions={<Button variant="destructive" disabled={busy} onClick={() => revoking && void revoke(revoking.id)}>Revoke the token</Button>} />
  </section>;
}
