import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { freshDirectory } from "./fixtures/harness.js";
import { createWorkOrder, listWorkOrders, getWorkOrder, workOrderFile, workOrderInvoice, workOrderPolicy } from "../src/work-order-store.js";

freshDirectory("work-orders");
const parent = "parent-agent";
const input = {
  id: "12345678-1234-4234-8234-123456789abc",
  payee: "alice.near", amount: "1250000", note: "Design work",
  until: "2030-01-02T00:00:00.000Z", asset: "usdc-test",
  owner: { type: "near" as const, account_id: "owner.near", public_key: "ed25519:test" },
};
const now = Date.parse("2030-01-01T00:00:00Z");

test("one work order retains immutable terms and the same payment identity across reloads", () => {
  const first = createWorkOrder(parent, input, now);
  assert.deepEqual(createWorkOrder(parent, input, now + 100), first);
  assert.deepEqual(getWorkOrder(parent, input.id), first);
  assert.equal(listWorkOrders(parent).length, 1);
  assert.deepEqual(workOrderInvoice(first, "alice.near", now), {
    payee: "alice.near", amount: "1250000", note: "Design work", submission: input.id,
  });
  assert.deepEqual(workOrderInvoice(getWorkOrder(parent, input.id), "alice.near", now), workOrderInvoice(first, "alice.near", now));
  assert.throws(() => createWorkOrder(parent, { ...input, amount: "2000000" }, now), /different terms/);
  assert.throws(() => createWorkOrder(parent, { ...input, payee: "bob.near" }, now), /different terms/);
});

test("identity and deadline checks refuse before preparing an invoice", () => {
  const order = createWorkOrder(parent, input, now);
  assert.throws(() => workOrderInvoice(order, "bob.near", now), /not found/i);
  assert.throws(() => workOrderInvoice(order, "alice.near", Date.parse(input.until)), /deadline/);
  assert.throws(() => getWorkOrder("other-agent", input.id), /not found/i);
  assert.throws(() => getWorkOrder(parent, "../../other"));
  assert.throws(() => createWorkOrder("../escape", input, now));
  assert.throws(() => createWorkOrder(parent, { ...input, id: "12345678-1234-4234-8234-123456789abd", until: "2029-01-01T00:00:00Z" }, now), /deadline/);
});

test("two orders for one payee have separate immutable identities", () => {
  const first = createWorkOrder(parent, input, now);
  const second = createWorkOrder(parent, { ...input, id: "12345678-1234-4234-8234-123456789abd" }, now);
  assert.notEqual(workOrderInvoice(first, "alice.near", now).submission, workOrderInvoice(second, "alice.near", now).submission);
  assert.equal(listWorkOrders(parent).length, 2);
});

test("corrupt or mismatched work order records refuse instead of becoming missing or new orders", () => {
  createWorkOrder(parent, input, now);
  const file = workOrderFile(parent, input.id);
  const saved = readFileSync(file, "utf8");
  writeFileSync(file, saved.slice(0, 20));
  assert.throws(() => listWorkOrders(parent), /unavailable/);
  assert.throws(() => createWorkOrder(parent, input, now), /unavailable/);
  writeFileSync(file, saved.replace('"parent-agent"', '"other-agent"'));
  assert.throws(() => getWorkOrder(parent, input.id), /identity/);
});

test("order policy limits the dedicated agent to the agreed asset and confidential payee with owner approval", () => {
  const order = createWorkOrder(parent, input, now);
  const policy = workOrderPolicy(order);
  assert.deepEqual(policy.actions, ["transfer"]);
  assert.deepEqual(policy.assets, [input.asset]);
  assert.equal(policy.owner_approval, true);
  assert.deepEqual(policy.destinations, { mode: "only", list: [{ action: "transfer", address: input.payee, confidential: true }] });
  assert.deepEqual(policy.limits.per_transaction, { [input.asset]: input.amount });
  assert.equal(policy.timelock_ms, 0);
});
