import { test } from "node:test";
import assert from "node:assert/strict";
import { PlatformError } from "../src/platform.ts";
import { observeOwnerAction } from "../src/features/owner/owner-observation.ts";

type State = { stage: string; status?: string };
/** A status read answering each of `answers` in turn: a state, or a failure to throw. */
const reader = (...answers: (State | Error)[]) => {
  let reads = 0;
  return { read: async () => { const answer = answers[reads++]; if (!answer) throw new Error("read past the end"); if (answer instanceof Error) throw answer; return answer; },
    get reads() { return reads; } };
};
const lostRead = () => new PlatformError({ ok: false, kind: "unavailable" });

test("an owner action is observed while it is submitting, until it settles", async () => {
  const status = reader({ stage: "submitting" }, { stage: "submitting" }, { stage: "submitted", status: "SUCCESS" });
  const seen: string[] = [];
  const state = await observeOwnerAction(status.read, new AbortController().signal, s => seen.push(s.stage), 1);
  assert.deepEqual(state, { stage: "submitted", status: "SUCCESS" });
  assert.deepEqual(seen, ["submitting", "submitting", "submitted"]);
});

test("a lost status answer is read again: it neither ends the observation nor decides it", async () => {
  const status = reader({ stage: "submitting" }, lostRead(), lostRead(), { stage: "submitted", status: "SUCCESS" });
  assert.deepEqual(await observeOwnerAction(status.read, new AbortController().signal, undefined, 1), { stage: "submitted", status: "SUCCESS" });
  assert.equal(status.reads, 4);
});

test("any other failed status read ends the observation with that failure", async () => {
  const refused = new PlatformError({ ok: false, kind: "refused", error: "Unknown intent" });
  const status = reader({ stage: "submitting" }, refused);
  await assert.rejects(observeOwnerAction(status.read, new AbortController().signal, undefined, 1), refused);
});

test("an observation stops when it is aborted, without reading again", async () => {
  const controller = new AbortController();
  const status = reader({ stage: "submitting" }, { stage: "submitting" });
  const observed = observeOwnerAction(status.read, controller.signal, () => controller.abort(), 60_000);
  await assert.rejects(observed);
  assert.equal(status.reads, 1);
});
