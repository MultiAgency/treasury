import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { ProposalView } from "@multiagency/sdk";
import { createRequests } from "../../apps/server/src/requests.ts";
import { createWatch } from "../../apps/server/src/watch.ts";
import { tempDir } from "../../scripts/temp-dirs.ts";
import { AGENT_PAGES, agentAddress, isProposalId, isRunId, NAVIGATION, place, proposalAddress, ROOT_TITLE, DAO_TITLE, runAddress } from "../src/proposals/pages.ts";

const ID = "0123456789abcdef0123456789abcdef";

test("every address in the table names its page", () => {
  assert.deepEqual(place("/"), { kind: "root", title: "Your treasuries" });
  assert.deepEqual(place("/setup/dao/council.sputnik-dao.near"), { kind: "dao", title: "A DAO's Treasury", dao: "council.sputnik-dao.near" });
  assert.deepEqual(place("/agents/portfolio/"), { kind: "agent", title: "Home", agent: "portfolio", page: "home" });
  assert.deepEqual(place("/agents/portfolio"), { kind: "agent", title: "Home", agent: "portfolio", page: "home" }, "with or without the trailing slash");
  assert.deepEqual(place("/agents/portfolio/proposals"), { kind: "agent", title: "Proposals", agent: "portfolio", page: "proposals" });
  assert.deepEqual(place(`/agents/portfolio/proposals/${ID}`), { kind: "proposal", title: "Proposal", agent: "portfolio", id: ID });
  assert.deepEqual(place("/agents/portfolio/strategy"), { kind: "agent", title: "Strategy", agent: "portfolio", page: "strategy" });
  assert.deepEqual(place("/agents/portfolio/funding/"), { kind: "agent", title: "Funding", agent: "portfolio", page: "funding" });
  assert.deepEqual(place("/agents/portfolio/policy"), { kind: "agent", title: "Policy", agent: "portfolio", page: "policy" });
  assert.deepEqual(place("/agents/portfolio/activity"), { kind: "agent", title: "Activity", agent: "portfolio", page: "activity" });
  assert.deepEqual(place("/agents/portfolio/activity/runs/tick-1"), { kind: "run", title: "Run", agent: "portfolio", id: "tick-1" });
});

test("the addresses the table builds are read back as the same page", () => {
  for (const page of Object.keys(AGENT_PAGES) as (keyof typeof AGENT_PAGES)[]) {
    const read = place(agentAddress("portfolio", page));
    assert.equal(read.kind, "agent");
    assert.equal(read.kind === "agent" && read.page, page);
    assert.equal(read.title, AGENT_PAGES[page].title);
  }
  assert.deepEqual(place(proposalAddress("portfolio", ID)), { kind: "proposal", title: "Proposal", agent: "portfolio", id: ID });
});

test("the link a watch notice sends opens the proposal: taken from what watch itself sends, not rebuilt here", async () => {
  const ORG = "owner--near", AGENT = "portfolio", NOW = Date.parse("2026-11-05T12:00:00.000Z");
  const row = (asset: string, usd: number) => ({ asset, symbol: asset, decimals: 6, public: 0n, confidential: 0n, price: 1, priceUpdatedAt: null, priceExpiresAt: null, usd });
  const view = { id: ID, requestId: "r", state: "proposed", createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 86_400_000).toISOString(), approvedAt: null } as unknown as ProposalView;
  const platform = {
    overview: async () => ({ ok: true, value: { agentId: "id", book: [row("usdc", 80), row("wnear", 20)], unmanaged: [], target: { usdc: 0.5, wnear: 0.5 }, rebalance: { minLegUsd: 1, maxCostBps: 50 }, notInForce: null } }),
    unresolved: async () => ({ ok: true, value: [] }),
    autopilot: async () => ({ ok: true, value: { on: false } }),
    create: async () => ({ ok: true, value: view }),
    get: async () => ({ ok: true, value: view }),
  } as never;
  const requests = await createRequests(join(tempDir("treasury-pages-"), "requests.json"));
  const watch = createWatch({ platform, requests, publicOrigin: "https://treasury.test", now: () => NOW });
  const sent: { page: string }[] = [];
  const event = await watch.tick({ organization: ORG, agent: AGENT, driftPoints: 5, intervalS: 300, proposalHours: 24,
    notify: async payload => { sent.push(payload as { page: string }); return { ok: true as const }; } });
  assert.equal(event.proposed, ID, JSON.stringify(event));
  assert.equal(sent.length, 1);
  const link = new URL(sent[0]!.page);
  assert.equal(link.origin, "https://treasury.test");
  assert.deepEqual(place(link.pathname), { kind: "proposal", title: "Proposal", agent: AGENT, id: ID }, "the page it opens");
  assert.equal(link.pathname, proposalAddress(AGENT, ID), "and the address this build builds for it");
});

test("the root and a DAO's setup take their headings from the table", () => {
  assert.equal(place("/").title, ROOT_TITLE);
  assert.equal(place("/setup/dao/council.sputnik-dao.near").title, DAO_TITLE);
});

test("a malformed escape names nothing, whichever part of the address holds it", () => {
  for (const address of ["/agents/portfolio/proposals/%E0%A4%A", "/setup/dao/%E0%A4%A", "/agents/%E0%A4%A"]) {
    const read = place(address);
    assert.equal(read.kind, "missing", address);
    assert.equal(read.title, "Page not found", address);
  }
  assert.deepEqual(place("/agents/portfolio/proposals/%30123456789abcdef0123456789abcdef"), { kind: "proposal", title: "Proposal", agent: "portfolio", id: ID }, "a well-formed escape is read");
});

test("an address that names nothing is named as such, never mistaken for a page", () => {
  for (const address of ["/nothing", "/agents", "/agents/", "/agents/Bad_Name", `/agents/${"a".repeat(33)}`, "/agents/portfolio/nope", "/agents/portfolio/proposals/a/b",
    "/agents/portfolio/strategy/extra", "/setup", "/setup/dao", "/setup/dao/not a dao", "/setup/dao/%E0%A4%A", "/setup/dao/a.near/extra"]) {
    const read = place(address);
    assert.equal(read.kind, "missing", address);
    assert.equal(read.title, "Page not found", address);
    assert.ok(read.kind === "missing" && read.why.length > 10, address);
  }
  assert.match((place("/agents/Bad_Name") as { why: string }).why, /name an agent/);
  assert.match((place("/setup/dao/not a dao") as { why: string }).why, /DAO account/);
});

test("a bad proposal ID is still the proposal page, for the page to show as such", () => {
  const read = place("/agents/portfolio/proposals/not-an-id");
  assert.deepEqual(read, { kind: "proposal", title: "Proposal", agent: "portfolio", id: "not-an-id" });
  assert.equal(isProposalId("not-an-id"), false);
  assert.equal(isProposalId(ID), true);
  assert.equal(isProposalId(ID.toUpperCase()), false);
  assert.equal(isProposalId(`${ID}0`), false);
});

test("the navigation lists the pages that exist, once each, home first", () => {
  assert.deepEqual([...NAVIGATION], ["home", "proposals", "strategy", "funding", "policy", "activity"]);
  assert.equal(new Set(NAVIGATION).size, NAVIGATION.length);
  for (const page of NAVIGATION) assert.ok(page in AGENT_PAGES);
});

test("a run's address is read back, and a run ID is what the server takes in a path", () => {
  assert.deepEqual(place(runAddress("portfolio", "2026-11-06T10:00:00.000Z-1")), { kind: "run", title: "Run", agent: "portfolio", id: "2026-11-06T10:00:00.000Z-1" });
  assert.deepEqual(place(runAddress("portfolio", "a b")), { kind: "run", title: "Run", agent: "portfolio", id: "a b" }, "escaped in the address, read back as given");
  assert.equal(isRunId("tick-1_a.b:c"), true);
  for (const bad of ["", "a b", "a/b", "x".repeat(129), "é"]) assert.equal(isRunId(bad), false, JSON.stringify(bad));
  for (const address of ["/agents/portfolio/activity/runs", "/agents/portfolio/activity/runs/a/b", "/agents/portfolio/activity/other/a", "/agents/portfolio/activity/runs/%E0%A4%A"])
    assert.equal(place(address).kind, "missing", address);
});
