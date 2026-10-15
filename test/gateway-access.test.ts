import assert from "node:assert/strict";
import { test } from "node:test";
import { createRouterClient } from "@orpc/server";
import { resolveAgentAccess } from "../src/gateway/roles.js";
import { router } from "../src/router.js";
import { api } from "../src/api.js";

test("ownership refresh retains verified evidence; missing or ambiguous first evidence never means uncreated", async t => {
  const owner = "cache-owner.near";
  let answer: unknown = { agentId: "fixture", owner: { type: "near", account_id: owner } };
  let unavailable = false;
  const identityReads: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname.startsWith("/rpc/")) {
      identityReads.push(url.pathname);
      return unavailable ? new Response("", { status: 503 }) : Response.json({ json: answer });
    }
    return Response.json({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: owner } }, code: -32000, message: "Server error" } });
  });
  const agent = { name: "warm", owner, port: 18787 };
  assert.equal((await resolveAgentAccess(owner, agent, 0))?.canSign, true);
  assert.deepEqual(identityReads, ["/rpc/ownerIdentity"]);
  unavailable = true;
  assert.equal((await resolveAgentAccess(owner, agent, 60_001))?.canSign, true, "failed refresh retains previously verified owner");
  assert.equal(await resolveAgentAccess(owner, { ...agent, name: "cold" }, 60_001), null, "no previous ownership evidence stays denied");
  unavailable = false;
  answer = { agentId: "fixture", owner: null };
  assert.equal(await resolveAgentAccess(owner, agent, 60_002), null, "a malformed successful read invalidates previously verified ownership");
  unavailable = true;
  assert.equal(await resolveAgentAccess(owner, agent, 60_003), null, "later failed reads cannot restore invalidated ownership");
  unavailable = false;
  answer = { agentId: "fixture", owner: { type: "near", account_id: owner } };
  const changed = { ...agent, name: "changed" };
  assert.equal((await resolveAgentAccess(owner, changed, 0))?.canSign, true);
  answer = { agentId: "fixture", owner: { type: "near", account_id: "another-owner.near" } };
  assert.equal(await resolveAgentAccess(owner, changed, 60_001), null, "valid evidence of a different owner supersedes the cached owner");
  unavailable = true;
  assert.equal(await resolveAgentAccess(owner, changed, 120_002), null, "a failed refresh cannot restore an earlier matching owner");
  unavailable = false;
  for (const [name, value] of [
    ["missing-owner", { agentId: "fixture" }],
    ["null-owner", { agentId: "fixture", owner: null }],
    ["missing-agent", { owner: null }],
    ["inconsistent-agent", { agentId: null, owner: { type: "near", account_id: owner } }],
  ] as const) {
    answer = value;
    assert.equal(await resolveAgentAccess(owner, { ...agent, name }, 60_001), null, name);
  }
  answer = { agentId: null, owner: null };
  assert.equal((await resolveAgentAccess(owner, { ...agent, name: "uncreated" }, 60_001))?.canSign, true, "explicitly uncreated agent remains available to its configured owner");
});

test("the real ownership handler invalidates a warm owner when the provider successfully returns missing ownership", async t => {
  const owner = "provider-owner.near";
  const previousAgent = process.env.AGENT_ID;
  process.env.AGENT_ID = "provider-fixture";
  t.after(() => { if (previousAgent === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = previousAgent; });
  const client = createRouterClient(router);
  let provider: unknown;
  t.mock.method(api, "getAgent", async () => provider as never);
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname === "/rpc/ownerIdentity") {
      try { return Response.json({ json: await client.ownerIdentity() }); }
      catch { return new Response("", { status: 503 }); }
    }
    assert.ok(!url.pathname.startsWith("/rpc/"), "only the narrow ownership handler is called");
    return Response.json({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: owner } }, code: -32000, message: "Server error" } });
  });
  for (const [name, missing] of [
    ["provider-null-owner", { owner: null }], ["provider-missing-owner", {}],
    ["provider-null-agent", null], ["provider-missing-agent", undefined],
  ] as const) {
    const agent = { name, owner, port: 18788 };
    provider = { owner: { type: "near", account_id: owner } };
    assert.equal((await resolveAgentAccess(owner, agent, 0))?.canSign, true);
    provider = missing;
    assert.equal(await resolveAgentAccess(owner, agent, 60_001), null,
      "successful provider evidence without an owner invalidates expired cached ownership");
  }
});
