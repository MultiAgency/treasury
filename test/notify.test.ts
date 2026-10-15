import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { dismiss, post } from "../src/inbox.js";
import { notifyOnce, pending, startNotifications } from "../src/notify.js";
import { record } from "../src/ops.js";

/** Telegram notifications from an executor's own state: once per open item, never amounts or payees. */

const home = process.cwd();
const request = { asset: "nep141:usdc", amount: "1234567", recipient: "secret-payee.near", confidential: true };
let sent: string[];
const send = async (text: string) => { sent.push(text); };

beforeEach(() => {
  process.chdir(mkdtempSync(join(tmpdir(), "notify-")));
  process.env.AGENT_ID = "a".repeat(64);
  process.env.NOTIFY_NAME = "Payout agent";
  process.env.NOTIFY_LINK = "https://proto.example/a/payout/";
  sent = [];
  mock.method(globalThis, "fetch", async () => { throw new Error("offline only"); });
});
afterEach(() => { mock.restoreAll(); process.chdir(home); });

const hold = (key: string) => {
  record({ at: new Date().toISOString(), idempotencyKey: key, kind: "payout", method: "transfer", request });
  record({ idempotencyKey: key, correlation_id: `op_${key}`, status: "PENDING_APPROVAL" });
};

test("a held payment is announced once, with a link and without its amount or payee", async () => {
  hold("payout:1");
  assert.equal(await notifyOnce(send), 1);
  assert.equal(await notifyOnce(send), 0, "still open: not announced again");
  assert.deepEqual(sent, ["Payout agent: a payment is waiting for approval.\nOpen: https://proto.example/a/payout/"]);
  assert.doesNotMatch(sent.join(), /1234567|1\.23|secret-payee/);
});

test("an operation with no proven outcome and the autopilot's open entries are announced; runs and dismissed ones aren't", async () => {
  record({ at: new Date(Date.now() - 10 * 60_000).toISOString(), idempotencyKey: "swap:1", kind: "rebalance", method: "swap", request: { amount: "5" } });
  post("run", "book on target");
  const warn = post("warn", "A rebalance of $6.30 is above the limit");
  const gone = post("action", "already handled");
  dismiss(gone.id);
  await notifyOnce(send);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /no proven outcome; sends are paused until it's reconciled\.\nOpen: https:\/\/proto\.example\/a\/payout\/activity/);
  assert.match(sent[0]!, /autopilot needs attention\.\nOpen: https:\/\/proto\.example\/a\/payout\/automations/);
  assert.doesNotMatch(sent[0]!, /6\.30|book on target|already handled/, "inbox text can carry amounts: never forwarded");
  assert.equal(pending().filter((i) => i.key === `inbox:${warn.id}`).length, 1);
});

test("a failed send is retried next time, and a resolved item drops out of the record", async () => {
  hold("payout:2");
  await assert.rejects(notifyOnce(async () => { throw new Error("Telegram answered 502"); }));
  assert.equal(await notifyOnce(send), 1, "nothing was marked sent when sending failed");
  record({ idempotencyKey: "payout:2", correlation_id: "op_payout:2", status: "SUCCESS" });
  assert.equal(await notifyOnce(send), 0);
  assert.deepEqual(pending(), []);
});

test("without a bot token and chat id nothing starts", () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  const interval = mock.method(globalThis, "setInterval");
  startNotifications();
  assert.equal(interval.mock.callCount(), 0);
});

test("a money action still settling isn't announced; one without an outcome after 5 minutes is", async () => {
  const swap = (key: string, at: Date) => record({ at: at.toISOString(), idempotencyKey: key, kind: "rebalance", method: "swap", request: { amount: "5" } });
  swap("swap:in-flight", new Date());
  assert.equal(await notifyOnce(send), 0, "a normal swap takes about a minute to settle");
  swap("swap:slow", new Date(Date.now() - 4.5 * 60_000));
  assert.equal(await notifyOnce(send), 0, "four and a half minutes is not yet five");
  swap("swap:stuck", new Date(Date.now() - 6 * 60_000));
  assert.equal(await notifyOnce(send), 1);
  assert.match(sent.at(-1)!, /no proven outcome/);
});
