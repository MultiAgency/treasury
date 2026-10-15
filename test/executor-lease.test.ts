import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { acquireExecutorLease } from "../src/executor-lease.js";

test("one executor owns an agent, while another agent remains independent", async () => {
  const id = `test-${randomUUID()}`;
  const release = await acquireExecutorLease(id);
  try {
    await assert.rejects(acquireExecutorLease(id), /already running/);
    await (await acquireExecutorLease(`${id}-other`))();
  } finally { await release(); }
  await (await acquireExecutorLease(id))();
});
