import assert from "node:assert/strict";
import { test } from "node:test";
import { ATTESTATION, MODEL, steward, verifiedInference } from "../src/llm.js";

// Live: needs NEARAI_API_KEY. Attestation can't be faked offline, so this runs against NEAR AI Cloud,
// whose gateway reported TCB OutOfDate with four Intel advisories on 2026-10-10 (pinned in ATTESTATION).
const apiKey = process.env.NEARAI_API_KEY;
if (process.env.PROTO_TEST_MODE !== "live" || !apiKey) throw new Error("Run configured live checks with pnpm test:live");
const live = { timeout: 180_000 };

/** The refusal behind an error, whether thrown directly or wrapped as a connection error's cause. */
const refusal = (error: unknown): string => {
  const cause = (error as { cause?: unknown }).cause;
  return [String(error), cause ? String(cause) : "", JSON.stringify((error as { failure?: unknown }).failure ?? "")].join(" ");
};

test("today's deployment passes the steward's policy", live, async () => {
  await verifiedInference(apiKey!).inference.verify(MODEL);
});

test("a gateway advisory outside the reviewed set fails closed", live, async () => {
  const [, ...rest] = ATTESTATION.gatewayAdvisories;
  const { inference } = verifiedInference(apiKey!, { ...ATTESTATION, gatewayAdvisories: rest });
  await assert.rejects(inference.verify(MODEL), (error) => {
    assert.match(refusal(error), new RegExp(`unreviewed advisories ${ATTESTATION.gatewayAdvisories[0]}`));
    return true;
  });
});

test("the model must still be UpToDate: a chat request fails closed otherwise", live, async () => {
  const { llm } = verifiedInference(apiKey!, { ...ATTESTATION, modelTcb: ["Revoked"] });
  await assert.rejects(
    llm.chat.completions.create({ model: MODEL, messages: [{ role: "user", content: "Reply with ok." }] }),
    (error) => {
      assert.match(refusal(error), /tcb_status_not_allowed/);
      return true;
    },
  );
});

test("when attestation is refused, the steward stops before its first model turn or tool call", live, async () => {
  const events: unknown[] = [];
  await assert.rejects(
    async () => {
      for await (const event of steward({ instruction: "Review the treasury.", attestation: { ...ATTESTATION, modelTcb: ["Revoked"] } }))
        events.push(event);
    },
    (error) => {
      // Surfaced as the refusal itself, not as the OpenAI client's "Connection error".
      assert.match(String(error), /tcb_status_not_allowed|not allowed by policy/);
      return true;
    },
  );
  assert.deepEqual(events, []);
});

test("a response whose signature can't be verified is rejected", live, async () => {
  await assert.rejects(verifiedInference(apiKey!).inference.verifyResponse("chatcmpl-not-a-real-completion"));
});
