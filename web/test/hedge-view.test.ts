import { test } from "node:test";
import assert from "node:assert/strict";
import { hedgeRead } from "../../apps/server/src/contract.ts";
import { BLOCK_LABEL, intentsLine, moveRows, planNote, priceText, registryRows } from "../src/hedge-view.ts";
import type { HedgeRead } from "../src/server-api.ts";

const row = (symbol: string, change: Partial<HedgeRead["registry"][number]> = {}): HedgeRead["registry"][number] =>
  ({ symbol, id: `nep141:${symbol}`, class: "volatile", chain: "eth", route: "omft", venues: ["near-intents", "omft-ethereum"], proposable: false, listed: true, priceUsd: 4018.56, heldUsd: 0, drift: [], ...change });
const read = (change: Partial<HedgeRead> = {}): HedgeRead => ({
  at: 1, intents: { source: "live", status: "ok", fetchedAt: Date.parse("2026-11-10T21:46:30Z"), detail: null, rejected: 0 },
  registry: [row("XAUT", { class: "rwa" }), row("USDC", { class: "stable", chain: "near", route: "native", proposable: true, priceUsd: 0.999547, heldUsd: 80_000, venues: ["near-intents"] })],
  configured: true, level: 0,
  plan: { notes: ["omft-ethereum: no cap is set"], moves: [
    { id: "rebalance:USDC>XAUT", kind: "rebalance", shape: "stable-to-risk", from: "USDC", to: "XAUT", sizeUsd: 5_000, reason: "XAUT is under its target",
      status: "blocked", blocked: [{ code: "not_listed", reason: "XAUT isn't among the platform's proposal assets" }], quote: { costBps: 31.4, ageMs: 2_400 }, canPropose: false },
    { id: "rebalance:USDC>ETH", kind: "rebalance", shape: "stable-to-risk", from: "USDC", to: "ETH", sizeUsd: 10_000, reason: "ETH is under its target",
      status: "executable", blocked: [], quote: { costBps: 30, ageMs: 0 }, canPropose: true },
  ] },
  problems: [], ...change,
});

test("the server's own read parses as the page's fixture does: the page and the contract can't drift apart", () => {
  assert.ok(hedgeRead.safeParse(read()).success);
  assert.ok(hedgeRead.safeParse({ ...read(), plan: null, problems: ["no hedge block"] }).success);
  assert.equal(hedgeRead.safeParse({ ...read(), extra: 1 }).success, false);
});

test("where the prices came from is said in words, with a tone: live, simulated, late, unreachable and not connected are each their own", () => {
  assert.deepEqual([intentsLine(read()).badge, intentsLine(read()).tone], ["Live", "success"]);
  assert.match(intentsLine(read()).text, /read from NEAR Intents' public API\. Read 21:46:30 UTC/);
  const stub = intentsLine(read({ intents: { ...read().intents, source: "stub" } }));
  assert.deepEqual([stub.badge, stub.tone], ["Simulated", "info"]);
  assert.match(stub.text, /simulated by this server, not read from NEAR Intents/);
  assert.deepEqual(intentsLine(read({ intents: { source: "live", status: "stale", fetchedAt: 1, detail: "NEAR Intents couldn't be reached: this is the last list it gave", rejected: 0 } })).badge, "Stale");
  const down = intentsLine(read({ intents: { source: "live", status: "unavailable", fetchedAt: null, detail: "NEAR Intents didn't answer in time", rejected: 0 } }));
  assert.deepEqual([down.badge, down.tone], ["Unavailable", "destructive"]);
  assert.match(down.text, /No move can be priced until it can/);
  assert.equal(intentsLine(read({ intents: { source: "off", status: "off", fetchedAt: null, detail: null, rejected: 0 } })).badge, "Not connected");
});

test("the registry rows show the live price, what is held, and whether the list and the platform carry it; an unread list is 'Not read', never 'Not on the list'", () => {
  const [gold, usdc] = registryRows(read());
  assert.deepEqual([gold!.priceText, gold!.heldText, gold!.listText, gold!.platformText, gold!.classText], ["$4,018.56", "—", "On the list", "Not listed", "Real-world asset"]);
  assert.deepEqual([usdc!.priceText, usdc!.heldText, usdc!.platformText, usdc!.routeText], ["$0.9995", "$80,000", "Tradable", "native to NEAR"]);
  const unread = registryRows(read({ registry: [row("XAUT", { listed: null, priceUsd: null })] }))[0]!;
  assert.deepEqual([unread.listText, unread.priceText], ["Not read", "—"]);
  assert.equal(registryRows(read({ registry: [row("XAUT", { listed: false })] }))[0]!.listText, "Not on the list");
  const drifted = registryRows(read({ registry: [row("ETH", { drift: [{ kind: "decimals", detail: "the registry has 18 decimals, the list 8" }] })] }))[0]!;
  assert.deepEqual(drifted.driftText, ["decimals: the registry has 18 decimals, the list 8"]);
  assert.equal(priceText(null), "—");
  assert.equal(priceText(3.57), "$3.57");
});

test("each move reads as what moves where, how much, what the quote costs, and every blocker with its words; only an executable one can be proposed", () => {
  const [gold, eth] = moveRows(read());
  assert.deepEqual([gold!.title, gold!.kindText, gold!.sizeText, gold!.statusText, gold!.canPropose, gold!.quoteText], ["USDC → XAUT", "Top up", "$5,000", "Blocked", false, "31.4 bps, 2 s old"]);
  assert.deepEqual(gold!.blockers, [{ label: "Not on the platform's list", reason: "XAUT isn't among the platform's proposal assets" }]);
  assert.deepEqual([eth!.statusText, eth!.canPropose, eth!.blockers], ["Executable", true, []]);
  const none = moveRows(read({ plan: { notes: [], moves: [{ ...read().plan!.moves[0]!, quote: null, blocked: [{ code: "no_quote", reason: "none" }] }] } }))[0]!;
  assert.equal(none.quoteText, "No quote");
  for (const label of Object.values(BLOCK_LABEL)) assert.ok(label.length > 3);
});

test("with no plan the page says why in the server's words, and with an empty plan that nothing is due", () => {
  assert.equal(planNote(read({ plan: null, problems: ["this agent's watch config has no hedge block"] })), "this agent's watch config has no hedge block");
  assert.match(planNote(read({ plan: { moves: [], notes: [] } })), /Nothing to do/);
  assert.equal(planNote(read()), "");
  assert.equal(moveRows(read({ plan: null })).length, 0);
});
