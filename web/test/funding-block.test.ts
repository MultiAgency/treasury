// After a wallet error, a funding transfer may have gone out. The block on sending again outlives the component that
// set it (an error read unmounts it, as does the confidential setting), for as long as the page is loaded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockFunding, fundingBlock, subscribeFunding } from "../src/proposals/funding-block.ts";

test("a block is kept per agent, read the same by any later reader, and announced", () => {
  const heard: number[] = [];
  const stop = subscribeFunding(() => heard.push(1));
  assert.equal(fundingBlock("portfolio"), undefined);
  blockFunding("portfolio", "The transfer may have been sent: check treasury.near and this agent's balances before sending again.");
  stop();
  // A fresh reader (a remounted Fund) sees it; another agent doesn't.
  assert.match(fundingBlock("portfolio")!, /may have been sent/);
  assert.equal(fundingBlock("other"), undefined);
  assert.equal(heard.length, 1);
  // A second block for the same agent keeps the first reason.
  blockFunding("portfolio", "later");
  assert.match(fundingBlock("portfolio")!, /may have been sent/);
});
