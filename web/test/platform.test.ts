import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { agent, failureKind, gateway, isTreasury, onDenial, PlatformError, READS, reads, retryLost, scope, scopeOfKey, type Denial } from "../src/platform.ts";
import { pageTitle } from "../src/app/pages.ts";

/** Each request the app sent, and the answers the fake host gives, in order. */
let sent: { url: string; method: string; body: string }[] = [];
let answers: (() => Response | Promise<Response>)[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent = [];
  answers = [];
  Object.assign(globalThis, { location: new URL("https://treasury.test/a/portfolio/") });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input instanceof URL || typeof input === "string" ? new URL(input, "https://treasury.test") : input, init);
    sent.push({ url: new URL(request.url).pathname, method: request.method, body: await request.text() });
    const answer = answers.shift();
    if (!answer) throw new Error(`No answer for ${request.url}`);
    return answer();
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const json = (body: unknown, status = 200) => () => Response.json(body, { status });
const lost = () => { throw new TypeError("network"); };
/** An oRPC event stream: each value as a message, then the end. */
const events = (...values: unknown[]) => () => new Response(
  [...values.map(value => `event: message\ndata: ${JSON.stringify({ json: value })}\n\n`), "event: close\ndata: {\"json\":null}\n\n"].join(""),
  { headers: { "content-type": "text/event-stream" } });

test("every listed read is a read to the SDK: a lost answer is unavailable, never unknown", async () => {
  const inputs: Partial<Record<(typeof READS)[number], unknown>> = { "autopilot/log": { tickId: "t" }, "owner/status": { correlationId: "c" }, "autopilot/evidence": {} };
  for (const path of READS) {
    answers.push(lost);
    await assert.rejects(agent("portfolio").read(path, inputs[path] as never), (error: unknown) => failureKind(error) === "unavailable", path);
  }
  assert.equal(sent.length, READS.length);
});

test("a read answers its value, and a failed one throws by kind", async () => {
  answers.push(json({ json: { agentId: "a1", executor: true } }));
  assert.deepEqual(await agent("portfolio").read("instance", undefined), { agentId: "a1", executor: true });
  assert.deepEqual(sent.map(s => s.url), ["/a/portfolio/rpc/instance"]);

  answers.push(json({ json: { defined: true, code: "BAD_REQUEST", message: "No", data: { kind: "refused", code: "x" } } }, 400));
  await assert.rejects(agent("portfolio").read("instance", undefined), (error: unknown) => error instanceof PlatformError && error.failure.kind === "refused");
});

test("an action is sent once and answers its result, whatever happened", async () => {
  answers.push(lost);
  const unknown = await agent("portfolio").act("autopilot/stop", undefined);
  assert.equal(unknown.ok ? "ok" : unknown.kind, "unknown");
  answers.push(json({ json: { defined: true, code: "BAD_REQUEST", message: "Refused", data: { kind: "refused" } } }, 400));
  const refused = await agent("portfolio").act("autopilot/stop", undefined);
  assert.equal(refused.ok ? "ok" : refused.kind, "refused");
  assert.equal(sent.length, 2, "each action was sent exactly once");
});

test("recover is an action: a lost answer is unknown, never unavailable, and it's sent once", async () => {
  answers.push(lost);
  const checked = await agent("portfolio").act("recover", undefined);
  assert.equal(checked.ok ? "ok" : checked.kind, "unknown");
  assert.deepEqual(sent.map(s => s.url), ["/a/portfolio/rpc/recover"]);
  // It only reads, so its interruption says so, not that it may have taken effect.
  assert.equal(checked.ok ? undefined : new PlatformError(checked).message, "The check was interrupted. It only reads; check again.");
});

test("Activity's reads are cached per viewer and retried only when their answer was lost", () => {
  for (const read of ["activity", "unresolved", "books"] as const) {
    const options = reads("portfolio", "owner.near")[read];
    assert.notDeepEqual(options.queryKey, reads("portfolio", "member.near")[read].queryKey, read);
    assert.equal(options.retry, retryLost, read);
  }
});

test("a stream hands over each event; a throw after the first is unknown, and nothing is sent again", async () => {
  const seen: unknown[] = [];
  answers.push(events({ type: "plan", exposed: [] }));
  assert.equal(await agent("portfolio").stream("sweep", { execute: false }, event => { seen.push(event); }), undefined);
  assert.deepEqual(seen, [{ type: "plan", exposed: [] }]);

  answers.push(events({ type: "plan", exposed: [] }, { type: "shield", asset: "a", status: "SUCCESS", correlationId: "c" }));
  const ended = await agent("portfolio").stream("sweep", { execute: true }, () => { throw new Error("render failed"); });
  assert.deepEqual(ended, { ok: false, kind: "unknown", procedure: "sweep", identity: { execute: true } });
  assert.equal(sent.length, 2);
});

test("a gateway denial is reported, with its scope, before the call returns", async () => {
  const denials: Denial[] = [];
  const stop = onDenial(denial => denials.push(denial));
  try {
    // The body's `access` field names the scope; without it, a 401 is the session and a 403 the narrowest scope.
    answers.push(json({ error: "Session ended", access: "session" }, 403));
    await assert.rejects(agent("portfolio").read("overview", undefined), (error: unknown) => failureKind(error) === "forbidden");
    answers.push(json({ error: "No access to this agent" }, 403));
    await assert.rejects(agent("portfolio").read("overview", undefined), (error: unknown) => failureKind(error) === "forbidden");
    answers.push(json({ error: "Sign in again" }, 401));
    await assert.rejects(gateway.challenge(), (error: unknown) => failureKind(error) === "session");
    answers.push(json({ error: "This account may not see that agent", access: "agent" }, 403));
    await assert.rejects(gateway.challenge(), (error: unknown) => failureKind(error) === "forbidden");
    answers.push(json({ error: "Not permitted" }, 403));
    await assert.rejects(gateway.challenge(), (error: unknown) => failureKind(error) === "forbidden");
  } finally { stop(); }
  assert.deepEqual(denials, [
    { agent: "portfolio", scope: "session", message: "Session ended" },
    { agent: "portfolio", scope: "agent", message: "No access to this agent" },
    { agent: null, scope: "session", message: "Sign in again" },
    { agent: null, scope: "agent", message: "This account may not see that agent" },
    { agent: null, scope: "procedure", message: "Not permitted" },
  ]);
});

test("the gateway's session: discovery is parsed or refused, never guessed", async () => {
  answers.push(json({ agents: [], viewer: null, invoices: "https://invoices.test/submit" }));
  assert.equal((await gateway.me()).viewer, null);
  answers.push(() => new Response("<html>", { headers: { "content-type": "text/html" } }));
  await assert.rejects(gateway.me(), /unexpected response/);
  answers.push(json({ agents: "nope" }));
  await assert.rejects(gateway.me(), /invalid discovery data/);
  answers.push(() => new Response("<html>", { headers: { "content-type": "text/html" } }));
  await assert.rejects(gateway.challenge(), /unexpected response/);
});

test("self-service Treasury: a gateway that names no setup areas sets up every area", async () => {
  const me = (extra: object) => { answers.push(json({ agents: [], viewer: null, invoices: null, ...extra })); return gateway.me(); };
  // The platform with no site config sends selfService and leaves out setupAreas.
  assert.equal((await me({ selfService: true })).selfServiceTreasury, true);
  assert.equal((await me({ selfService: true, setupAreas: ["treasury"] })).selfServiceTreasury, true);
  assert.equal((await me({ selfService: true, setupAreas: ["payables"] })).selfServiceTreasury, false);
  assert.equal((await me({ setupAreas: [] })).selfServiceTreasury, false);
  // A standalone gateway's own flag is kept when neither is sent.
  assert.equal((await me({ selfServiceTreasury: true })).selfServiceTreasury, true);
});

test("an agent is a Treasury agent by its declared area, and by name only when none is declared", () => {
  const agentNamed = (name: string, area?: "treasury" | "payables") => ({ name, owner: "owner.near", ...(area && { area }) }) as Parameters<typeof isTreasury>[0];
  assert.equal(isTreasury(agentNamed("portfolio", "treasury")), true);
  assert.equal(isTreasury(agentNamed("treasury")), true);
  assert.equal(isTreasury(agentNamed("treasury", "payables")), false);
  assert.equal(isTreasury(agentNamed("payout")), false);
});

test("sign-in posts the wallet's signature once; sign-out ends the session", async () => {
  const signed = { accountId: "owner.near", publicKey: "ed25519:k", signature: "s", nonce: "n", callbackUrls: ["https://treasury.test/"] };
  answers.push(json({ message: "Sign in", recipient: "treasury.test", nonce: "n" }), json({ ok: true }), json({}));
  assert.deepEqual(await gateway.challenge(), { message: "Sign in", recipient: "treasury.test", nonce: "n" });
  await gateway.signIn(signed);
  await gateway.signOut();
  assert.deepEqual(sent.map(s => [s.method, s.url]), [["GET", "/gw/challenge"], ["POST", "/gw/session"], ["POST", "/gw/logout"]]);
  assert.deepEqual(JSON.parse(sent[1]!.body), signed);
});

test("a sign-out the gateway doesn't confirm throws, so nobody is shown as signed out while still signed in", async () => {
  answers.push(json({ error: "Gateway unavailable" }, 503));
  await assert.rejects(gateway.signOut(), /still signed in/);
  answers.push(lost);
  await assert.rejects(gateway.signOut(), TypeError);
});

test("owner reads: the instance and the owner's actions, each a read of its own procedure and never retried", async () => {
  const owner = reads("portfolio", "owner.near");
  answers.push(json({ json: { agentId: "a1", executor: true } }), json({ json: [] }));
  assert.deepEqual(await owner.instance.queryFn!({ signal: new AbortController().signal } as never), { agentId: "a1", executor: true });
  assert.deepEqual(await owner.ownerActions.queryFn!({ signal: new AbortController().signal } as never), []);
  assert.deepEqual(sent.map(s => s.url), ["/a/portfolio/rpc/instance", "/a/portfolio/rpc/owner/actions"]);
  assert.equal(owner.instance.retry, false);
  assert.equal(owner.ownerActions.retry, false);
  assert.notDeepEqual(owner.ownerActions.queryKey, reads("portfolio", "member.near").ownerActions.queryKey);
});

test("a lost owner/submit answer is unknown and sent once; its status is a read", async () => {
  answers.push(lost);
  const submitted = await agent("portfolio").act("owner/submit", { correlationId: "c1", signedData: {} });
  assert.equal(submitted.ok ? "ok" : submitted.kind, "unknown");
  answers.push(json({ json: { stage: "submitting" } }));
  assert.deepEqual(await agent("portfolio").read("owner/status", { correlationId: "c1" }), { stage: "submitting" });
  assert.deepEqual(sent.map(s => s.url), ["/a/portfolio/rpc/owner/submit", "/a/portfolio/rpc/owner/status"]);
});

test("cached reads are keyed by host, agent and viewer, so accounts never share records", () => {
  assert.notDeepEqual(reads("portfolio", "owner.near").overview.queryKey, reads("portfolio", "member.near").overview.queryKey);
  assert.deepEqual(scopeOfKey([scope("portfolio", "owner.near"), "overview"]), { host: "treasury.test", agent: "portfolio", account: "owner.near" });
  assert.equal(scopeOfKey(["gateway"]), undefined);
});

test("the schedule's read is autopilot/get, keyed with the agent's other reads, and not retried", async () => {
  const { autopilot } = reads("portfolio", "owner.near");
  assert.deepEqual(autopilot.queryKey, [scope("portfolio", "owner.near"), "autopilot/get"]);
  assert.equal(autopilot.retry, false);
  const schedule = { on: true, everyMin: 60, maxUsd: 100, lastRun: null, nextRun: "2026-11-03T00:00:00.000Z" };
  answers.push(json({ json: schedule }));
  assert.deepEqual(await autopilot.queryFn!({ signal: new AbortController().signal } as never), schedule);
  assert.deepEqual(sent.map(s => s.url), ["/a/portfolio/rpc/autopilot/get"]);
});

test("a cached read is retried only when its answer was lost", () => {
  const failed = (kind: "unavailable" | "forbidden" | "session" | "refused" | "provider") => new PlatformError(
    kind === "unavailable" ? { ok: false, kind } : kind === "forbidden" || kind === "session"
      ? { ok: false, kind, status: kind === "session" ? 401 : 403, error: "no", source: "gateway" } as never
      : { ok: false, kind, error: "no" } as never);
  assert.equal(retryLost(0, failed("unavailable")), true);
  assert.equal(retryLost(3, failed("unavailable")), false);
  for (const kind of ["forbidden", "session", "refused", "provider"] as const) assert.equal(retryLost(0, failed(kind)), false, kind);
  assert.equal(retryLost(0, new Error("not a platform answer")), false);
});

test("an address that isn't a page is named as such, not as the overview", () => {
  assert.equal(pageTitle("/"), "Overview");
  assert.equal(pageTitle("/automations/"), "Strategy");
  assert.equal(pageTitle("/typo"), "Page not found");
});
