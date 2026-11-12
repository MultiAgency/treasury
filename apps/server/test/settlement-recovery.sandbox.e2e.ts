import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Near } from "near-kit";
import { Sandbox } from "near-kit/sandbox";
import { verifyPlatform, PLATFORM_COMMIT } from "../../../scripts/sdk-pin.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const platform = resolve(process.env.TREASURY_PLATFORM ?? join(import.meta.dirname, "../../../../platform"));
const fixture = fileURLToPath(new URL("./fixtures/settlement-worker.mjs", import.meta.url));
type Message = { stage: string; recovery: { outcome: string; status?: string }[];
  ops: { correlationId?: string; status?: string; submissionState?: string; refused?: string }[]; blocked: boolean; sends: unknown[] };

function worker(directory: string) {
  // Deliberately exclude inherited provider credentials, instance settings, and live network configuration.
  const child = spawn(process.execPath, ["--import", join(platform, "node_modules/tsx/dist/loader.mjs"), fixture], {
    cwd: directory, env: { PATH: process.env.PATH, NODE_ENV: "test", AGENT_ID: "a".repeat(64),
      AGENT_GRANT_TOKEN: "ngt_fixture", NEAR_INTENTS_AGENT_API_KEY: `naa_${"x".repeat(43)}`,
      NEAR_INTENTS_AGENT_API_URL: "http://127.0.0.1:9", NEAR_RPC_URL: "http://127.0.0.1:9" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr += chunk; });
  const exited = once(child, "exit");
  const next = async (): Promise<Message> => {
    const timeout = AbortSignal.timeout(35_000);
    return await Promise.race([
      once(child, "message", { signal: timeout }).then(([message]) => message as Message),
      exited.then(([code]) => { throw new Error(`Worker exited before evidence (${code}): ${stderr}`); }),
    ]);
  };
  return { child, next, exited, async stop() {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  } };
}

test("real sandbox settlement: crash before/after operation ID never causes a second transfer", { timeout: 180_000 }, async () => {
  verifyPlatform(platform);
  const sandbox = await Sandbox.start();
  const near = new Near({ network: sandbox });
  const amount = 10n ** 24n;
  const evidence: unknown[] = [];
  try {
    for (const boundary of ["before-id", "after-id"] as const) {
      const directory = tempDir(`treasury-settlement-${boundary}-`);
      const recipient = `${boundary}.${sandbox.rootAccount.id}`;
      await near.transaction(sandbox.rootAccount.id).createAccount(recipient).transfer(recipient, amount).send({ waitUntil: "FINAL" });
      const account = () => near.rpc.getAccount(recipient, { finality: "final" });
      const before = BigInt((await account()).amount);
      const config = { platform, rpcUrl: sandbox.rpcUrl, signer: sandbox.rootAccount.id, secretKey: sandbox.rootAccount.secretKey,
        recipient, amount: amount.toString(), requestAmount: "1000000", boundary };
      const frozen = worker(directory);
      try {
        const denied = frozen.next();
        frozen.child.send({ ...config, mode: "freeze-before", frozen: true });
        const result = await denied;
        assert.equal(result.stage, "frozen");
        assert.equal((await frozen.exited)[0], 0);
        assert.deepEqual(result.sends, []);
        assert.equal(result.ops[0]!.refused, "policy_not_in_force");
        assert.equal(BigInt((await account()).amount), before, "freeze before submission leaves the recipient unchanged");
      } finally { await frozen.stop(); }
      const submitting = worker(directory);
      try {
        const paused = submitting.next();
        submitting.child.send({ ...config, mode: "submit" });
        assert.equal((await paused).stage, boundary);
      } finally { await submitting.stop(); }
      assert.equal(submitting.child.signalCode, "SIGKILL", "executor was killed at the chosen boundary");
      const chain = JSON.parse(readFileSync(join(directory, "chain-evidence.json"), "utf8"));
      assert.equal(BigInt((await account()).amount) - before, amount);
      const settled = await near.getTransactionStatus(chain.hash, sandbox.rootAccount.id, "FINAL");
      assert.equal(settled.transaction.hash, chain.hash);
      assert.equal(settled.transaction.signer_id, sandbox.rootAccount.id);
      assert.equal(settled.transaction.receiver_id, recipient);
      assert.deepEqual(settled.transaction.actions, [{ Transfer: { deposit: amount.toString() } }]);
      assert.ok(typeof settled.status === "object" && "SuccessValue" in settled.status);
      let recovered: Message | undefined;
      // Recover twice in separate processes: a second restart must remain poll-only too.
      for (let pass = 0; pass < 2; pass++) {
        const recovering = worker(directory);
        try {
          const answer = recovering.next();
          recovering.child.send({ ...config, mode: "recover", frozen: true });
          recovered = await answer;
          assert.equal(recovered.stage, "recovered");
          assert.equal((await recovering.exited)[0], 0);
          assert.equal(recovered.sends.length, 1);
          assert.equal(recovered.ops.length, 2, "one refused frozen attempt and one actual submission");
          recovered.ops = recovered.ops.filter(op => op.refused === undefined);
          assert.equal(recovered.ops.length, 1);
          assert.equal(recovered.blocked, boundary === "before-id");
          if (boundary === "before-id") {
            assert.equal(recovered.recovery[0]!.outcome, "unknown");
            assert.equal(recovered.ops[0]!.correlationId, undefined);
            assert.equal(recovered.ops[0]!.submissionState, "SUBMISSION_ATTEMPTED");
          } else {
            if (pass === 0) assert.deepEqual(recovered.recovery, [{ outcome: "settled", status: "SUCCESS" }]);
            else assert.deepEqual(recovered.recovery, []);
            assert.equal(recovered.ops[0]!.correlationId, chain.hash);
            assert.equal(recovered.ops[0]!.status, "SUCCESS");
          }
          assert.equal(BigInt((await account()).amount) - before, amount, "recipient credited exactly once across recovery");
        } finally { await recovering.stop(); }
      }
      evidence.push({ boundary, freezeBeforeSubmission: "refused without a send", recoveryWhileFrozen: true, transaction: chain, recipientBalanceBefore: before.toString(), recipientBalanceAfter: (await account()).amount,
        recovery: recovered, journal: readFileSync(join(directory, ".ops", `${"a".repeat(64)}.jsonl`), "utf8") });
    }
    const output = resolve(import.meta.dirname, "../../../.test-artifacts/settlement-recovery");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "latest.json"), JSON.stringify({ platformCommit: PLATFORM_COMMIT, recordedAt: new Date().toISOString(),
      adapterMapping: "1 fixture USDC raw unit = 10^18 yoctoNEAR; native NEAR transfer, no token custody",
      scope: "Pinned platform dispatch/recovery; fixture policy/grant; native NEAR sandbox transfer adapter; not live provider settlement", evidence }, null, 2));
  } finally { await sandbox.stop(); }
});
