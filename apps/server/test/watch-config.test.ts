import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadWatchConfig, readsPerHour } from "../src/watch-config.ts";
import { WATCH } from "../src/watch.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

async function file(content: unknown, mode = 0o600) {
  const dir = tempDir("treasury-watch-config-");
  const path = join(dir, "watch.json");
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content), { mode });
  await chmod(path, mode);
  return path;
}

test("each agent's settings, with the defaults where it names none", async () => {
  const agents = await loadWatchConfig(await file({ agents: [
    { organization: "alice--near", agent: "portfolio" },
    { organization: "bob--near", agent: "savings", driftPoints: 2.5, intervalS: 600, proposalHours: 72, notify: ["notify-send", "Treasury"] },
  ] }));
  assert.deepEqual(agents.map(({ notify, ...rest }) => ({ ...rest, notifies: notify !== undefined })), [
    { organization: "alice--near", agent: "portfolio", driftPoints: WATCH.driftPoints, intervalS: WATCH.intervalS, proposalHours: WATCH.proposalHours, notifies: false },
    { organization: "bob--near", agent: "savings", driftPoints: 2.5, intervalS: 600, proposalHours: 72, notifies: true },
  ]);
});

test("a setting out of range, an unknown key, or the same agent twice is refused, naming it", async () => {
  const one = (agent: Record<string, unknown>) => file({ agents: [{ organization: "alice--near", agent: "portfolio", ...agent }] });
  for (const [bad, pattern] of [
    [{ intervalS: WATCH.minIntervalS - 1 }, /intervalS/],
    [{ intervalS: 300.5 }, /intervalS/],
    [{ driftPoints: 0 }, /driftPoints/],
    [{ driftPoints: 101 }, /driftPoints/],
    [{ proposalHours: 0 }, /proposalHours/],
    [{ proposalHours: 169 }, /proposalHours/], // The platform allows at most 7 days.
    [{ notify: [] }, /notify/],
    [{ notify: "notify-send Treasury" }, /notify/], // A command and its arguments, never a line for a shell.
    [{ agent: "Portfolio" }, /agent/],
    [{ organization: "" }, /organization/],
    [{ owner: "alice.near" }, /owner/],
  ] as const) await assert.rejects(loadWatchConfig(await one(bad)), pattern, JSON.stringify(bad));
  const twice = { organization: "alice--near", agent: "portfolio" };
  await assert.rejects(loadWatchConfig(await file({ agents: [twice, twice] })), /alice--near\/portfolio.*twice/);
});

test("a file others can read, one that doesn't parse, or none at all is refused", async () => {
  await assert.rejects(loadWatchConfig(await file({ agents: [] }, 0o644)), /0600/);
  await assert.rejects(loadWatchConfig(await file("{ torn")), /watch\.json/);
  await assert.rejects(loadWatchConfig(join(tmpdir(), "treasury-no-such-watch.json")), /ENOENT/);
});

test("the agents' reads are budgeted: past half the platform's hourly limit, the server won't start", async () => {
  const agents = (count: number, intervalS: number) => ({ agents: Array.from({ length: count }, (_, i) => ({ organization: "o", agent: `a${i}`, intervalS })) });
  // 3 reads a tick: every 5 minutes is 36 an hour per agent, so 16 agents are 576 and 17 are 612.
  assert.equal(readsPerHour(await loadWatchConfig(await file(agents(16, 300)))), 576);
  await assert.rejects(loadWatchConfig(await file(agents(17, 300))), /612 calls an hour.*600/);
  assert.equal(readsPerHour(await loadWatchConfig(await file(agents(3, 60)))), 540);
  await assert.rejects(loadWatchConfig(await file(agents(4, 60))), /720 calls an hour/);
});

test("an agent that notifies must tick often enough to land in a proposal's expiring window, or the server won't start", async () => {
  const agent = (change: Record<string, unknown>) => file({ agents: [{ organization: "o", agent: "a", notify: ["true"], ...change }] });
  // A 24-hour proposal is expiring for its last hour: the default 5-minute tick lands in it.
  assert.equal((await loadWatchConfig(await agent({}))).length, 1);
  // A 1-hour proposal is expiring for its last 6 minutes (10% of its life).
  assert.equal((await loadWatchConfig(await agent({ proposalHours: 1, intervalS: 359 }))).length, 1, "just under 360 seconds");
  await assert.rejects(loadWatchConfig(await agent({ proposalHours: 1, intervalS: 360 })), /ticks every 360s.*expiring for its last 360s/);
  await assert.rejects(loadWatchConfig(await agent({ proposalHours: 1, intervalS: 600 })), /o\/a ticks every 600s/);
  await assert.rejects(loadWatchConfig(await agent({ intervalS: 3600 })), /ticks every 3600s.*last 3600s/);
  assert.equal((await loadWatchConfig(await agent({ intervalS: 3599 }))).length, 1);
  // An agent with no notifier sends nothing, so nothing can be missed.
  const quiet = await file({ agents: [{ organization: "o", agent: "a", proposalHours: 1, intervalS: 3600 }] });
  assert.equal((await loadWatchConfig(quiet)).length, 1);
});
