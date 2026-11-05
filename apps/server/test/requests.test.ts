import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { proposalCreateInput } from "@multiagency/sdk";
import { createHolds, createRequests, memoryHolds, type Body } from "../src/requests.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const scratch = async () => join(tempDir("treasury-requests-"), "requests.json");

const BODY: Body = { legs: "strategy", expiresAt: "2026-11-05T12:00:00.000Z" };
const ID = "0123456789abcdef0123456789abcdef";

test("a request is on disk before add returns, with the exact body it will be sent with", async () => {
  const file = await scratch(), requests = await createRequests(file);
  const added = await requests.add("alice--near", "portfolio", BODY);
  assert.ok(added);
  const reloaded = await createRequests(file);
  assert.deepEqual(reloaded.of("alice--near", "portfolio"), [added]);
  assert.equal(reloaded.of("alice--near", "portfolio")[0]!.body, JSON.stringify(BODY));
});

test("the input sent is the stored body's values as stored, under its requestId, and the SDK accepts it", async () => {
  const file = await scratch(), requests = await createRequests(file);
  // The platform compares `JSON.stringify({ legs, expiresAt, note })` of the parsed input with what it stored
  // (`src/proposals/service.ts:93-98`): "…00Z" and "…00.000Z" are different requests, and so are reordered legs.
  const legs = [{ from: "usdc", to: "wnear", amount: "2", minAmountOut: "1" }, { from: "wnear", to: "usdc", amount: "1" }];
  const body = { legs, expiresAt: "2026-11-05T12:00:00Z", note: "drift 7.2 points" } as unknown as Body;
  const added = (await requests.add("alice--near", "portfolio", body))!;
  const sent = (await createRequests(file)).input(added);
  assert.equal(sent.requestId, added.requestId);
  assert.equal(JSON.stringify({ legs: sent.legs, expiresAt: sent.expiresAt, note: sent.note }), JSON.stringify({ legs, expiresAt: "2026-11-05T12:00:00Z", note: "drift 7.2 points" }));
  assert.ok(proposalCreateInput.safeParse({ ...requests.input((await requests.add("o", "portfolio", BODY))!) }).success);
});

test("a requestId names its agent, fits the platform's format, and is new each time", async () => {
  const requests = await createRequests(await scratch());
  const agent = "a".repeat(32);
  const first = (await requests.add("o", agent, BODY))!, second = (await requests.add("o", agent, BODY))!;
  for (const { requestId } of [first, second]) {
    assert.match(requestId, /^[A-Za-z0-9_-]{1,64}$/);
    assert.ok(requestId.startsWith(`${agent}_`));
  }
  assert.notEqual(first.requestId, second.requestId);
});

test("records are kept per Organization and agent", async () => {
  const requests = await createRequests(await scratch());
  const mine = (await requests.add("alice--near", "portfolio", BODY))!;
  await requests.add("bob--near", "portfolio", BODY);
  await requests.add("alice--near", "savings", BODY);
  assert.deepEqual(requests.of("alice--near", "portfolio"), [mine]);
});

test("the proposal a request made is recorded, and survives a restart", async () => {
  const file = await scratch(), requests = await createRequests(file);
  const added = (await requests.add("o", "portfolio", BODY))!;
  await requests.settle(added, ID);
  assert.equal(requests.of("o", "portfolio")[0]!.proposalId, ID);
  assert.equal((await createRequests(file)).of("o", "portfolio")[0]!.proposalId, ID);
});

test("a dropped request is gone, on disk too", async () => {
  const file = await scratch(), requests = await createRequests(file);
  const added = (await requests.add("o", "portfolio", BODY))!;
  await requests.drop(added);
  assert.deepEqual(requests.of("o", "portfolio"), []);
  assert.deepEqual((await createRequests(file)).of("o", "portfolio"), []);
});

test("dropping or settling one request leaves the agent's others, and another Organization's, as they were", async () => {
  const requests = await createRequests(await scratch());
  const first = (await requests.add("o", "portfolio", BODY))!, second = (await requests.add("o", "portfolio", BODY))!;
  const elsewhere = (await requests.add("p", "portfolio", BODY))!;
  await requests.settle(first, ID);
  assert.deepEqual(requests.of("o", "portfolio").map(record => record.proposalId), [ID, null]);
  assert.equal(requests.of("p", "portfolio")[0]!.proposalId, null);
  await requests.drop(first);
  assert.deepEqual(requests.of("o", "portfolio"), [second]);
  assert.deepEqual(requests.of("p", "portfolio"), [elsewhere]);
});

test("a request is known by Organization, agent and requestId: the platform scopes requestIds per Organization", async () => {
  const file = await scratch();
  const record = (organization: string) => ({ organization, agent: "portfolio", requestId: "portfolio_1", body: JSON.stringify(BODY), proposalId: null, notified: [] });
  await writeFile(file, JSON.stringify({ version: 1, requests: [record("o"), record("p")] }), { mode: 0o600 });
  const requests = await createRequests(file);
  await requests.settle(record("o"), ID);
  assert.equal(requests.of("p", "portfolio")[0]!.proposalId, null);
  await requests.drop(record("o"));
  assert.deepEqual(requests.of("p", "portfolio"), [record("p")]);
});

test("adds made together are all kept", async () => {
  const file = await scratch(), requests = await createRequests(file);
  await Promise.all(Array.from({ length: 10 }, (_, i) => requests.add("o", `agent-${i}`, BODY)));
  const reloaded = await createRequests(file);
  for (let i = 0; i < 10; i++) assert.equal(reloaded.of("o", `agent-${i}`).length, 1);
});

test("the number of records is bounded: past it, nothing is added and nothing is written", async () => {
  const file = await scratch(), requests = await createRequests(file, { max: 2 });
  await requests.add("o", "a", BODY);
  await requests.add("o", "b", BODY);
  const before = await readFile(file, "utf8");
  assert.equal(await requests.add("o", "c", BODY), null);
  assert.deepEqual(requests.of("o", "c"), []);
  assert.equal(await readFile(file, "utf8"), before);
});

test("a request that can't be written isn't kept: it must not be sent", async () => {
  const file = await scratch(), requests = await createRequests(file);
  await mkdir(file); // The rename over it fails.
  await assert.rejects(requests.add("o", "portfolio", BODY));
  assert.deepEqual(requests.of("o", "portfolio"), []);
});

test("no file yet is no requests; a file that doesn't parse, or others can read, is refused", async () => {
  const file = await scratch();
  assert.deepEqual((await createRequests(file)).of("o", "portfolio"), []);
  await writeFile(file, "{ torn", { mode: 0o600 });
  await assert.rejects(createRequests(file), /doesn't hold watch's stored requests/);
  await writeFile(file, JSON.stringify({ version: 1, requests: [] }));
  await chmod(file, 0o644);
  await assert.rejects(createRequests(file), /0600/);
});

test("a file written before notices were kept still loads: its requests have sent none", async () => {
  const file = await scratch();
  const old = { organization: "alice--near", agent: "portfolio", requestId: "portfolio_1", body: JSON.stringify(BODY), proposalId: ID };
  await writeFile(file, JSON.stringify({ version: 1, requests: [old] }), { mode: 0o600 });
  assert.deepEqual((await createRequests(file)).of("alice--near", "portfolio"), [{ ...old, notified: [] }]);
});

test("a notice is recorded on its request before it is sent, once, and a restart still has it", async () => {
  const file = await scratch(), requests = await createRequests(file);
  const added = (await requests.add("alice--near", "portfolio", BODY))!;
  await requests.settle(added, ID);
  const request = requests.of("alice--near", "portfolio")[0]!;
  await requests.mark(request, "expiring");
  await requests.mark(request, "expiring");
  await requests.mark(request, "approved_not_executed");
  assert.deepEqual((await createRequests(file)).of("alice--near", "portfolio")[0]!.notified, ["expiring", "approved_not_executed"]);
  await requests.mark({ ...request, requestId: "another_1" }, "expired");
  assert.deepEqual(requests.of("alice--near", "portfolio")[0]!.notified, ["expiring", "approved_not_executed"], "another request's is not touched");
});

test("a request file naming a notice that doesn't exist is refused", async () => {
  const file = await scratch();
  const bad = { organization: "alice--near", agent: "portfolio", requestId: "portfolio_1", body: "{}", proposalId: null, notified: ["proposed"] };
  await writeFile(file, JSON.stringify({ version: 1, requests: [bad] }), { mode: 0o600 });
  await assert.rejects(createRequests(file), /doesn't hold watch's stored requests/);
});

test("holds: one record per held agent, replaced when the reason changes, removed when it ends, and kept across a restart", async () => {
  const file = join(tempDir("treasury-holds-"), "requests.json.holds"), holds = await createHolds(file);
  assert.equal(holds.get("alice--near", "portfolio"), null);
  await holds.set("alice--near", "portfolio", "autopilot-on");
  await holds.set("alice--near", "other", "consent-ended");
  await holds.set("alice--near", "portfolio", "unresolved-operations");
  const reloaded = await createHolds(file);
  assert.equal(reloaded.get("alice--near", "portfolio"), "unresolved-operations");
  assert.equal(reloaded.get("alice--near", "other"), "consent-ended");
  assert.equal(JSON.parse(await readFile(file, "utf8")).holds.length, 2, "one record per agent");
  await reloaded.set("alice--near", "portfolio", null);
  assert.equal((await createHolds(file)).get("alice--near", "portfolio"), null);
  assert.equal((await createHolds(file)).get("alice--near", "other"), "consent-ended");
});

test("a holds file others can read, or one that isn't holds, is refused", async () => {
  const dir = tempDir("treasury-holds-"), file = join(dir, "holds.json");
  await writeFile(file, JSON.stringify({ version: 1, holds: [{ organization: "o", agent: "a", reason: "bored" }] }), { mode: 0o600 });
  await assert.rejects(createHolds(file), /doesn't hold watch's stored holds/);
  await writeFile(file, JSON.stringify({ version: 1, holds: [] }));
  await chmod(file, 0o644);
  await assert.rejects(createHolds(file), /readable by others/);
});

test("memory holds behave the same, without a file", async () => {
  const holds = memoryHolds();
  assert.equal(holds.get("o", "a"), null);
  await holds.set("o", "a", "autopilot-on");
  assert.equal(holds.get("o", "a"), "autopilot-on");
  await holds.set("o", "a", null);
  assert.equal(holds.get("o", "a"), null);
});
