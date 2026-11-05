import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { EventSchemas } from "@ag-ui/core/schemas";
import type { AuditEntry } from "../src/audit.ts";
import * as contract from "../src/contract.ts";
import { createDaoRequests } from "../src/dao-requests.ts";
import { standInDaos } from "../src/dao.ts";
import { createServer } from "../src/http.ts";
import { standInKeyLookup } from "../src/keys.ts";
import { createSessions } from "../src/sessions.ts";
import { createSignIn } from "../src/signin.ts";
import { BIG, fakePlatform, HOST, ORIGIN, wallet } from "./fakes.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const owner = wallet("owner.near"), intruder = wallet("intruder.near");
const fake = fakePlatform({ portfolio: "owner.near", theirs: "intruder.near" });
const audit: AuditEntry[] = [];
let server: Server, base: string, cookie: string;

before(async () => {
  server = createHttpServer(createServer({
    platform: fake.platform,
    signIn: createSignIn({ recipient: HOST, ttlMs: 5 * 60_000, perMinute: 1_000,
      keyLookup: standInKeyLookup(Object.fromEntries([owner, intruder].map(who => [who.accountId, [who.publicKey]]))) }),
    sessions: createSessions({ idleMs: 30 * 60_000, maxMs: 12 * 60 * 60_000 }),
    publicOrigin: ORIGIN, deployment: "treasury", trustedProxyHops: 0, ownerRequestsPerMinute: 1_000,
    audit: { append: async entry => { audit.push(entry); } }, consentsPerDay: 1_000, daoFilingsPerDay: 1_000, keyLookup: async () => "full",
    daos: standInDaos({}), daoRequests: await createDaoRequests(join(tempDir("treasury-sweep-"), "dao-requests.json")),
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const issued = await (await fetch(`${base}/api/session/challenge`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" })).json() as any;
  cookie = (await fetch(`${base}/api/session`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(owner.sign(issued.value)) }))
    .headers.get("set-cookie")!.split(";")[0]!;
});
after(() => server.close());

const sweep = async (body: unknown) => {
  const response = await fetch(`${base}/api/agents/portfolio/sweep`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, text: await response.clone().text(), body: await response.json() as any };
};
/** The run's events, each one checked against AG-UI's own schema too. */
const eventsOf = (body: { value: unknown }) => {
  const { events } = contract.sweepRun.parse(body.value);
  for (const event of events) EventSchemas.parse(event);
  return events;
};
const reset = () => { fake.calls.length = 0; audit.length = 0; };
const plan = { type: "plan" as const, exposed: [{ asset: "nep141:wrap.near", symbol: "wNEAR", decimals: 24, price: 2.5, public: BIG, confidential: 0n, usd: 308.64 }] };

test("a preview is a well-formed AG-UI run: started, the public balance exactly as a decimal string, finished; nothing recorded", async () => {
  reset();
  const { status, body, text } = await sweep({ execute: false });
  assert.equal(status, 200, text);
  const events = eventsOf(body);
  assert.deepEqual(events.map(event => event.type), ["RUN_STARTED", "ACTIVITY_SNAPSHOT", "RUN_FINISHED"]);
  const [started, activity, finished] = events as any[];
  assert.equal(started.protocolVersion, "1.0");
  assert.deepEqual([finished.threadId, finished.runId], [started.threadId, started.runId], "one run");
  assert.equal(activity.activityType, "treasury.sweep");
  assert.deepEqual(contract.sweepActivity.parse(activity.content), { exposed: [{ asset: "nep141:wrap.near", symbol: "wNEAR", decimals: 24, public: String(BIG) }], shields: [] });
  assert.deepEqual(fake.calls.filter(made => made.startsWith("funding.")), ["funding.sweep owner--near portfolio false"]);
  assert.deepEqual(audit, [], "a preview moves nothing");
  const again = eventsOf((await sweep({ execute: false })).body) as any[];
  assert.notEqual(again[0].runId, started.runId, "each run its own ID");
});

test("a shield's run snapshots its activity after each event, ends finished, and is recorded before and after", async () => {
  reset();
  const events = eventsOf((await sweep({ execute: true })).body) as any[];
  assert.deepEqual(events.map(event => event.type), ["RUN_STARTED", "ACTIVITY_SNAPSHOT", "ACTIVITY_SNAPSHOT", "RUN_FINISHED"]);
  assert.equal(events[1].messageId, events[2].messageId, "one activity, snapshotted whole each time");
  assert.deepEqual(contract.sweepActivity.parse(events[2].content).shields, [{ asset: "nep141:wrap.near", status: "SUCCESS", correlationId: "shield-1", failureCode: null }]);
  assert.deepEqual(audit.map(entry => [entry.action, entry.stage, "answer" in entry ? entry.answer : undefined]), [["sweep", "attempt", undefined], ["sweep", "result", { ok: true }]]);
});

test("a stream lost after it began is a truncated run: its events, and no terminal event", async () => {
  reset();
  fake.sweepRuns.push({ events: [plan, { type: "shield", asset: "nep141:wrap.near", status: "PENDING", correlationId: "shield-2" }],
    ended: { ok: false, kind: "unknown", procedure: "sweep", identity: { execute: true } } });
  const events = eventsOf((await sweep({ execute: true })).body);
  assert.deepEqual(events.map(event => event.type), ["RUN_STARTED", "ACTIVITY_SNAPSHOT", "ACTIVITY_SNAPSHOT"], "neither finished nor failed");
  const last = audit.at(-1)!;
  assert.deepEqual("answer" in last ? last.answer : undefined, { ok: false, kind: "unknown" });
});

test("a refused sweep ends RUN_ERROR with its kind as the code and the server's words, never the platform's", async () => {
  reset();
  fake.sweepRuns.push({ events: [plan], ended: { ok: false, kind: "refused", status: 409, error: "provider said: secret detail" } as never });
  const { body, text } = await sweep({ execute: true });
  const events = eventsOf(body) as any[];
  assert.deepEqual(events.at(-1), { type: "RUN_ERROR", message: "The platform refused the sweep.", code: "refused" });
  assert.ok(!text.includes("secret detail"));
});

test("no consent before any event is not_connected; a throw before any event is unavailable; a malformed request is refused unasked", async () => {
  reset();
  fake.sweepRuns.push({ events: [], ended: { ok: false, kind: "forbidden", status: 403, error: "No live owner consent", source: "gateway" } as never }, new Error("socket hang up"));
  assert.deepEqual((await sweep({ execute: true })).body, { ok: false, kind: "refused", code: "not_connected" });
  assert.deepEqual([(await sweep({ execute: true })).status, (await sweep({ execute: "yes" })).body], [503, { ok: false, kind: "refused", code: "bad_request" }]);
  assert.deepEqual(fake.calls.filter(made => made.startsWith("funding.")).length, 2, "the malformed one asked nothing");
  assert.deepEqual(audit.filter(entry => entry.stage === "result").map(entry => "answer" in entry ? entry.answer : undefined),
    [{ ok: false, kind: "forbidden", status: 403, code: "not_connected" }, { ok: false, kind: "unavailable" }]);
});

test("the books reach the page as the platform answers them, and someone else's agent is not_owner for the books and the sweep", async () => {
  reset();
  fake.reads.books = [{ asset: "nep141:wrap.near", symbol: "wNEAR", public: { api: "1", chain: "1", drift: "0" }, confidential: { api: String(BIG), recorded: String(BIG), unattributed: "0" } }];
  const books = await (await fetch(`${base}/api/agents/portfolio/books`, { headers: { cookie } })).json() as any;
  assert.equal(contract.booksRead.parse(books.value)[0]!.confidential.api, String(BIG));
  for (const path of ["books", "sweep"]) {
    const response = await fetch(`${base}/api/agents/theirs/${path}`, { method: path === "books" ? "GET" : "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      ...(path === "sweep" && { body: JSON.stringify({ execute: false }) }) });
    assert.deepEqual(await response.json(), { ok: false, kind: "not_owner" }, path);
  }
  assert.deepEqual(fake.calls.filter(made => made.startsWith("funding.sweep")), []);
});
