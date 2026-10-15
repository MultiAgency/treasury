import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, rmSync, statSync } from "node:fs";
import { freshDirectory } from "./fixtures/harness.js";
import { createWorkOrder } from "../src/work-order-store.js";
import { callWorkOrder, closeWorkOrders, workOrderEnvironment, workOrderSettings } from "../src/work-order-pool.js";

freshDirectory("work-order-pool");
const input = () => ({ id: "12345678-1234-4234-8234-123456789abc", payee: "alice.near",
  amount: "1250000", note: "Design work", until: new Date(Date.now() + 86_400_000).toISOString(),
  asset: "usdc-test", owner: { type: "near" as const, account_id: "owner.near", public_key: "ed25519:test" } });

test("work order processes inherit infrastructure but never parent authority or automatic execution", () => {
  const order = createWorkOrder("parent-agent", input());
  const env = workOrderEnvironment(order, workOrderSettings(order), {
    AGENT_ID: "parent-agent", AGENT_GRANT_TOKEN: "parent-secret", AGENT_GRANT_TOKEN_PENDING: "pending-secret",
    OWNER_PRIVATE_KEY: "owner-secret", TREASURY_ACCOUNT: "parent-dao.near", AUTOPILOT: "on",
    AGREEMENTS_SECRET: "bridge-secret", NEAR_INTENTS_AGENT_API_KEY: "infrastructure", PATH: "/bin",
  });
  assert.equal(env.AGENT_ID, undefined);
  assert.equal(env.AGENT_GRANT_TOKEN, undefined);
  assert.equal(env.AGENT_GRANT_TOKEN_PENDING, undefined);
  assert.equal(env.OWNER_PRIVATE_KEY, undefined);
  assert.equal(env.TREASURY_ACCOUNT, undefined);
  assert.equal(env.AGREEMENTS_SECRET, undefined);
  assert.equal(env.AUTOPILOT, "off");
  assert.equal(env.NEAR_INTENTS_AGENT_API_KEY, "infrastructure");
});

test("real private subprocesses start independently and retain immutable order identities", async () => {
  const first = createWorkOrder("parent-agent", input());
  const second = createWorkOrder("parent-agent", { ...input(), id: "12345678-1234-4234-8234-123456789abd" });
  try {
    const [one, two] = await Promise.all([
      callWorkOrder("parent-agent", first.id, { type: "snapshot" }),
      callWorkOrder("parent-agent", second.id, { type: "snapshot" }),
    ]);
    assert.equal(one.agentId, null);
    assert.equal(two.agentId, null);
    assert.equal(one.order.id, first.id);
    assert.equal(two.order.id, second.id);
    assert.equal(one.grant, null);
    assert.equal(one.policyReady, false);
    assert.notEqual(workOrderSettings(first), workOrderSettings(second));
    assert.equal(statSync(workOrderSettings(first)).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(workOrderSettings(first), "utf8"), /AGENT_ID|GRANT_TOKEN/);
    await assert.rejects(callWorkOrder("other-parent", first.id, { type: "snapshot" }), /not found/i);
    await assert.rejects(callWorkOrder("parent-agent", first.id, { type: "file", payee: "bob.near" }), /not found/i);
    await assert.rejects(callWorkOrder("parent-agent", first.id, { type: "status", correlationId: "another-order-action" }), /not found/i);
    await assert.rejects(callWorkOrder("parent-agent", first.id, { type: "file", payee: "alice.near" }), /not ready/);
    // A retained initialization marker must never silently recreate lost credentials.
    const third = createWorkOrder("parent-agent", { ...input(), id: "12345678-1234-4234-8234-123456789abe" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${workOrderSettings(third)}.initialized`, "retained");
    rmSync(workOrderSettings(third), { force: true });
    await assert.rejects(callWorkOrder("parent-agent", third.id, { type: "snapshot" }), /settings are missing/);
  } finally { await closeWorkOrders(); }
});
