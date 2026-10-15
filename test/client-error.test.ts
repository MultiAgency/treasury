import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { call, ORPCError } from "@orpc/server";
import { AgentApiError } from "@near-intents-agent-api/sdk";
import { api } from "../src/api.js";
import { router } from "../src/router.js";

/** An Agent API refusal reaches the page with its code and, when the provider gives one, when to try again. */
test("a throttled refusal keeps its code and its retry time", async () => {
  const throttled = new AgentApiError(429, {
    errors: [{ status: "429", code: "policy_change_throttled", title: "Too many policy changes", meta: { retryable: true, available_at: "2026-10-14T00:00:00Z" } }],
    meta: {},
  } as never);
  mock.method(api, "getPolicyHistory", async () => { throw throttled; });
  const error = await call(router.policyHistory, undefined).catch((e: unknown) => e);
  mock.restoreAll();
  assert.ok(error instanceof ORPCError);
  assert.deepEqual(error.data, { code: "policy_change_throttled", availableAt: "2026-10-14T00:00:00Z" });
});
