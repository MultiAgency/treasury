import { ArrowRight, CheckCircle, WarningCircle, X } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useAgent, useAgentReads } from "../../app/frame";
import { AGENT } from "../../app/location";
import { useCanCall } from "../../app/viewer";
import { agent, failureMessage } from "../../platform";
import { useNameOf } from "../../shared/names";
import { ErrorBox, Loading, QueryError, Section } from "../../shared/ui";
import { attentionOf } from "./attention";

/**
 * Dismissing the autopilot's inbox entries: each id sent once per click, stopping at the first failure. It moves no money
 * and only hides a message, so a later click may send it again; the inbox is read again either way.
 */
function useDismiss() {
  const api = useMemo(() => agent(AGENT!), []);
  const queryClient = useQueryClient();
  const { inbox } = useAgentReads();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dismiss = async (ids: string[]) => {
    setBusy(true);
    setError(undefined);
    for (const id of ids) {
      const result = await api.act("inbox/dismiss", { id });
      if (!result.ok) { setError(failureMessage(result)); break; }
    }
    setBusy(false);
    await queryClient.invalidateQueries({ queryKey: inbox.queryKey, exact: true });
  };
  return { busy, error, dismiss };
}

/** Everything that stops the agent working, or that the owner should decide on, each with where to act. */
export function NeedsAttention() {
  const { setup, data } = useAgent();
  const agentReads = useAgentReads();
  const canRecover = useCanCall("recover");
  const canDismiss = useCanCall("inbox/dismiss");
  const nameOf = useNameOf();
  const held = useQuery(agentReads.held);
  const inbox = useQuery(agentReads.inbox);
  const unresolved = useQuery(agentReads.unresolved);
  const required = [held, inbox, unresolved];
  const unavailable = required.find(q => q.error);
  const loading = required.some(q => q.isPending);
  const checked = Math.min(...required.map(q => q.dataUpdatedAt));
  const dismissing = useDismiss();
  const items = attentionOf({ setup, overview: data, held: held.data, unresolved: unresolved.data, inbox: inbox.data, nameOf });

  return <Section title="Needs attention">
    <ErrorBox error={dismissing.error} />
    {unavailable?.error && <><p className="text-sm">Attention checks are incomplete. Previously loaded items may be out of date.</p>
      <QueryError error={unavailable.error} retry={() => { for (const q of required) void q.refetch(); }} /></>}
    {loading && <Loading label="Checking payouts, unresolved operations and the inbox…" />}
    {checked > 0 && <p className="text-xs text-muted-foreground">Last checked {new Date(checked).toLocaleString()}</p>}
    {items.length === 0 && !loading && !unavailable
      ? <p className="flex items-center gap-3 text-sm text-muted-foreground"><CheckCircle size={18} className="text-success" /> No items need attention in the records checked.</p>
      : <ul aria-label="Items that need attention" className="flex flex-col">
        {items.map(item => <li key={item.text} className="flex items-center gap-2 border-b last:border-0">
          <Link to={item.to} hash={item.hash} className="group flex flex-1 items-center gap-3 py-3 text-sm">
            <WarningCircle size={18} aria-hidden="true" className={`shrink-0 ${item.tone === "destructive" ? "text-destructive-muted-foreground" : item.tone === "info" ? "text-info-muted-foreground" : "text-warning-muted-foreground"}`} />
            <span className="flex-1">{item.text}<span className="block font-medium">{item.action}{!canRecover && item.action === "Check status" ? " · permission required" : ""}</span></span>
            <ArrowRight size={16} aria-hidden="true" className="text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </Link>
          {item.inboxIds && canDismiss && <button type="button" disabled={dismissing.busy} onClick={() => void dismissing.dismiss(item.inboxIds!)}
            className="min-h-11 min-w-11 shrink-0 p-2 text-muted-foreground hover:text-foreground" aria-label="Dismiss">
            <X size={16} aria-hidden="true" />
          </button>}
        </li>)}
      </ul>}
  </Section>;
}
