import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { api } from "../src/api.js";
import { prepare, submit } from "../src/owner-intents.js";
import { payoutPolicy, ASSETS } from "../src/policy.js";
import { canonical } from "../src/mandate.js";
import { policyView } from "./fixtures/authority.js";
import { freshDirectory } from "./fixtures/harness.js";
import { walletIntent, walletSignature, walletSigner } from "./fixtures/wallet-signature.js";

freshDirectory("owner-records");
const path = ".owner-intents/.env.json";
const startupFixture = fileURLToPath(new URL("./fixtures/owner-intents.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
const terms = { to: "example.near", token: ASSETS.USDC, amount: "1000000" };
const requestHash = createHash("sha256").update(canonical({ ...terms, chain: "near", flow: "transfer", kind: "confidential" })).digest("hex");
let sends = 0;
beforeEach(() => {
  sends = 0;
  mock.method(api, "getPolicy", async () => policyView(payoutPolicy([terms.to])) as never);
  mock.method(api, "getWallet", async () => ({ wallet_id: "wallet-fixture" }) as never);
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, agent_id: process.env.AGENT_ID,
    type: correlation_id === "payment" ? "transfer" : "approval_vote",
    status: correlation_id === "payment" ? "PENDING_APPROVAL" : "PENDING_SIGNATURE", details: { approval_id: "approval" } }) as never);
  mock.method(api, "getApproval", async () => ({ approval_id: "approval", wallet_id: "wallet-fixture", status: "PENDING",
    expires_at: "2099-01-01T00:00:00Z", request_type: "confidential", request_data: terms, request_hash: requestHash }) as never);
  mock.method(api, "generateIntent", async () => ({ type: "approval_vote", correlation_id: "vote", expires_at: "2099-01-01T00:00:00Z",
    preview: { approval: { approval_id: "approval", request_hash: requestHash, verdict: "approve" } }, intent: walletIntent, signer: walletSigner }) as never);
  mock.method(api, "submitIntent", async () => { sends++; throw new Error("simulated response loss"); });
});
afterEach(() => mock.restoreAll());

async function attempted() {
  await prepare({ type: "approval_vote", approvalId: "approval", correlationId: "payment", verdict: "approve" });
  await assert.rejects(submit("vote", await walletSignature()), /simulated response loss/);
  assert.equal(sends, 1);
}

for (const stage of ["submited", undefined, "prepared"]) test(`ambiguous owner lifecycle cannot resend an attempted approval: ${stage ?? "missing"}`, async () => {
  await attempted();
  const saved = JSON.parse(readFileSync(path, "utf8"));
  saved.vote.stage = stage;
  writeFileSync(path, JSON.stringify(saved));
  const before = readFileSync(path, "utf8");
  const restart = spawnSync(process.execPath, ["--import", tsx, startupFixture, "vote"], {
    env: { ...process.env, ENV_FILE: "" }, encoding: "utf8", timeout: 10_000,
  });
  assert.notEqual(restart.status, 0, "a restarted process refuses invalid owner history before following signatures");
  assert.match(restart.stderr, /Owner-intent history unavailable/);
  let error: unknown;
  try { await submit("vote", await walletSignature()); } catch (caught) { error = caught; }
  assert.equal(sends, 1, "retained signature with ambiguous lifecycle must never be submitted again");
  assert.match(String(error), /Owner-intent history unavailable/);
  assert.equal(readFileSync(path, "utf8"), before, "invalid evidence stays untouched for investigation");
});

test("a valid attempted approval stays poll-only", async () => {
  await attempted();
  assert.equal((await submit("vote", await walletSignature())).status, "PENDING_SIGNATURE");
  assert.equal(sends, 1);
});

for (const result of [
  { status: "PROCESSING" },
  { status: "UNCERTAIN" },
  { status: "EXPIRED" },
]) test(`an owner record cannot claim settlement without a proven outcome: ${result.status}`, async () => {
  await attempted();
  const saved = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(saved.vote, { stage: "settled", result, grantToken: "fixture-retained-token" });
  writeFileSync(path, JSON.stringify(saved));
  const before = readFileSync(path, "utf8");
  const restart = spawnSync(process.execPath, ["--import", tsx, startupFixture, "vote"], {
    env: { ...process.env, ENV_FILE: "" }, encoding: "utf8", timeout: 10_000,
  });
  assert.notEqual(restart.status, 0, "restart must reject unproven settlement before cleanup");
  assert.match(restart.stderr, /Owner-intent history unavailable/);
  await assert.rejects(submit("vote", await walletSignature()), /Owner-intent history unavailable/);
  assert.equal(sends, 1);
  assert.equal(readFileSync(path, "utf8"), before, "invalid evidence and its retained token stay untouched");
});

for (const result of [
  { status: "SUCCESS" }, { status: "FAILED" }, { status: "REFUNDED" },
  { status: "EXPIRED", failureCode: "signing_window_closed" },
]) test(`proven owner settlement remains usable without another submission: ${result.status}`, async () => {
  await attempted();
  const saved = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(saved.vote, { stage: "settled", result });
  writeFileSync(path, JSON.stringify(saved));
  assert.deepEqual(await submit("vote", await walletSignature()), result);
  assert.equal(sends, 1);
});

test("a legacy unsigned preparation without stage remains usable", async () => {
  await prepare({ type: "approval_vote", approvalId: "approval", correlationId: "payment", verdict: "approve" });
  const saved = JSON.parse(readFileSync(path, "utf8"));
  delete saved.vote.stage;
  writeFileSync(path, JSON.stringify(saved));
  await assert.rejects(submit("vote", await walletSignature()), /simulated response loss/);
  assert.equal(sends, 1);
});
