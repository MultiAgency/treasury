import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { createRouterClient } from "@orpc/server";
import { router } from "../src/router.js";
import { api } from "../src/api.js";
import { mayCall } from "../src/gateway/allowlist.js";
import { freshDirectory } from "./fixtures/harness.js";
freshDirectory("instance-status");
const readerAccess = { canSign: false, canPropose: false, canVote: false, canExecute: false, canManage: false };
test("instance identity is private member-readable configuration with no provider dependency", async () => {
  mock.method(globalThis, "fetch", async () => assert.fail("Instance status must not call a provider"));
  const client = createRouterClient(router);
  process.env.AGENT_ID = "fixture";
  process.env.EXECUTOR = "off";
  assert.deepEqual(await client.instance(), { agentId: "fixture", executor: false });
  process.env.EXECUTOR = "on";
  assert.deepEqual(await client.instance(), { agentId: "fixture", executor: true });
  assert.equal(mayCall(readerAccess, "instance"), true);
  assert.equal(mayCall(readerAccess, "autopilot/stop"), false);
  process.env.EXECUTOR = "off";
  await assert.rejects(client.autopilot.stop(), /executor/);
  delete process.env.AGENT_ID;
  assert.deepEqual(await client.instance(), { agentId: null, executor: false });
});

test("gateway ownership evidence reads only the configured agent and leaves instance status provider-free", async t => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("Ownership must not read DAO funding or other setup state"));
  const getAgent = t.mock.method(api, "getAgent", async () => ({ owner: { type: "near", account_id: "owner.near" } }) as never);
  t.mock.method(api, "listGrants", async () => assert.fail("Ownership must not read or adopt grants"));
  process.env.AGENT_ID = "fixture";
  process.env.TREASURY_ACCOUNT = "linked-dao.near";
  const client = createRouterClient(router);
  assert.deepEqual(await client.ownerIdentity(), { agentId: "fixture", owner: { type: "near", account_id: "owner.near" } });
  assert.deepEqual(getAgent.mock.calls.map(call => call.arguments), [["fixture"]]);
  assert.equal(mayCall(readerAccess, "ownerIdentity"), false, "the narrow gateway read does not add a member permission");
  for (const missing of [{ owner: null }, {}]) {
    getAgent.mock.mockImplementation(async () => missing as never);
    assert.deepEqual(await client.ownerIdentity(), { agentId: "fixture", owner: null },
      "a successful provider read with missing ownership retains the configured agent identity");
  }
  getAgent.mock.mockImplementation(async () => { throw new Error("Provider unavailable"); });
  await assert.rejects(client.ownerIdentity(), /Provider unavailable/);
  assert.deepEqual(await client.instance(), { agentId: "fixture", executor: false });
  delete process.env.AGENT_ID;
  assert.deepEqual(await client.ownerIdentity(), { agentId: null, owner: null });
  delete process.env.TREASURY_ACCOUNT;
});
