import { useEffect, useRef, useSyncExternalStore } from "react";
import type { AssistantDraft } from "./proposals-api";

/**
 * A draft the assistant made (#219), handed to the review flow it opens: the rebalance proposal, the strategy editor, the
 * policy editor, the grant or the freeze. It's held in memory only, for one agent, until that flow takes it, and nothing
 * is sent by taking it: the owner still reviews the filled-in form and submits or signs it as without the assistant, so
 * each flow's send-once rules and request IDs are its own.
 */
type Pending = { agent: string; draft: AssistantDraft };
let pending: Pending | undefined;
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function openDraft(agent: string, draft: AssistantDraft) { pending = { agent, draft }; changed(); }
export function clearDraft() { pending = undefined; changed(); }

/** The draft waiting for `agent`'s `kind` of flow, if one is. */
export function usePendingDraft<K extends AssistantDraft["kind"]>(agent: string, kind: K): Extract<AssistantDraft, { kind: K }> | undefined {
  const current = useSyncExternalStore(subscribe, () => pending);
  return current?.agent === agent && current.draft.kind === kind ? current.draft as Extract<AssistantDraft, { kind: K }> : undefined;
}

/**
 * Takes the draft waiting for this flow once the flow is `ready` (has read what it reviews against): it's cleared, so
 * it's taken once, and handed to `take`, which fills the flow's form or opens its review. Nothing is sent.
 */
export function useTakeDraft<K extends AssistantDraft["kind"]>(agent: string, kind: K, ready: boolean, take: (draft: Extract<AssistantDraft, { kind: K }>) => void) {
  const draft = usePendingDraft(agent, kind);
  const latest = useRef(take);
  latest.current = take;
  useEffect(() => {
    if (!draft || !ready) return;
    clearDraft();
    latest.current(draft);
  }, [draft, ready]);
}
