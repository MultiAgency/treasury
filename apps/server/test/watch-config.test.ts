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

test("an interval must be shorter than a proposal's life, with or without a notifier, or the server won't start", async () => {
  const agent = (change: Record<string, unknown>) => file({ agents: [{ organization: "o", agent: "a", ...change }] });
  assert.equal((await loadWatchConfig(await agent({}))).length, 1, "the defaults");
  assert.equal((await loadWatchConfig(await agent({ proposalHours: 1, intervalS: 3599 }))).length, 1, "just under an hour");
  await assert.rejects(loadWatchConfig(await agent({ proposalHours: 1, intervalS: 3600 })), /o\/a ticks every 3600s.*last 1h \(3600s\).*shorter than a proposal's life/);
  await assert.rejects(loadWatchConfig(await agent({ proposalHours: 1, intervalS: 7200, notify: ["true"] })), /ticks every 7200s/);
  await assert.rejects(loadWatchConfig(await agent({ proposalHours: 24, intervalS: 86_400 })), /ticks every 86400s/);
  assert.equal((await loadWatchConfig(await agent({ proposalHours: 24, intervalS: 86_399 }))).length, 1);
});

const BALLAST = { profile: "balanced", monthlySpendUsd: 2_000, operatingCashMonths: 6, destinations: ["ops.near"], approvers: ["owner.near"] };
const WNEAR_SLEEVE = { asset: "wNEAR", targetPct: 20, minPct: 5, maxPct: 25 }, ETH_SLEEVE = { asset: "ETH", targetPct: 20, minPct: 5, maxPct: 25 };
const VENUE_CAPS = { "near-intents": 50, "omft-ethereum": 25 };
const diversified = (diversification: unknown) => file({ agents: [{ organization: "o", agent: "a", ballast: { ...BALLAST, diversification } }] });

test("a diversification block loads when the compiled mandate's terms hold, and the two-asset agent is unchanged without one", async () => {
  const withTerms = await loadWatchConfig(await diversified({ sleeves: [WNEAR_SLEEVE, ETH_SLEEVE], venueCapsPct: VENUE_CAPS }));
  assert.deepEqual(withTerms[0]!.ballast?.diversification?.sleeves, [WNEAR_SLEEVE, ETH_SLEEVE]);
  const without = await loadWatchConfig(await file({ agents: [{ organization: "o", agent: "a", ballast: BALLAST }] }));
  assert.equal(without[0]!.ballast?.diversification, undefined);
});

test("class caps may name only some classes: the watch file doesn't need a cap for a class the book doesn't hold", async () => {
  const loaded = await loadWatchConfig(await diversified({ sleeves: [WNEAR_SLEEVE, ETH_SLEEVE], venueCapsPct: VENUE_CAPS, classCapsPct: { volatile: 50, stable: 100 } }));
  assert.deepEqual(loaded[0]!.ballast?.diversification?.classCapsPct, { volatile: 50, stable: 100 });
});

test("the risk agent and a diversified book load together (ADR 6): the risk agent assesses the book Ballast runs, and still needs Ballast", async () => {
  const both = { organization: "o", agent: "a", risk: {}, ballast: { ...BALLAST, diversification: { sleeves: [WNEAR_SLEEVE, ETH_SLEEVE], venueCapsPct: VENUE_CAPS } } };
  assert.equal((await loadWatchConfig(await file({ agents: [both] }))).length, 1);
  assert.equal((await loadWatchConfig(await file({ agents: [{ organization: "o", agent: "a", risk: {}, ballast: BALLAST }] }))).length, 1, "risk on the two-asset book loads");
  await assert.rejects(loadWatchConfig(await file({ agents: [{ organization: "o", agent: "a", risk: {} }] })), /sets risk without ballast/);
});

test("a sleeve or stablecoin the platform doesn't list is refused at load, naming the platform's proposal assets", async () => {
  await assert.rejects(loadWatchConfig(await diversified({
    sleeves: [WNEAR_SLEEVE, { asset: "BTC", targetPct: 20, minPct: 5, maxPct: 25 }], venueCapsPct: { ...VENUE_CAPS, "omft-bitcoin": 25 },
  })), /sleeve BTC isn't among the platform's proposal assets/);
  await assert.rejects(loadWatchConfig(await diversified({
    sleeves: [WNEAR_SLEEVE, ETH_SLEEVE], venueCapsPct: VENUE_CAPS, stableSplit: { USDC: 50, USDT: 50 },
  })), /USDT isn't among the platform's proposal assets/);
});

test("terms that leave the profile, or a venue path with no cap, are refused before the server starts", async () => {
  await assert.rejects(loadWatchConfig(await diversified({ sleeves: [WNEAR_SLEEVE, ETH_SLEEVE], venueCapsPct: { "near-intents": 50 } })),
    /Ethereum bridge \(omft\) is on a held asset's path and needs a cap/);
  await assert.rejects(loadWatchConfig(await diversified({ sleeves: [WNEAR_SLEEVE, ETH_SLEEVE], venueCapsPct: { ...VENUE_CAPS, "near-intents": 60 } })),
    /can't be over the mandate's venue limit of 50%/);
  await assert.rejects(loadWatchConfig(await diversified({ sleeves: [{ ...WNEAR_SLEEVE, targetPct: 30 }, ETH_SLEEVE], venueCapsPct: VENUE_CAPS })),
    /add to the profile's volatile weight, 40%/);
});

test("a sleeve's own bands are checked by the same rules the engine uses", async () => {
  await assert.rejects(loadWatchConfig(await diversified({
    sleeves: [{ ...WNEAR_SLEEVE, bands: { trim: [20, 15, 45], dca: [-20, -30, -40], buyHalt: -50 } }, ETH_SLEEVE], venueCapsPct: VENUE_CAPS,
  })), /sleeve wNEAR: trim thresholds must be positive and rising/);
  const loaded = await loadWatchConfig(await diversified({
    sleeves: [{ ...WNEAR_SLEEVE, bands: { trim: [20, 30, 45], dca: [-20, -30, -40], buyHalt: -50 } }, ETH_SLEEVE], venueCapsPct: VENUE_CAPS,
  }));
  assert.deepEqual(loaded[0]!.ballast?.diversification?.sleeves[0]?.bands, { trim: [20, 30, 45], dca: [-20, -30, -40], buyHalt: -50 });
});

test("real-world assets need eligibility and KYC, and the block's shape is checked", async () => {
  await assert.rejects(loadWatchConfig(await diversified({
    sleeves: [WNEAR_SLEEVE, ETH_SLEEVE], venueCapsPct: VENUE_CAPS, classes: ["volatile", "stable", "rwa"],
    classCapsPct: { volatile: 50, stable: 100, rwa: 10 }, rwa: { eligible: false, kycVerified: false, maxPct: 10, cashHorizonDays: 30 },
  })), /eligible to hold them/);
  await assert.rejects(loadWatchConfig(await diversified({ sleeves: [] })), /sleeves/);
  await assert.rejects(loadWatchConfig(await diversified({ sleeves: [WNEAR_SLEEVE, ETH_SLEEVE], venueCapsPct: VENUE_CAPS, surprise: true })), /surprise/);
});

test("a hedge block loads with the planner's defaults, and is part of Ballast's settings only: no sleeve, no agent, no run changes", async () => {
  const hedge = { sleeves: [{ asset: "XAUT", targetPct: 5, maxPct: 10 }], classCapsPct: { rwa: 10 }, venueCapsPct: { "omft-ethereum": 20 } };
  const loaded = await loadWatchConfig(await file({ agents: [{ organization: "o", agent: "a", ballast: { ...BALLAST, hedge } }] }));
  assert.deepEqual(loaded[0]!.ballast?.hedge, hedge);
  assert.equal(loaded[0]!.ballast?.diversification, undefined, "the hedge is no diversification: the two-asset step still runs");
});

test("a hedge block that can't be planned is refused at load: an unknown or cash asset, a target over its ceiling, a bad cap or limit, an unknown key", async () => {
  const bad = (hedge: Record<string, unknown>) => file({ agents: [{ organization: "o", agent: "a", ballast: { ...BALLAST, hedge } }] });
  const sleeve = { asset: "XAUT", targetPct: 5, maxPct: 10 };
  for (const [hedge, pattern] of [
    [{ sleeves: [] }, /sleeves/],
    [{ sleeves: [{ ...sleeve, asset: "NOPE" }] }, /NOPE isn't in the asset registry/],
    [{ sleeves: [{ ...sleeve, asset: "USDC" }] }, /USDC isn't a risk asset NEAR Intents carries/],
    [{ sleeves: [{ ...sleeve, asset: "TBILL" }] }, /TBILL isn't a risk asset NEAR Intents carries/],
    [{ sleeves: [{ ...sleeve, targetPct: 11 }] }, /target at most the ceiling/],
    [{ sleeves: [sleeve, sleeve] }, /twice/],
    [{ sleeves: [sleeve], maxCostBps: 0 }, /maxCostBps/],
    [{ sleeves: [sleeve], maxMoveUsd: -1 }, /maxMoveUsd/],
    [{ sleeves: [sleeve], hedgeAtLevel: 4 }, /hedgeAtLevel|Invalid/],
    [{ sleeves: [sleeve], classCapsPct: { rwa: 101 } }, /rwa class cap/],
    [{ sleeves: [sleeve], venueCapsPct: { "no-such-bridge": 10 } }, /unknown venue/],
    [{ sleeves: [sleeve], venueCapsPct: { "omft-ethereum": 0 } }, /cap must be above 0/],
    [{ sleeves: [sleeve], extra: true }, /extra|Unrecognized/],
  ] as const) await assert.rejects(loadWatchConfig(await bad(hedge as never)), pattern, JSON.stringify(hedge));
});
