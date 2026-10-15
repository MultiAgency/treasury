import { ago, amountOf, kindOf, type client, type Overview } from "../../shared/lib";
import type { Setup } from "../owner/owner";
import type { Tone } from "../../shared/ui";
import { plainMessage } from "../../shared/words";

/** What a person must act on for one agent, each with the page to act on, relative to the agent's pages. */
export type Attention = {
  tone: Extract<Tone, "destructive" | "warning" | "info">;
  to: "/" | "/activity" | "/policy" | "/automations" | "/follow/payment" | "/payees";
  payment?: string;
  hash?: string;
  action: string;
  text: string;
  /** The autopilot inbox entries this item shows (one message, repeated), which the owner can dismiss. */
  inboxIds?: string[];
};

type Reads = {
  /** An account as people know it (names.ts); the raw account when not given. */
  nameOf?: (account: string) => string;
  setup: Setup;
  overview: Overview;
  held: Awaited<ReturnType<typeof client.held>>;
  unresolved: Awaited<ReturnType<typeof client.unresolved>>;
  agreements: Awaited<ReturnType<typeof client.agreements.list>>;
  inbox: Awaited<ReturnType<typeof client.inbox.list>>;
};

const GRANT_WARNING_DAYS = 7;

/** Known items only; callers show incomplete-read states separately. Missing setup is not evidence of a missing grant. */
export function attentionOf({ setup, overview, held = [], unresolved = [], inbox = [], agreements = [], nameOf = (a) => a }: Partial<Reads>): Attention[] {
  const items: Attention[] = [];
  if (unresolved.length) {
    const oldest = unresolved.map((op) => op.at).sort()[0]!;
    items.push({ tone: "destructive", to: "/activity", action: "Check status",
      text: `${unresolved.length} money action${unresolved.length === 1 ? " has" : "s have"} no proven outcome, the oldest from ${ago(oldest)}. Nothing new moves until ${unresolved.length === 1 ? "it is" : "they are"} resolved.` });
  }
  if (overview?.policy.policy?.frozen)
    items.push({ tone: "destructive", to: "/policy", action: "Review", text: "The agent is frozen. Nothing moves until the owner unfreezes it." });
  else if (overview?.notInForce)
    items.push({ tone: "destructive", to: "/policy", action: "Review", text: `The policy isn't in force: ${overview.notInForce}. Nothing moves until it is.` });
  // Approve-only instances can review existing held payouts without a send grant.
  if (setup && setup.executor !== false) {
    const grant = setup.grant;
    const grantPage = overview && kindOf(overview) === "treasury" ? "/automations" : "/policy";
    if (!grant) items.push({ tone: "destructive", to: grantPage, hash: grantPage === "/policy" ? "grants" : undefined, action: "Issue", text: "No live grant: the agent can't send." });
    else if (Date.parse(grant.expiresAt) - Date.now() < GRANT_WARNING_DAYS * 86_400_000)
      items.push({ tone: "warning", to: grantPage, hash: grantPage === "/policy" ? "grants" : undefined, action: "Renew", text: `The agent's grant expires ${ago(grant.expiresAt)}. The owner can review a new grant before it expires.` });
  }
  for (const h of held) {
    const r = h.request as { amount?: string; asset?: string; recipient?: string };
    items.push({ tone: "warning", to: "/follow/payment", payment: h.correlationId, action: "Review payment",
      text: `${r.amount && r.asset ? amountOf(r.amount, r.asset, overview?.book ?? []) : "A payout"} to ${r.recipient ? nameOf(r.recipient) : "a payee"} is held for the owner's approval (requested ${ago(h.at)}).` });
  }
  // What the autopilot raised while no one was watching, until the owner dismisses it.
  // The same message raised again is one item, its age ignored ("12 min old" changes every tick). Newest
  // first, so the first of each is the latest, and its text is the one shown.
  const open = new Map<string, typeof inbox>();
  for (const e of inbox.filter((e) => !e.dismissed && e.level !== "run")) {
    const key = e.text.replace(/\d+ min old/g, "min old");
    open.set(key, [...(open.get(key) ?? []), e]);
  }
  for (const [latest, ...earlier] of open.values())
    items.push({ tone: latest!.level === "warn" ? "warning" : "info", to: "/automations", action: "Open",
      text: `${plainMessage(latest!.text)} (${earlier.length ? `${earlier.length + 1} times, latest ${ago(latest!.at)}` : ago(latest!.at)})`,
      inboxIds: [latest!.id, ...earlier.map((e) => e.id)] });
  items.push(...agreementAttention(agreements));
  return items;
}

/** Agreement next steps are identical on Home and an area's attention list. */
export function agreementAttention(agreements: Reads["agreements"]): Attention[] {
  const requested = agreements.filter(a => a.status === "requested").length;
  const proposed = agreements.filter(a => a.status === "proposed").length;
  return [
    ...(proposed ? [{ tone: "warning" as const, to: "/payees" as const, action: "Continue agreement setup", text: `${proposed} agreement${proposed === 1 ? " needs" : "s need"} policy approval` }] : []),
    ...(requested ? [{ tone: "warning" as const, to: "/payees" as const, action: "Review agreement requests", text: `${requested} new agreement request${requested === 1 ? "" : "s"}` }] : []),
  ];
}
export const attentionHref = (item: Attention, base = "") =>
  `${base}${item.to}${item.payment ? `?payment=${encodeURIComponent(item.payment)}` : ""}${item.hash ? `#${encodeURIComponent(item.hash)}` : ""}`;
