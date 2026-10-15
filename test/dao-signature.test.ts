import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { generateKey } from "near-kit";
import { api } from "../src/api.js";
import { signingRequest } from "../src/dao-owner.js";
import { followDaoVotes, status, submit } from "../src/owner-intents.js";

/**
 * A DAO's owner signature is found on chain once its vote passes, verified against the prepared hash,
 * and submitted; it never needs the browser wallet's check. Offline: the chain's transactions come from
 * a stand-in FastNear answer carrying the MPC signature, made here with a key standing in for the DAO's.
 */

const home = process.cwd();
const key = generateKey();
const owner = { type: "near" as const, account_id: "c1bec849".padEnd(64, "0"), public_key: key.publicKey.toString() };
const intent = { standard: "nep413" as const, payload: { message: '{"type":"grant_issue"}', nonce: Buffer.alloc(32, 9).toString("base64"), recipient: "api.test" } };
let submitted: unknown[];
// Outcomes are kept in memory per process: each test prepares its own intent.
let id = "";
let n = 0;

/** The v1.signer receipt a passed proposal leaves: the Ed25519 signature over `hash`, as JSON in its SuccessValue. */
function chainWith(signature: Uint8Array) {
  const value = Buffer.from(JSON.stringify({ scheme: "Ed25519", signature: [...signature] })).toString("base64");
  mock.method(globalThis, "fetch", async (url: string) => {
    const body = String(url).endsWith("/account")
      ? { account_txs: [{ transaction_hash: "tx" }] }
      : { transactions: [{ receipts: [{ execution_outcome: { outcome: { status: { SuccessValue: value } } } }] }] };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
}

beforeEach(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "dao-signature-")));
  mkdirSync(".owner-intents");
  process.env.TREASURY_ACCOUNT = "fixture.sputnik-dao.near";
  submitted = [];
  id = `intent-dao-${++n}`;
  mock.method(api, "submitIntent", async (request: unknown) => { submitted.push(request); return { status: "QUEUED" }; });
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, status: "SUCCESS" }));
  const dao = { ...(await signingRequest(intent, owner)), since: 1 };
  writeFileSync(join(".owner-intents", ".env.json"), JSON.stringify({
    [id]: { type: "grant_issue", expiresAt: new Date(Date.now() + 300_000).toISOString(), stage: "prepared", dao },
  }));
});
afterEach(() => { mock.restoreAll(); delete process.env.TREASURY_ACCOUNT; process.chdir(home); });

test("a passed vote's MPC signature over the prepared hash is submitted, and the intent settles", async () => {
  const dao = await signingRequest(intent, owner);
  chainWith(key.sign(Buffer.from(dao.hash, "hex")).data);
  await followDaoVotes();
  assert.equal(submitted.length, 1);
  assert.equal(status(id).stage, "submitted");
});

test("a signature on chain that isn't over the prepared hash is not submitted", async () => {
  chainWith(key.sign(Buffer.alloc(32, 1)).data);
  await followDaoVotes();
  assert.deepEqual(submitted, []);
  assert.equal(status(id).stage, "voting");
});

test("a DAO's intent can't be submitted from the browser with a signature of its own", async () => {
  await assert.rejects(submit(id, { signature: "x" }), /wasn't prepared for a wallet's signature/);
  assert.deepEqual(submitted, []);
});
