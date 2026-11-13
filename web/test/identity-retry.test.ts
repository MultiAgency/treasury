import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import { retryIdentity } from "../src/identity-retry.ts";

test("a starting agent's safe read recovers after transient unavailability", async () => {
  const client = new QueryClient();
  let reads = 0;
  try {
    const result = await client.fetchQuery({ queryKey: ["identity"], queryFn: async () => {
      if (++reads < 4) throw { kind: "unavailable" as const };
      return { agentId: null, created: false };
    }, retry: (count, error: any) => retryIdentity(count, error), retryDelay: 0 });
    assert.deepEqual(result, { agentId: null, created: false });
    assert.equal(reads, 4);
  } finally { client.clear(); }
});

test("identity retries stop after three attempts and never retry auth or refused reads", () => {
  assert.equal(retryIdentity(3, { ok: false, kind: "unavailable" }), false);
  for (const failure of [undefined, { ok: false, kind: "not_signed_in" } as const,
    { ok: false, kind: "not_owner" } as const, { ok: false, kind: "refused", code: "platform_rate_limited" } as const])
    assert.equal(retryIdentity(0, failure), false);
});
