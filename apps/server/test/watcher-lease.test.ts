import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { testChild } from "./test-process.ts";
import { createRequests } from "../src/requests.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

test("two watcher processes cannot own one store; process death releases ownership", { timeout: 15_000 }, async t => {
  const path = join(tempDir("treasury-lease-"), "requests.json");
  const module = new URL("../src/requests.ts", import.meta.url).href;
  const managed = testChild(t, ["--input-type=module", "-e", `
    const { createRequests } = await import(${JSON.stringify(module)});
    await createRequests(process.argv[1], { exclusive: true });
    process.send('ready');
    setInterval(() => {}, 1000);
  `, path], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  try {
    assert.equal(await managed.next<string>(), "ready");
    await assert.rejects(createRequests(path, { exclusive: true }), /Another watcher owns/);
    await managed.stop();
    const recovered = await createRequests(path, { exclusive: true });
    await recovered.release();
    const next = await createRequests(path, { exclusive: true });
    await next.release();
  } finally {
    await managed.stop();
  }
});

test("release drains pending writes and prevents a former owner from writing after handoff", async () => {
  const path = join(tempDir("treasury-lease-drain-"), "requests.json");
  const first = await createRequests(path, { exclusive: true });
  const body = { legs: "strategy" as const, expiresAt: "2026-11-14T00:00:00.000Z" };
  const writing = first.add("owner--near", "portfolio", body);
  await first.release();
  const stored = await writing;
  assert.ok(stored);
  await assert.rejects(first.add("owner--near", "portfolio", body), /released/);
  await assert.rejects(first.drop(stored), /released/);
  const next = await createRequests(path, { exclusive: true });
  try { assert.deepEqual(next.of("owner--near", "portfolio"), [stored]); }
  finally { await next.release(); }
});

test("a failed request-store load relinquishes ownership", async () => {
  const { writeFile, unlink } = await import("node:fs/promises");
  const path = join(tempDir("treasury-lease-invalid-"), "requests.json");
  await writeFile(path, "invalid", { mode: 0o600 });
  await assert.rejects(createRequests(path, { exclusive: true }), /doesn't hold/);
  await unlink(path);
  const recovered = await createRequests(path, { exclusive: true });
  await recovered.release();
});
