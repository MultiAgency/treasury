import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentTokens, fileTokenRecords, memoryTokenRecords } from "../src/agent-tokens.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const DAY = 86_400_000;
const clock = (start = 1_000_000) => { const time = { now: start }; return { time, now: () => time.now }; };

test("a token is shown once; the store keeps only the hash of its secret, and finds the token by it", async () => {
  const { now } = clock();
  const records = memoryTokenRecords(), tokens = createAgentTokens(records, { now });
  const issued = (await tokens.issue({ agent: "portfolio", account: "owner.near", days: 7, label: "rebalancer" }))!;
  assert.match(issued.token, /^tre1\.[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(records.all()).includes(issued.token.split(".")[2]!), false, "the secret is not stored");
  assert.equal(tokens.find(issued.token)?.id, issued.view.id);
  assert.equal(tokens.find(issued.token.slice(0, -1) + (issued.token.endsWith("A") ? "B" : "A")), undefined, "a wrong secret");
  assert.equal(tokens.find("tre1.0000000000000000." + "A".repeat(43)), undefined, "no such token");
  assert.equal(tokens.find("not a token"), undefined);
  assert.deepEqual(Object.keys(tokens.list("portfolio")[0]!).sort(), ["createdAt", "expiresAt", "id", "label", "lastUsedAt"], "a listing shows no secret or hash");
});

test("a token lasts 1 to 30 days, and lapses", async () => {
  const { time, now } = clock();
  const tokens = createAgentTokens(memoryTokenRecords(), { now });
  await assert.rejects(tokens.issue({ agent: "portfolio", account: "owner.near", days: 31 }), RangeError);
  await assert.rejects(tokens.issue({ agent: "portfolio", account: "owner.near", days: 0 }), RangeError);
  const issued = (await tokens.issue({ agent: "portfolio", account: "owner.near", days: 30 }))!;
  assert.equal(issued.view.expiresAt - issued.view.createdAt, 30 * DAY);
  time.now += 30 * DAY - 1;
  assert.ok(tokens.find(issued.token));
  time.now += 2;
  assert.equal(tokens.find(issued.token), undefined, "expired");
  assert.deepEqual(tokens.list("portfolio"), []);
});

test("a revoked token is refused from the next call, and only that agent's own can be revoked", async () => {
  const { now } = clock();
  const tokens = createAgentTokens(memoryTokenRecords(), { now });
  const mine = (await tokens.issue({ agent: "portfolio", account: "owner.near", days: 1 }))!, other = (await tokens.issue({ agent: "other", account: "owner.near", days: 1 }))!;
  assert.equal(await tokens.revoke("other", mine.view.id), false, "not by another agent's page");
  assert.ok(tokens.find(mine.token));
  assert.equal(await tokens.revoke("portfolio", mine.view.id), true);
  assert.equal(tokens.find(mine.token), undefined);
  assert.equal(await tokens.revoke("portfolio", mine.view.id), false, "already revoked");
  assert.ok(tokens.find(other.token), "another agent's is untouched");
});

test("disconnecting revokes every token for the agent and no other's", async () => {
  const { now } = clock();
  const tokens = createAgentTokens(memoryTokenRecords(), { now });
  const a = (await tokens.issue({ agent: "portfolio", account: "owner.near", days: 1 }))!, b = (await tokens.issue({ agent: "portfolio", account: "owner.near", days: 5 }))!;
  const c = (await tokens.issue({ agent: "other", account: "owner.near", days: 1 }))!;
  assert.equal(await tokens.revokeAll("portfolio"), 2);
  assert.deepEqual([tokens.find(a.token), tokens.find(b.token)], [undefined, undefined]);
  assert.ok(tokens.find(c.token));
  assert.equal(await tokens.revokeAll("portfolio"), 0);
});

test("a use is noted at once in memory and written at most once a minute", async () => {
  const { time, now } = clock();
  const records = memoryTokenRecords();
  let writes = 0;
  const counted = { ...records, commit: (change: Parameters<typeof records.commit>[0]) => { writes++; return records.commit(change); } };
  const tokens = createAgentTokens(counted, { now });
  const issued = (await tokens.issue({ agent: "portfolio", account: "owner.near", days: 1 }))!;
  const base = writes;
  await tokens.used(issued.view.id);
  assert.equal(tokens.list("portfolio")[0]!.lastUsedAt, time.now);
  time.now += 10_000;
  await tokens.used(issued.view.id);
  assert.equal(writes - base, 1, "the second use within a minute wrote nothing");
  assert.equal(tokens.list("portfolio")[0]!.lastUsedAt, time.now, "but is shown");
  time.now += 60_000;
  await tokens.used(issued.view.id);
  assert.equal(writes - base, 2);
});

test("an agent holds at most ten live tokens; an ended one frees a place", async () => {
  const { now } = clock();
  const tokens = createAgentTokens(memoryTokenRecords(), { now });
  const issued = [];
  for (let i = 0; i < 10; i++) issued.push((await tokens.issue({ agent: "portfolio", account: "owner.near", days: 1 }))!);
  assert.equal(await tokens.issue({ agent: "portfolio", account: "owner.near", days: 1 }), null);
  assert.ok(await tokens.issue({ agent: "other", account: "owner.near", days: 1 }), "another agent is not held");
  await tokens.revoke("portfolio", issued[0]!.view.id);
  assert.ok(await tokens.issue({ agent: "portfolio", account: "owner.near", days: 1 }));
});

test("the tokens file is owner-only, holds hashes, and survives a restart; a file others can read is refused", async () => {
  const path = join(tempDir("treasury-tokens-"), "tokens.json");
  const first = createAgentTokens(await fileTokenRecords(path));
  const issued = (await first.issue({ agent: "portfolio", account: "owner.near", days: 2 }))!;
  const text = await readFile(path, "utf8");
  assert.equal(text.includes(issued.token.split(".")[2]!), false, "no secret on disk");
  const again = createAgentTokens(await fileTokenRecords(path));
  assert.equal(again.find(issued.token)?.id, issued.view.id, "found after a restart");
  await again.revoke("portfolio", issued.view.id);
  assert.equal(createAgentTokens(await fileTokenRecords(path)).find(issued.token), undefined, "a revocation survives it too");
  await chmod(path, 0o644);
  await assert.rejects(fileTokenRecords(path), /0600/);
});
