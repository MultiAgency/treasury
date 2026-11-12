import { test } from "node:test";
import assert from "node:assert/strict";
import { fundedStatus, isFunded, showsFundingAccount } from "../src/standing-view.ts";

const held = (publicAmount: string, confidential: string, usd: number | null = null) => ({ public: publicAmount, confidential, usd });

test("the agent is funded when it holds any managed asset, publicly or confidentially", () => {
  assert.equal(isFunded([]), false);
  assert.equal(isFunded([held("0", "0")]), false);
  assert.equal(isFunded([held("0", "0"), held("5", "0")]), true);
  assert.equal(isFunded([held("0", "1")]), true);
});

test("the funded detail gives a dollar total only when every holding is priced", () => {
  assert.deepEqual(fundedStatus([held("0", "0")]), { funded: false, detail: "The agent holds nothing yet. Fund it to let the strategy run." });
  assert.deepEqual(fundedStatus([held("1", "0", 10), held("0", "2", 5.5)]), { funded: true, detail: "Holds about $15.50" });
  assert.deepEqual(fundedStatus([held("1", "0", 10), held("1", "0", null)]), { funded: true, detail: "Holds managed assets" });
});

test("only a wallet owner has a funding account cell: a DAO's is the DAO", () => {
  assert.equal(showsFundingAccount("wallet"), true);
  assert.equal(showsFundingAccount("dao"), false);
});
