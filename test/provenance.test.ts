import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ATTESTATION, MODEL, saveProvenance } from "../src/llm.js";
import { loadPlan, savePlan, type Snapshot } from "../src/plans.js";
import { freshDirectory } from "./fixtures/harness.js";

freshDirectory("provenance", { per: "suite" });

const state: Snapshot = { agentId: "a".repeat(64), policyRevision: 1, policyDigest: "sha256:aa", strategyDigest: "sha256:cc", balances: {} };

test("a steward plan keeps why it exists: the model, its verified completions and the transcript", () => {
  const plan = savePlan(state, "steward", "shift 3 USD", [{ type: "shield", asset: "usdc", amount: "1" }]);
  const transcript = [
    { type: "verified" as const, completionId: "chatcmpl-1", signatureKind: "provider_tee" },
    { type: "call" as const, name: "shield_public", input: {} },
    { type: "result" as const, name: "shield_public", result: "PROPOSED as steps 1–1" },
  ];
  saveProvenance(plan, ATTESTATION, transcript);
  const record = JSON.parse(readFileSync(join(".plans", `${plan.id}.steward.json`), "utf8"));
  assert.equal(record.planId, plan.id);
  assert.equal(record.model, MODEL);
  assert.deepEqual(record.attestation, JSON.parse(JSON.stringify(ATTESTATION)));
  assert.deepEqual(record.transcript, transcript);
  // The record sits beside the plan without disturbing it.
  assert.deepEqual(loadPlan(plan.id), plan);
});
