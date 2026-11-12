import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { EventType } from "@ag-ui/core";
import { whatIfRequest } from "../src/proposals/agents-view.ts";
import { askConversation } from "../src/proposals/conversation-request.ts";
import { busyKeys, clearConversations, conversationKey, conversations, reserveWhatIf, selectWhatIf, toolProgress,
  whatIfContext, whatIfWorkspace } from "../src/proposals/conversations.ts";
import type { AssistantAnswer, AssistantStreamEvent, AssistantWhatIf, ProposalsApi, Result } from "../src/proposals/proposals-api.ts";

type AskStream = ReturnType<ProposalsApi["agent"]>["askStream"];
const agent = "portfolio";
const key = conversationKey(agent, "stabilization");
const scenario = (drop: number): AssistantWhatIf => {
  const now = { id: "now", label: "Today", valueUsd: 100_000, lossUsd: 0, drawdownPct: 0, stableUsd: 60_000,
    runwayMonths: 30, floorUsd: 12_000, floorBreached: false, unfundedUsd: 0, tradable: true, reasons: [] };
  return { event: { volatileDropPct: drop }, answer: { problems: [], result: {
    basedOn: { at: "2026-11-06T12:00:00.000Z", seq: 9 }, label: `NEAR falls ${drop}%`, now,
    after: { ...now, valueUsd: 100_000 - drop * 400, lossUsd: drop * 400, drawdownPct: drop * 0.4 },
  } } };
};
const answered = (whatIf = scenario(50)): AssistantAnswer => ({ answer: "The scenario is calculated. [S1]", model: "rules", drafts: [],
  sources: [{ id: "S1", label: "Recorded book", read: "risk/what-if", at: "2026-11-06T12:00:00.000Z" }], whatIf });

function pending() {
  let resolve!: (answer: Result<AssistantAnswer>) => void;
  let onEvent!: (event: AssistantStreamEvent) => void;
  let sent: Parameters<AskStream> | undefined;
  const result = new Promise<Result<AssistantAnswer>>(done => { resolve = done; });
  const ask: AskStream = (...args) => { sent = args; onEvent = args[3]!.onEvent!; return result; };
  return { ask, complete: resolve, emit: (event: AssistantStreamEvent) => onEvent(event), sent: () => sent! };
}

beforeEach(clearConversations);

test("chat publishes a calculated scenario live and sends only the edited inputs on its next turn", async () => {
  assert.equal(whatIfContext(agent), undefined, "an untouched default is not supplied as the owner's selected scenario");
  const first = pending();
  const run = askConversation(agent, "stabilization", first.ask, "What if NEAR falls 50%?");
  first.emit({ type: EventType.TOOL_CALL_START, toolCallId: "t1", toolCallName: "run_what_if" });
  assert.equal(toolProgress.get(key)?.get("t1"), "run_what_if");
  first.emit({ type: EventType.TOOL_CALL_END, toolCallId: "t1" });
  assert.equal(toolProgress.get(key)?.get("t1"), "run_what_if", "arguments ending is not the tool's completion");
  first.emit({ type: EventType.STATE_SNAPSHOT, snapshot: { whatIf: scenario(50) } });
  assert.equal(whatIfWorkspace(agent).answer?.result?.after.valueUsd, 80_000, "the result is visible before the final prose");
  first.emit({ type: EventType.TOOL_CALL_RESULT, toolCallId: "t1", messageId: "result-1", content: '{"ok":true}', role: "tool" });
  assert.equal(toolProgress.get(key)?.size, 0);
  first.complete({ ok: true, value: answered() });
  await run;
  assert.equal(busyKeys.has(key), false);
  selectWhatIf(agent, "drop", "30");
  const second = pending();
  const followUp = askConversation(agent, "stabilization", second.ask, "Explain this scenario");
  assert.deepEqual(second.sent()[3]?.context, { whatIf: { volatileDropPct: 30 } });
  assert.equal(JSON.stringify(second.sent()[3]?.context).includes("valueUsd"), false, "computed balances are never client-supplied context");
  assert.deepEqual(second.sent()[1].map(turn => turn.role), ["user", "assistant"]);
  second.complete({ ok: true, value: answered(scenario(30)) });
  await followUp;
  assert.equal(whatIfWorkspace(agent).value, "30");
});

test("a manual edit or newer calculation keeps a late chat result from replacing the owner's selected scenario", async () => {
  const stream = pending();
  const run = askConversation(agent, "stabilization", stream.ask, "What if NEAR falls 50%?");
  selectWhatIf(agent, "drop", "20");
  stream.emit({ type: EventType.STATE_SNAPSHOT, snapshot: { whatIf: scenario(50) } });
  assert.equal(whatIfWorkspace(agent).value, "20");
  assert.equal(whatIfWorkspace(agent).answer, undefined);
  stream.complete({ ok: true, value: answered() });
  await run;
  assert.equal(whatIfWorkspace(agent).value, "20");
  assert.equal(conversations.get(key)?.at(-1)?.role, "assistant", "the answer remains in its own conversation");

  const old = pending(), latest = pending();
  const oldRun = askConversation(agent, "stabilization", old.ask, "What if NEAR falls 50%?");
  const latestRun = askConversation(agent, "treasury", latest.ask, "What if NEAR falls 10%?");
  latest.complete({ ok: true, value: answered(scenario(10)) });
  await latestRun;
  old.complete({ ok: true, value: answered(scenario(50)) });
  await oldRun;
  assert.equal(whatIfWorkspace(agent).value, "10", "the most recently started question owns the shared workspace across personas");
});

test("a fractional chat calculation stays explainable and supplies its inputs on follow-up", async () => {
  const first = pending();
  const run = askConversation(agent, "stabilization", first.ask, "What if NEAR falls 0.5%?");
  first.emit({ type: EventType.STATE_SNAPSHOT, snapshot: { whatIf: scenario(0.5) } });
  first.complete({ ok: true, value: answered(scenario(0.5)) });
  await run;
  const workspace = whatIfWorkspace(agent);
  assert.equal(workspace.answer?.result?.after.valueUsd, 99_800);
  assert.equal(whatIfRequest(workspace.event, workspace.value).ok, true, "Explain this scenario remains enabled for valid fractional inputs");
  const followUp = pending();
  const explained = askConversation(agent, "stabilization", followUp.ask, "Explain this scenario");
  assert.deepEqual(followUp.sent()[3]?.context, { whatIf: { volatileDropPct: 0.5 } });
  followUp.complete({ ok: true, value: answered(scenario(0.5)) });
  await explained;
});

test("sign-out ignores late stream events and answers without ending a new account's question", async () => {
  const old = pending();
  const oldRun = askConversation(agent, "stabilization", old.ask, "Private old-account question");
  const oldRevision = whatIfWorkspace(agent).revision;
  clearConversations();
  assert.equal(toolProgress.size, 0);
  assert.equal(whatIfContext(agent), undefined);
  const fresh = pending();
  const freshRun = askConversation(agent, "stabilization", fresh.ask, "New-account question");
  assert.ok(whatIfWorkspace(agent).revision > oldRevision);
  old.emit({ type: EventType.TOOL_CALL_START, toolCallId: "old-tool", toolCallName: "get_account" });
  old.emit({ type: EventType.STATE_SNAPSHOT, snapshot: { whatIf: scenario(90) } });
  old.complete({ ok: true, value: answered(scenario(90)) });
  await oldRun;
  assert.deepEqual(conversations.get(key), [{ role: "user", text: "New-account question" }]);
  assert.equal(toolProgress.get(key)?.size, 0);
  assert.equal(whatIfWorkspace(agent).answer, undefined);
  assert.equal(busyKeys.has(key), true, "the old answer cannot release the new account's pending request");
  fresh.complete({ ok: true, value: answered(scenario(10)) });
  await freshRun;
  assert.equal(whatIfWorkspace(agent).value, "10");
  assert.equal(busyKeys.has(key), false);
});

test("a lost stream releases conversation progress and never retries or leaves a question busy", async () => {
  let calls = 0;
  await askConversation(agent, "stabilization", async () => { calls++; throw new Error("disconnected"); }, "Explain this scenario");
  assert.equal(calls, 1);
  assert.equal(busyKeys.has(key), false);
  assert.equal(toolProgress.has(key), false);
  assert.match((conversations.get(key)?.at(-1) as { text: string }).text, /answer was lost/);
});

test("targeted and combined chat scenarios retain their full inputs until a manual edit", async () => {
  reserveWhatIf(agent, true);
  const stream = pending();
  const run = askConversation(agent, "stabilization", stream.ask, "What if both events happen?");
  const combined = { ...scenario(50), event: { volatileDropPct: 50, stablePrice: 0.9, asset: "near" } };
  stream.complete({ ok: true, value: answered(combined) });
  await run;
  assert.deepEqual(whatIfContext(agent), { whatIf: combined.event });
  selectWhatIf(agent, "depeg", "0.8");
  assert.deepEqual(whatIfContext(agent), { whatIf: { stablePrice: 0.8 } });
  selectWhatIf(agent, "depeg", "");
  assert.equal(whatIfContext(agent), undefined, "invalid form input is not supplied as a scenario");
});
