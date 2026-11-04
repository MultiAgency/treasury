// With explicit extensions: test/attention.test.ts loads this module under Node, which resolves only `.ts` paths.
import type { HeldPayout, InboxEntry, Overview, Setup, UnresolvedOperation } from "../../platform.ts";
import { ago, amountOf } from "../../shared/format.ts";

/** What the owner must act on for this agent, each with the page to act on, relative to the agent's pages. */
export type Attention = {
  tone: "destructive" | "warning" | "info";
  to: "/" | "/activity" | "/policy" | "/automations" | "/funding";
  hash?: string;
  action: string;
  text: string;
  /** The autopilot inbox entries this item shows (one message, raised again), which the owner can dismiss together. */
  inboxIds?: string[];
};

type Reads = {
  /** An account as people know it; the raw account when not given. */
  nameOf: (account: string) => string;
  setup: Setup;
  overview: Overview;
  held: HeldPayout[];
  unresolved: UnresolvedOperation[];
  inbox: InboxEntry[];
  now: number;
};

const GRANT_WARNING_DAYS = 7;

/** An inbox message raised again on later ticks: its age ("12 min old") changes every time, so it isn't part of its identity. */
const inboxKey = (text: string) => text.replace(/\d+ min old/g, "min old");

/**
 * Known items only: a read that failed or is still loading adds nothing, and its caller says the checks are incomplete.
 * A missing setup is never taken as a missing grant. The owner's inbox entries come last, newest first, one item per
 * message.
 */
export function attentionOf({ setup, overview, held = [], unresolved = [], inbox = [], nameOf = a => a, now = Date.now() }: Partial<Reads>): Attention[] {
  const items: Attention[] = [];
  if (unresolved.length) {
    const oldest = unresolved.map(op => op.at).sort()[0]!;
    items.push({ tone: "destructive", to: "/activity", action: "Check status",
      text: `${unresolved.length} money action${unresolved.length === 1 ? " has" : "s have"} no proven outcome, the oldest from ${ago(oldest)}. Nothing new moves until ${unresolved.length === 1 ? "it is" : "they are"} resolved.` });
  }
  if (overview?.policy.policy?.frozen)
    items.push({ tone: "destructive", to: "/policy", action: "Review", text: "The agent is frozen. Nothing moves until the owner unfreezes it." });
  else if (overview?.notInForce)
    items.push({ tone: "destructive", to: "/policy", action: "Review", text: `The policy isn't in force: ${overview.notInForce}. Nothing moves until it is.` });
  // An approve-only instance needs no send grant of its own. A Treasury's grant is bound to its saved strategy.
  if (setup && setup.executor !== false) {
    const grant = setup.grant;
    if (!grant) items.push({ tone: "destructive", to: "/automations", action: "Authorize", text: "No live grant: the agent can't send." });
    else if (Date.parse(grant.expiresAt) - now < GRANT_WARNING_DAYS * 86_400_000)
      items.push({ tone: "warning", to: "/automations", action: "Renew", text: `The agent's grant expires ${ago(grant.expiresAt)}. The owner can review a new grant before it expires.` });
  }
  for (const h of held) {
    const r = h.request as { amount?: unknown; asset?: unknown; recipient?: unknown };
    const what = typeof r.amount === "string" && typeof r.asset === "string" ? amountOf(r.amount, r.asset, overview?.book ?? []) : "A payout";
    items.push({ tone: "warning", to: "/activity", action: "Review payment",
      text: `${what} to ${typeof r.recipient === "string" ? nameOf(r.recipient) : "a payee"} is held for the owner's approval (requested ${ago(h.at)}).` });
  }
  const open = new Map<string, InboxEntry[]>();
  for (const entry of [...inbox].sort((a, b) => b.at.localeCompare(a.at)).filter(e => !e.dismissed && e.level !== "run")) {
    const key = inboxKey(entry.text);
    open.set(key, [...(open.get(key) ?? []), entry]);
  }
  for (const [latest, ...earlier] of open.values())
    items.push({ tone: latest!.level === "warn" ? "warning" : "info", to: "/automations", action: "Open",
      text: `${latest!.text} (${earlier.length ? `${earlier.length + 1} times, latest ${ago(latest!.at)}` : ago(latest!.at)})`,
      inboxIds: [latest!.id, ...earlier.map(e => e.id)] });
  return items;
}
