import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { DelegateAction, encodeSignedDelegateAction, generateKey, Near, parsePublicKey, type PrivateKey, serializeDelegateAction } from "near-kit";
import { ownerSignatureProblem } from "../src/owner-signature.js";

/**
 * A wallet's signature is relayed only when it covers exactly what this server prepared, with the
 * owner's key: whatever the wallet's own code did, a different message, call or key is refused here.
 */

const key = generateKey();
const owner = { type: "near" as const, account_id: "owner.near", public_key: key.publicKey.toString() };

const nep413 = {
  standard: "nep413" as const,
  payload: { message: '{"type":"grant_issue","label":"treasury"}', nonce: randomBytes(32).toString("base64"), recipient: "api.example" },
};

/** Signs a NEP-413 payload the way a wallet does (near-kit's signer). */
async function signMessage(payload: typeof nep413.payload, signer = key) {
  const near = new Near({ network: "mainnet", privateKey: signer.secretKey as PrivateKey, defaultSignerId: owner.account_id });
  const { publicKey, signature } = await near.signMessage({ ...payload, nonce: Buffer.from(payload.nonce, "base64") });
  return { ...nep413, payload, public_key: publicKey, signature };
}

test("a wallet's NEP-413 signature over the prepared message, with the owner's key, passes", async () => {
  assert.equal(ownerSignatureProblem(nep413, owner, await signMessage(nep413.payload)), null);
});

test("a NEP-413 signature over another message, by another key, or forged is refused", async () => {
  const other = { ...nep413.payload, message: '{"type":"grant_issue","label":"payout"}' };
  assert.match(ownerSignatureProblem(nep413, owner, await signMessage(other))!, /not the one prepared/);
  assert.match(ownerSignatureProblem(nep413, owner, await signMessage(nep413.payload, generateKey()))!, /isn't the owner's/);
  const forged = { ...(await signMessage(nep413.payload)), signature: Buffer.alloc(64, 1).toString("base64") };
  assert.match(ownerSignatureProblem(nep413, owner, forged)!, /doesn't verify/);
});

test("a NEP-413 signature that adds a callbackUrl is refused: the API's payload carries none", async () => {
  const callbackUrl = "https://proto.example/";
  const echoed = { ...(await signMessage(nep413.payload)), payload: { ...nep413.payload, callbackUrl } };
  assert.match(ownerSignatureProblem(nep413, owner, echoed)!, /not the one prepared/);
  const near = new Near({ network: "mainnet", privateKey: key.secretKey as PrivateKey, defaultSignerId: owner.account_id });
  const { signature } = await near.signMessage({ ...nep413.payload, nonce: Buffer.from(nep413.payload.nonce, "base64"), callbackUrl });
  const silent = { ...(await signMessage(nep413.payload)), signature };
  assert.match(ownerSignatureProblem(nep413, owner, silent)!, /doesn't verify/);
});

const nep366 = {
  standard: "nep366" as const,
  payload: { receiverId: "outlayer.near", actions: [{ type: "FunctionCall" as const, params: { methodName: "freeze_wallet", args: { wallet: "w" }, gas: "30000000000000", deposit: "1" } }] },
};

/** A signed delegate action as a wallet returns it: `call` overrides what it calls, `signer` signs, `sender` sends. */
function signDelegate({ call = {}, signer = key, sender = owner.account_id } = {} as { call?: object; signer?: ReturnType<typeof generateKey>; sender?: string }) {
  const publicKey = parsePublicKey(signer.publicKey.toString());
  const functionCall = { functionCall: { methodName: "freeze_wallet", args: new TextEncoder().encode('{"wallet":"w"}'), gas: 30_000_000_000_000n, deposit: 1n, ...call } };
  const action = new DelegateAction(sender, "outlayer.near", [functionCall], 5n, 100n, publicKey);
  const signature = signer.sign(createHash("sha256").update(serializeDelegateAction(action)).digest());
  const signed = encodeSignedDelegateAction({
    signedDelegate: {
      delegateAction: { senderId: sender, receiverId: "outlayer.near", actions: [functionCall], nonce: 5n, maxBlockHeight: 100n, publicKey: { ed25519Key: { data: Array.from(publicKey.data) } } },
      signature: { ed25519Signature: { data: Array.from(signature.data) } },
    },
  } as never);
  return { ...nep366, signed_delegate: signed };
}

test("a wallet's delegate action that calls exactly what was prepared, signed by the owner, passes", () => {
  assert.equal(ownerSignatureProblem(nep366, owner, signDelegate()), null);
});

test("a delegate action calling something else, from another account or key, is refused", () => {
  assert.match(ownerSignatureProblem(nep366, owner, signDelegate({ call: { methodName: "unfreeze_wallet" } }))!, /not the one prepared/);
  assert.match(ownerSignatureProblem(nep366, owner, signDelegate({ call: { args: new TextEncoder().encode('{"wallet":"x"}') } }))!, /not the one prepared/);
  assert.match(ownerSignatureProblem(nep366, owner, signDelegate({ call: { deposit: 2n } }))!, /not the one prepared/);
  assert.match(ownerSignatureProblem(nep366, owner, signDelegate({ sender: "mallory.near" }))!, /not from the owner's account/);
  assert.match(ownerSignatureProblem(nep366, owner, signDelegate({ signer: generateKey() }))!, /isn't the owner's/);
});

test("arguments are compared as JSON, so a wallet's key order doesn't matter", () => {
  const prepared = { ...nep366, payload: { ...nep366.payload, actions: [{ ...nep366.payload.actions[0]!, params: { ...nep366.payload.actions[0]!.params, args: { a: 1, b: 2 } } }] } };
  assert.equal(ownerSignatureProblem(prepared, owner, signDelegate({ call: { args: new TextEncoder().encode('{"b":2,"a":1}') } })), null);
});

test("another standard, unreadable bytes and a non-NEAR owner are refused", async () => {
  assert.match(ownerSignatureProblem(nep366, owner, await signMessage(nep413.payload))!, /another standard/);
  assert.match(ownerSignatureProblem(nep366, owner, { ...nep366, signed_delegate: "AAAA" })!, /can't be read/);
  assert.match(ownerSignatureProblem(nep413, { type: "evm", address: "0x1", chain_id: 1, public_key: "k" }, {})!, /outside this dashboard/);
});
