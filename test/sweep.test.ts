import { authorityFixture, balanceView, fixtureGrant, policyView, timedPrices } from "./fixtures/authority.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { api } from "../src/api.js";
import { readOps } from "../src/ops.js";
import { ASSETS, treasuryPolicy } from "../src/policy.js";
import { sweep } from "../src/treasury.js";
import { freshDirectory, offline } from "./fixtures/harness.js";

/** A sweep's shields pass `authorize` like any send: the autopilot's need the owner's grant for the strategy in force. */

let sends: string[];
freshDirectory("sweep");
beforeEach(() => {
  process.env.AGENT_GRANT_TOKEN = "ngt_fixture";
  sends = [];
  offline();
  for (const [name, method] of Object.entries(authorityFixture("treasury"))) mock.method(api, name as keyof typeof api, method as never);
  mock.method(api, "getPolicy", async () => policyView(treasuryPolicy));
  mock.method(api, "getTokens", async () => timedPrices(Object.entries(ASSETS).map(([symbol, asset_id]) =>
    ({ asset_id, symbol, decimals: symbol === "USDC" ? 6 : symbol === "ETH" ? 18 : 24, price: 1 }))));
  mock.method(api, "getBalances", async (_id: string, { source }: { source: string }) =>
    balanceView(source, source === "public" ? [{ asset_id: ASSETS.wNEAR, balance_raw: "1000000000000000000000000" }] : []));
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, status: "SUCCESS" }));
  const shield = async (_id: string, _request: unknown, { idempotencyKey }: { idempotencyKey: string }) => {
    sends.push(idempotencyKey);
    return { correlation_id: `op_${sends.length}` };
  };
  mock.method(api, "forGrant", () => ({ shield, swap: shield, transfer: shield, unshield: shield }));
});
afterEach(() => mock.restoreAll());

const grant = (label: string) => mock.method(api, "listGrants", async () => [fixtureGrant(label)]);
const shields = async (autopilot: boolean) => {
  const statuses: string[] = [];
  for await (const event of sweep({ execute: true, autopilot })) if (event.type === "shield") statuses.push(event.status);
  return statuses;
};

test("the autopilot's sweep is refused before sending when the grant doesn't approve the strategy in force", async () => {
  grant("treasury");
  await assert.rejects(shields(true), { code: "grant_purpose_denied" });
  assert.deepEqual(sends, []);
  assert.equal(readOps().at(-1)?.refused, "grant_purpose_denied");
});

test("the autopilot's sweep is sent under a grant approving the strategy in force", async () => {
  grant(fixtureGrant().label);
  assert.deepEqual(await shields(true), ["SUCCESS"]);
  assert.equal(sends.length, 1);
});

test("an owner's sweep needs only a treasury grant", async () => {
  grant("treasury");
  assert.deepEqual(await shields(false), ["SUCCESS"]);
  assert.equal(sends.length, 1);
});
