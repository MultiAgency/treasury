import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { createRouterClient } from "@orpc/server";
import { api } from "../src/api.js";
import { router } from "../src/router.js";
import { mandateDigest } from "../src/mandate.js";
import { readOps } from "../src/ops.js";
import { ASSETS, payoutPolicy } from "../src/policy.js";
import { authorityFixture, fixtureGrant, policyView, timedPrices } from "./fixtures/authority.js";
import { freshDirectory, offline } from "./fixtures/harness.js";

freshDirectory("upstream-compat");
const policy = payoutPolicy(["payee.near"]);
const expectedPolicy = { revision: 1, digest: mandateDigest(policy) };
const request = { recipient: "payee.near", asset: ASSETS.USDC, amount: "1000000", confidential: true, expectedPolicy };
const client = createRouterClient(router);
let sends: unknown[];
beforeEach(() => {
  offline();
  process.env.EXECUTOR = "on";
  process.env.AGENT_GRANT_TOKEN = "ngt_upstream_fixture";
  sends = [];
  for (const [name, value] of Object.entries(authorityFixture())) mock.method(api, name as keyof typeof api, value as never);
  mock.method(api, "getPolicy", async () => policyView(policy));
  mock.method(api, "getTokens", async () => timedPrices(Object.values(ASSETS).map(asset_id => ({ asset_id, symbol: "fixture", decimals: 6, price: 1 }))) as never);
  mock.method(api, "forGrant", () => ({ transfer: async (_id: string, terms: unknown) => {
    sends.push(terms); return { correlation_id: "fixture-held" };
  } }) as never);
  mock.method(api, "getStatus", async () => ({ correlation_id: "fixture-held", status: "PENDING_APPROVAL" }) as never);
});
afterEach(() => mock.restoreAll());

test("equivalent near.com recipients cannot create a second held payout", async () => {
  await client.pay(request);
  assert.deepEqual(await client.pay({ ...request, recipient: " nearcom:Payee.near " }),
    { outcome: "refused", code: "duplicate_held_payout" });
  assert.equal(sends.length, 1);
});

test("near.com entry is canonical before journaling and provider submission", async () => {
  await client.pay({ ...request, recipient: "NEARCOM:Payee.near" });
  assert.deepEqual(sends, [{ recipient: "payee.near", asset: ASSETS.USDC, amount: "1000000", confidential: true }]);
  assert.equal(readOps()[0]?.request.recipient, "payee.near");
});

test("malformed near.com entries fail before provider reads", async () => {
  const read = mock.method(api, "getPolicy", async () => { throw new Error("must not read"); });
  for (const recipient of ["nearcom:", "nearcom:nearcom:payee.near", "nearcom:alice..near", "nearcom: alice.near"]) {
    await assert.rejects(client.pay({ ...request, recipient }), { code: "BAD_REQUEST" });
  }
  assert.equal(read.mock.callCount(), 0);
  assert.equal(sends.length, 0);
});

test("owner policy preparation receives a canonical near.com destination", async () => {
  const generate = mock.method(api, "generateIntent", async (input: { policy?: typeof policy }) => {
    assert.deepEqual(input.policy?.destinations.list, [{ action: "transfer", address: "payee.near", confidential: true }]);
    throw new Error("canonical policy reached generation");
  });
  await assert.rejects(client.owner.prepare({ signer: "wallet", action: {
    type: "policy_update", expectedPolicy,
    changes: { destinations: [{ address: "nearcom:Payee.near", confidential: true }] },
  } }), /canonical policy reached generation/);
  assert.equal(generate.mock.callCount(), 1);
});

test("overview retains revoked and expired grants without making them executable", async () => {
  const live = fixtureGrant("payout");
  const expired = { ...live, grant_id: "expired", expires_at: "2020-01-01T00:00:00Z" };
  const revoked = { ...live, grant_id: "revoked", revoked_at: new Date().toISOString() };
  mock.method(api, "listGrants", async () => [expired, revoked]);
  assert.deepEqual((await client.overview()).grants, [expired, revoked]);
  assert.deepEqual(await client.pay(request), { outcome: "refused", code: "grant_missing" });
  assert.equal(sends.length, 0);
});
