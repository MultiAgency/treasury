import assert from "node:assert/strict";
import { test } from "node:test";
import { readAssistantStream } from "../src/assistant-stream.ts";
import { serverApi, type AssistantStreamEvent } from "../src/server-api.ts";

const answer = { answer: "Runway holds — $60,000 remains.", sources: [], drafts: [], model: "rules" };
const start = { type: "RUN_STARTED", threadId: "treasury", runId: "run-1" };
const finish = { type: "RUN_FINISHED", threadId: "treasury", runId: "run-1", result: answer };
const encode = (event: unknown, newline = "\n") => `data: ${JSON.stringify(event)}${newline}${newline}`;
const sse = (text: string, status = 200) => new Response(text, { status, headers: { "content-type": "text/event-stream; charset=utf-8" } });

test("live progress is delivered before completion, including SSE and UTF-8 split across byte boundaries", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const events: AssistantStreamEvent[] = [];
  let progress!: () => void;
  const progressed = new Promise<void>(resolve => { progress = resolve; });
  const reading = readAssistantStream(new Response(body, { headers: { "content-type": "text/event-stream" } }), event => {
    events.push(event);
    if (event.type === "TOOL_CALL_START") progress();
  });
  const first = `: keep-alive\r\n\r\n${encode(start, "\r\n")}${encode({ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "run_what_if" }, "\r\n")}`;
  for (const byte of new TextEncoder().encode(first)) controller.enqueue(Uint8Array.of(byte));
  await progressed;
  assert.deepEqual(events.map(event => event.type), ["RUN_STARTED", "TOOL_CALL_START"], "the answer is still pending");
  const rest = encode({ type: "TOOL_CALL_END", toolCallId: "t1" }, "\r\n") + encode(finish, "\r\n");
  for (const byte of new TextEncoder().encode(rest)) controller.enqueue(Uint8Array.of(byte));
  controller.close();
  assert.deepEqual(await reading, { ok: true, value: answer });
});

test("SSE accepts data lines and comments with CR, LF or CRLF line endings", async () => {
  for (const newline of ["\r", "\n", "\r\n"]) {
    const terminal = `data: {"type":"RUN_FINISHED",${newline}data: "threadId":"treasury","runId":"run-1","result":${JSON.stringify(answer)}}${newline}${newline}`;
    assert.deepEqual(await readAssistantStream(sse(`: comment${newline}${newline}${encode(start, newline)}${terminal}`)), { ok: true, value: answer });
  }
});

test("an interrupted, malformed, mismatched or oversized run is lost, never a completed answer", async () => {
  for (const text of [
    encode(start),
    encode(finish),
    encode(start) + encode({ ...finish, runId: "someone-else" }),
    encode(start) + encode({ ...finish, threadId: "someone-else" }),
    encode(start) + encode(start) + encode(finish),
    encode(start) + encode({ ...finish, result: { ...answer, drafts: [{ kind: "send_funds" }] } }),
    encode(start) + "data: not-json\n\n",
    encode(start) + "data: " + "x".repeat(1_048_577),
    encode(start) + encode(finish).trimEnd(),
  ]) assert.deepEqual(await readAssistantStream(sse(text)), { ok: false, kind: "lost" });
  assert.deepEqual(await readAssistantStream(sse(encode(start) + encode(finish), 503)), { ok: false, kind: "lost" });
});

test("stream errors use codes, and pre-stream JSON admission failures retain their kinds", async () => {
  for (const code of ["rate_limited", "platform_budget", "unavailable", "provider_error"]) {
    assert.deepEqual(await readAssistantStream(sse(encode(start) + encode({ type: "RUN_ERROR", code, message: "Never inspect this message" }))),
      code === "rate_limited" || code === "platform_budget" ? { ok: false, kind: "refused", code } : { ok: false, kind: "unavailable" });
  }
  for (const failure of [{ ok: false, kind: "not_signed_in" }, { ok: false, kind: "not_owner" }, { ok: false, kind: "refused", code: "bad_request" }]) {
    assert.deepEqual(await readAssistantStream(Response.json(failure, { status: 403 })), failure);
  }
  assert.deepEqual(await readAssistantStream(Response.json({ ok: true, value: answer })), { ok: true, value: answer }, "compatible JSON servers still answer");
  assert.deepEqual(await readAssistantStream(new Response("upstream failed", { status: 502 })), { ok: false, kind: "lost" });
});

test("askStream sends only the selected scenario and text history, same-origin, once", async () => {
  const sent: { path: string; init: RequestInit }[] = [];
  const api = serverApi(async (path, init) => {
    sent.push({ path: String(path), init: init! });
    return sse(encode(start) + encode(finish));
  });
  assert.deepEqual(await api.agent("portfolio").askStream("Explain this scenario", [], "stabilization", { context: { whatIf: { volatileDropPct: 30 } } }), { ok: true, value: answer });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.path, "/api/agents/portfolio/assistant");
  assert.equal(sent[0]!.init.credentials, "same-origin");
  assert.equal(new Headers(sent[0]!.init.headers).get("accept"), "text/event-stream");
  assert.deepEqual(JSON.parse(String(sent[0]!.init.body)), { question: "Explain this scenario", history: [], persona: "stabilization", context: { whatIf: { volatileDropPct: 30 } } });
  await assert.rejects(api.agent("portfolio").askStream("Explain", [], "stabilization", { context: { whatIf: { balance: 10 } } as never }));
  assert.equal(sent.length, 1, "invalid context never reaches the server");
  let calls = 0;
  assert.deepEqual(await serverApi(async () => { calls++; throw new Error("connection closed"); }).agent("portfolio").askStream("What if?", []), { ok: false, kind: "lost" });
  assert.equal(calls, 1, "a lost stream is never automatically retried");
});
