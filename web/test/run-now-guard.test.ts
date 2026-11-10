import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunNowGuard } from "../src/proposals/run-now-guard.ts";
import { proposalsApi, type Result } from "../src/proposals/proposals-api.ts";
import { fail, lost, ok, scripted } from "./proposals-fixtures.ts";

type Reply = Result<{ summary: string }>;
const success: Reply = { ok: true, value: { summary: "Ran: nothing to rebalance." } };
const unavailable: Reply = { ok: false, kind: "unavailable" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("Run now is claimed before sending and a second view cannot send while its reply is pending", async () => {
  const guard = createRunNowGuard(), reply = deferred<Reply>();
  let sent = 0;
  const pending = guard.run("portfolio", () => { sent++; assert.equal(guard.hold("portfolio"), "pending"); return reply.promise; });
  assert.equal(await guard.run("portfolio", async () => { sent++; return success; }), undefined);
  assert.equal(guard.hold("portfolio"), "pending", "a newly mounted reader sees the same hold");
  assert.equal(guard.hold("savings"), undefined);
  assert.equal(sent, 1);
  reply.resolve(success);
  assert.deepEqual(await pending, success);
  assert.equal(guard.hold("portfolio"), undefined);
  await guard.run("portfolio", async () => { sent++; return success; });
  assert.equal(sent, 2, "a definite reply permits a new explicit attempt");
});

test("lost, unavailable and malformed tick replies keep their hold rather than sending another request", async () => {
  const cases = [lost, fail({ kind: "unavailable" }, 503),
    () => new Response("upstream timeout", { status: 504 }),
    ok({ summary: 42 }), ok({ summary: "Ran", unexpected: true }),
    () => Response.json({ ok: false, kind: "unrecognized" })];
  for (const answer of cases) {
    const guard = createRunNowGuard(), server = scripted(), agent = proposalsApi(server.fetcher).agent("portfolio");
    server.answer("POST /api/agents/portfolio/autopilot/tick", answer);
    const result = await guard.run("portfolio", agent.runNow);
    assert.equal(result?.ok, false);
    assert.equal(guard.hold("portfolio"), "unknown");
    assert.equal(await guard.run("portfolio", agent.runNow), undefined, "a later view cannot retry it");
    assert.equal(server.sent.length, 1);
  }
});

test("a thrown run call is also unknown and cannot be repeated", async () => {
  const guard = createRunNowGuard();
  const result = await guard.run("portfolio", async () => { throw new Error("connection dropped"); });
  assert.deepEqual(result, { ok: false, kind: "lost" });
  assert.equal(guard.hold("portfolio"), "unknown");
  let sent = false;
  await guard.run("portfolio", async () => { sent = true; return success; });
  assert.equal(sent, false);
});

test("a parsed tick reply releases its hold without guessing execution outcomes from its summary", async () => {
  for (const summary of ["Ran: nothing to rebalance.", "Skipped: autopilot paused.", "Failed: unresolved operation."]) {
    const guard = createRunNowGuard(), server = scripted(), agent = proposalsApi(server.fetcher).agent("portfolio");
    server.answer("POST /api/agents/portfolio/autopilot/tick", ok({ summary }));
    assert.deepEqual(await guard.run("portfolio", agent.runNow), { ok: true, value: { summary } });
    assert.equal(guard.hold("portfolio"), undefined, "the attempt answered; platform records still guard unresolved money operations");
  }
});

test("parsed admission and policy refusals allow an explicit retry without an automatic resend", async () => {
  for (const [failure, status] of [[{ kind: "not_signed_in" }, 401], [{ kind: "not_owner" }, 403],
    [{ kind: "refused", code: "not_connected" }, 409], [{ kind: "refused", code: "autopilot_refused" }, 409],
    [{ kind: "refused", code: "platform_rate_limited" }, 429]] as const) {
    const guard = createRunNowGuard(), server = scripted(), agent = proposalsApi(server.fetcher).agent("portfolio");
    server.answer("POST /api/agents/portfolio/autopilot/tick", fail(failure, status), ok(success.value));
    assert.equal((await guard.run("portfolio", agent.runNow))?.ok, false);
    assert.equal(guard.hold("portfolio"), undefined);
    assert.equal(server.sent.length, 1, "a refusal is not automatically retried");
    assert.equal((await guard.run("portfolio", agent.runNow))?.ok, true);
    assert.equal(server.sent.length, 2);
  }
});

test("a late reply for one agent cannot release another agent's unknown hold", async () => {
  const guard = createRunNowGuard(), reply = deferred<Reply>();
  const first = guard.run("portfolio", () => reply.promise);
  await guard.run("savings", async () => unavailable);
  reply.resolve(success);
  await first;
  assert.equal(guard.hold("portfolio"), undefined);
  assert.equal(guard.hold("savings"), "unknown");
  await guard.run("another", async () => success);
  assert.equal(guard.hold("savings"), "unknown");
});

test("mounted readers are notified of pending and unknown holds; another loaded app has its own store", async () => {
  const guard = createRunNowGuard(), phases: (string | undefined)[] = [];
  const stop = guard.subscribe(() => { phases.push(guard.hold("portfolio")); });
  await guard.run("portfolio", async () => unavailable);
  assert.deepEqual(phases, ["pending", "unknown"]);
  stop();
  assert.equal(guard.hold("portfolio"), "unknown");
  assert.equal(createRunNowGuard().hold("portfolio"), undefined, "a reload/new tab has no correlated platform attempt to recover");
});
