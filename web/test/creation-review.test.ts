import { test } from "node:test";
import assert from "node:assert/strict";
import { creationMatches, sameCreation } from "../src/creation-review.ts";
import type { Creation, Identity } from "../src/proposals-api.ts";

const identity: Identity = { agent: "portfolio", owner: "owner.near", account: "owner.near", host: "platform.test", agentId: null, signer: "wallet",
  access: { canSign: true, canPropose: false, canVote: false, canExecute: true, canManage: true } };
const creation: Creation = { correlationId: "c", expiresAt: "2026-11-10T20:00:00Z",
  intent: { standard: "nep413", payload: { message: "Exact provider text", recipient: "provider.test", nonce: "nonce" } },
  review: { owner: identity.owner, agent: identity.agent, host: identity.host, publicKey: "key" } };

test("a readable creation is bound to its unborn agent, signed-in owner and hosting origin, while retaining its provider recipient", () => {
  assert.equal(creationMatches(creation, identity), true);
  for (const changed of [{ agent: "another" }, { owner: "other.near" }, { account: "other.near" }, { host: "other.test" }, { agentId: "created" }, { signer: "dao" as const }])
    assert.equal(creationMatches(creation, { ...identity, ...changed }), false, JSON.stringify(changed));
  assert.equal(creationMatches({ ...creation, review: undefined }, identity), false);
});

test("the before-sign comparison includes the exact text, recipient, nonce, setup key, correlation and deadline", () => {
  assert.equal(sameCreation(creation, structuredClone(creation)), true);
  const changes: Creation[] = [
    { ...creation, correlationId: "new" }, { ...creation, expiresAt: "changed" },
    { ...creation, review: { ...creation.review!, publicKey: "new key" } },
    ...["message", "recipient", "nonce"].map(field => ({ ...creation, intent: { ...creation.intent!, payload: { ...creation.intent!.payload, [field]: "changed" } } })),
  ];
  for (const changed of changes) assert.equal(sameCreation(creation, changed), false);
});
