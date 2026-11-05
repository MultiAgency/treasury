import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_PAGES, agentAddress, isProposalId, NAVIGATION, place, proposalAddress } from "../src/proposals/pages.ts";

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

test("the link a watch notice sends opens the proposal", () => {
  assert.equal(proposalAddress("portfolio", ID), `/agents/portfolio/proposals/${ID}`);
  assert.equal(place(proposalAddress("portfolio", ID)).kind, "proposal");
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
  assert.deepEqual([...NAVIGATION], ["home", "proposals", "strategy", "funding"]);
  assert.equal(new Set(NAVIGATION).size, NAVIGATION.length);
  for (const page of NAVIGATION) assert.ok(page in AGENT_PAGES);
});
