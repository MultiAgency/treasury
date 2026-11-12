import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { appClient } from "@multiagency/sdk";
import { verifySdk, verifyPlatform, PLATFORM_COMMIT, CANDIDATE } from "../../../scripts/sdk-pin.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

test("stack pin refuses an older or overlaid snapshot before starting any process", () => {
  const directory = tempDir("sdk-pin-refusal-");
  for (const snapshot of [
    { sourceHead: "6f9ef3ae9decb9b073843a9f9c8cfc869ffff49e", runDigest: "e7f171abb42baa5dc6b05d3bb72eb6f3bb43d5d17a80a66c135914bce885be01", overlayDiffSha256: null },
    { sourceHead: "2e7b1e6f231da5be62d077d67f7bc2686c57bdc9", runDigest: CANDIDATE, overlayDiffSha256: null },
    { sourceHead: PLATFORM_COMMIT, runDigest: "different-candidate", overlayDiffSha256: null },
    { sourceHead: PLATFORM_COMMIT, runDigest: CANDIDATE, overlayDiffSha256: "unreviewed-overlay" },
  ]) {
    writeFileSync(join(directory, "SNAPSHOT.json"), JSON.stringify(snapshot));
    assert.throws(() => verifyPlatform(directory), /Platform snapshot identity mismatch/);
  }
});

test("both Treasury consumers install the exact frozen SDK provenance", () => {
  verifySdk();
  for (const entry of [new URL("../package.json", import.meta.url), new URL("../../../web/package.json", import.meta.url)]) {
    const installed = createRequire(entry).resolve("@multiagency/sdk");
    const provenance = JSON.parse(readFileSync(join(dirname(installed), "..", "..", "provenance.json"), "utf8"));
    assert.equal(provenance.sourceHead, PLATFORM_COMMIT);
    assert.equal(provenance.snapshot.runDigest, CANDIDATE);
    assert.deepEqual(provenance.sourcesDirty, []);
  }
});

const request = { id: "approval-1", dao: "dao.near", organization: "dao--near", agent: "market-agent", agentId: "agent-1",
  requestId: "original-hire", approved: {}, validUntil: "2026-11-12T17:00:00Z", votingUntil: 1, hash: "original-hash", description: "Exact terms" };

function scripted(answers: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const client = appClient({ base: "https://platform.test", credential: "test-only", fetch: async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    const answer = answers.shift();
    assert.ok(answer, "an unexpected retry must fail");
    return answer();
  } });
  return { client, calls };
}

test("funding, funding_review and unknown remain observations of the original hire, without a replacement send", async () => {
  for (const state of ["funding", "funding_review", "unknown"] as const) {
    const { client, calls } = scripted([
      () => Response.json({ json: { requestId: request.requestId, state, code: null, taskId: null, taskState: null } }),
      () => Response.json({ state: "pending", request, ...(state !== "unknown" && { hireState: state }) }),
    ]);
    const status = await client.agent(request.organization, request.agent).call("market/status", { requestId: request.requestId });
    assert.ok(status.ok);
    assert.equal(status.value.state, state);
    const approval = await client.daoHires.state(request.id);
    assert.ok(approval.ok);
    assert.equal(approval.value.state, "pending");
    assert.equal(approval.value.request.requestId, request.requestId);
    assert.equal(approval.value.request.hash, request.hash);
    assert.deepEqual(calls.map(call => call.body), [{ json: { requestId: request.requestId } }, null]);
    assert.ok(calls[1]!.url.endsWith(`/dao-hires/${request.id}`));
  }
});

test("agent_answer_unverified and a lost response preserve the approval identity with no automatic refiling", async () => {
  for (const failed of [() => Response.json({ error: "Unverified", code: "agent_answer_unverified" }, { status: 502 }),
    () => { throw new Error("lost reply"); }]) {
    const { client, calls } = scripted([failed, () => Response.json({ state: "pending", request, hireState: "funding_review" })]);
    const first = await client.daoHires.state(request.id);
    assert.equal(first.ok, false);
    if (first.ok) throw new Error("Expected an unknown outcome");
    assert.equal(first.kind, "unavailable");
    if (first.kind === "unavailable" && first.httpStatus === 502) assert.equal(first.code, "agent_answer_unverified");
    assert.equal(calls.length, 1, "the SDK does not retry or mint a request");
    const next = await client.daoHires.state(request.id);
    assert.ok(next.ok);
    assert.equal(next.value.request.requestId, request.requestId);
    assert.equal(calls[0]!.url, calls[1]!.url);
    assert.deepEqual(calls.map(call => call.method), ["GET", "GET"]);
  }
});

test("repeated DAO filing yields no transaction until explicit checked recovery, which never offers proposalAndVote", async () => {
  const proposal = { receiverId: request.dao, actions: [] };
  const { client, calls } = scripted([
    () => Response.json({ request, repeated: true, transactions: { proposal: null, proposalAndVote: null } }),
    () => Response.json({ request, repeated: true, transactions: { proposal, proposalAndVote: null } }),
  ]);
  const input = { organization: request.organization, agent: request.agent, requestId: request.requestId, brief: "Exact terms",
    approved: { handle: "worker", brief: "b".repeat(64), network: "near:mainnet" as const, asset: "usdc", payTo: "market.near", amount: "1", maxTimeoutSeconds: 900 }, validUntil: request.validUntil };
  const repeated = await client.daoHires.file(input);
  assert.ok(repeated.ok);
  assert.equal(repeated.value.transactions.proposal, null);
  assert.equal(calls.length, 1);
  // This is a test caller's explicit decision after its DAO inspection; Treasury exposes no Market filing UI.
  const recovered = await client.daoHires.file({ ...input, recoverProposal: "dao-checked" });
  assert.ok(recovered.ok);
  assert.deepEqual(recovered.value.transactions, { proposal, proposalAndVote: null });
  assert.deepEqual(calls.map(call => call.body), [input, { ...input, recoverProposal: "dao-checked" }]);
  assert.equal(recovered.value.request.id, repeated.value.request.id);
  assert.equal(recovered.value.request.requestId, repeated.value.request.requestId);
});
