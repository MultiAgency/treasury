import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../src/gateway/config.js";

test("gateway approve-only survives an instance file requesting execution", () => {
  const dir = mkdtempSync(join(tmpdir(), "executor-review-"));
  try {
    const envFile = join(dir, "instance.env");
    writeFileSync(envFile, "EXECUTOR=on\n");
    const env = childEnv({ name: "fixture", owner: "owner.near", port: 4001, executor: false, envFile });
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `const {executes,saveEnv}=await import('./src/env.ts'); console.log(executes()); saveEnv({EXECUTOR:'on'}); console.log(executes());`], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "false\nfalse");
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

const { draftOf, changesOf, differences } = await import(new URL("../web/src/features/policy/policy-draft.ts", import.meta.url).href);
const { paymentAssets } = await import(new URL("../web/src/features/payables/payment-assets.ts", import.meta.url).href);
const { ASSETS } = await import("../src/policy.js");
const book = [{ asset: ASSETS.USDC, symbol: "USDC", decimals: 6, public: "0", confidential: "0", usd: 0, price: 1 }];
for (const assets of ["any", [ASSETS.USDC, "extra"]] as const) test(`budget edit preserves ${typeof assets === "string" ? "any asset" : "extra asset"} and hidden limits`, () => {
  const policy = { actions: ["transfer"], assets, owner_approval: true, budget: { daily_usd: "25" }, limits: { daily: { [ASSETS.USDC]: "10000000", extra: "100" } } } as any;
  const before = draftOf(policy, book);
  const after = { ...before, budget: { ...before.budget, daily_usd: "24" } };
  const result = changesOf(after, book, policy);
  assert.ok("changes" in result);
  assert.deepEqual(result.changes.assets, assets);
  assert.deepEqual(result.changes.limits, policy.limits);
  assert.deepEqual(differences(before, after, book), ["Budget a day: $25.00 → $24.00"]);
});
test("editing a visible cap preserves hidden caps; blank explicitly removes only the visible cap", () => {
  const policy = { actions: ["transfer"], assets: "any", owner_approval: true, budget: {}, limits: { daily: { [ASSETS.USDC]: "10000000", extra: "100" } } } as any;
  const draft = draftOf(policy, book);
  draft.caps.daily[ASSETS.USDC] = "";
  const result = changesOf(draft, book, policy);
  assert.ok("changes" in result);
  assert.deepEqual(result.changes.limits, {daily: {extra: "100"}});
});
test("payout choices exclude unsupported assets even when wNEAR is first", () => {
  const all = [{ ...book[0], asset: ASSETS.wNEAR, symbol: "wNEAR" }, ...book];
  for (const label of ["payout", "invoices"]) assert.deepEqual(paymentAssets(all, label), book);
  assert.deepEqual(paymentAssets(all, "treasury"), all);
});

test("unrelated edits preserve zero caps and caps newly visible after the draft opened", () => {
  const policy = { actions: ["transfer"], assets: "any", owner_approval: true, budget: {}, limits: { daily: { [ASSETS.USDC]: "0", [ASSETS.wNEAR]: "42" } } } as any;
  const draft = draftOf(policy, book);
  const expanded = [...book, { ...book[0], asset: ASSETS.wNEAR, symbol: "wNEAR", decimals: 24 }];
  draft.rate = "3";
  const result = changesOf(draft, expanded, policy);
  assert.ok("changes" in result);
  assert.deepEqual(result.changes.limits, policy.limits);
});
