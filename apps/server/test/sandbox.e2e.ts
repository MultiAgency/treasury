// The real on-chain key check, against near-kit's Sandbox: a local NEAR node, downloaded and started for this test.
// Run on its own (`pnpm --filter @treasury/server test:sandbox`), not on every pull request.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { generateKey, Near, parseKey } from "near-kit";
import { Sandbox } from "near-kit/sandbox";
import { chainKeyLookup, type KeyLookup } from "../src/keys.ts";

let sandbox: Sandbox, near: Near, lookup: KeyLookup;
const freshKey = () => generateKey().publicKey.toString();

before(async () => {
  sandbox = await Sandbox.start();
  near = new Near({ network: sandbox });
  lookup = chainKeyLookup({ rpcUrl: sandbox.rpcUrl, apiKey: undefined, timeoutMs: 10_000 });
}, { timeout: 300_000 });

after(async () => { await sandbox?.stop(); });

test("the account's own key is a full-access key", async () => {
  const { id, secretKey } = sandbox.rootAccount;
  assert.equal(await lookup(id, parseKey(secretKey).publicKey.toString()), "full");
});

test("a function-call key is limited; a key or account that doesn't exist is none", async () => {
  const { id } = sandbox.rootAccount, limited = freshKey();
  await near.transaction(id).addKey(limited, { type: "functionCall", receiverId: id }).send({ waitUntil: "FINAL" });
  assert.equal(await lookup(id, limited), "limited");
  assert.equal(await lookup(id, freshKey()), "none");
  assert.equal(await lookup(`nobody.${id}`, freshKey()), "none");
});

test("an RPC that doesn't answer is unavailable, not none", async () => {
  const dead = chainKeyLookup({ rpcUrl: "http://127.0.0.1:9", apiKey: undefined, timeoutMs: 2_000 });
  assert.equal(await dead(sandbox.rootAccount.id, freshKey()), "unavailable");
});
