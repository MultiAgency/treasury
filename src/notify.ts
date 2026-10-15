import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentId } from "./env.js";
import { readInbox } from "./inbox.js";
import { isHeld, readOps } from "./ops.js";
import { unresolved } from "./recover.js";
import { writeAtomic } from "./synced.js";

/**
 * Tells the owner, on Telegram, when something on this executor waits for a person: a payment held
 * for approval, a money action with no proven outcome, the autopilot's open warnings and decisions.
 * Everything it reads is this executor's own state; it sends nothing else and never touches money.
 *
 * Messages say what needs attention and link to the dashboard, never amounts, payees or balances:
 * Telegram sees every message, and the payouts are confidential. Each item is announced once while
 * it stays open, also across restarts. Off unless TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set.
 */

/** `path`: where on the agent's dashboard the owner acts on it, appended to NOTIFY_LINK (the agent's page). */
export type Item = { key: string; text: string; path: string };

/**
 * A sent action normally settles within a minute or two, and the send path stops waiting after three: one
 * still without an outcome after this long is stuck, not just in flight.
 */
const STUCK_MIN = 5;

/** What waits for a person right now, from local state only. */
export function pending(): Item[] {
  const name = process.env.NOTIFY_NAME ?? "The agent";
  const items: Item[] = [];
  for (const op of readOps().filter(isHeld)) items.push({ key: `held:${op.idempotencyKey}`, text: `${name}: a payment is waiting for approval.`, path: "/" });
  for (const op of unresolved().filter((op) => Date.now() - Date.parse(op.at) >= STUCK_MIN * 60_000))
    items.push({ key: `unresolved:${op.idempotencyKey}`, text: `${name}: a money action has no proven outcome; sends are paused until it's reconciled.`, path: "/activity" });
  for (const e of readInbox().filter((e) => !e.dismissed && e.level !== "run"))
    items.push({ key: `inbox:${e.id}`, text: `${name}: the autopilot ${e.level === "action" ? "left a decision for you" : "needs attention"}.`, path: "/automations" });
  return items;
}

const stateFile = () => {
  mkdirSync(".notify", { recursive: true });
  return join(".notify", `${agentId()}.json`);
};
const sentKeys = () => new Set<string>(existsSync(stateFile()) ? (JSON.parse(readFileSync(stateFile(), "utf8")) as string[]) : []);

async function telegram(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  // The URL holds the token: report the status only.
  if (!res.ok) throw new Error(`Telegram answered ${res.status}`);
}

/** Announces every new open item in one message; remembers only items still open, so the record stays small. */
export async function notifyOnce(send: (text: string) => Promise<void> = telegram) {
  const items = pending();
  const sent = sentKeys();
  const fresh = items.filter((i) => !sent.has(i.key));
  if (fresh.length) {
    // One line per kind of item, each with the page where the owner acts on it.
    const link = process.env.NOTIFY_LINK?.replace(/\/$/, "");
    const lines = new Map(fresh.map((i) => [i.text, link ? `${i.text}\nOpen: ${link}${i.path}` : i.text]));
    await send([...lines.values()].join("\n"));
  }
  const open = new Set(items.map((i) => i.key));
  writeAtomic(stateFile(), JSON.stringify([...sent, ...fresh.map((i) => i.key)].filter((k) => open.has(k))));
  return fresh.length;
}

let timer: NodeJS.Timeout | undefined;

/** Checks once a minute. A failed send is retried next minute; nothing here can stop the agent. */
export function startNotifications() {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  timer ??= setInterval(() => {
    notifyOnce().catch((error) => console.error("Notification deferred:", error instanceof Error ? error.message : "unknown error"));
  }, 60_000);
  timer.unref();
}
