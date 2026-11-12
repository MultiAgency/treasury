import { test } from "node:test";
import assert from "node:assert/strict";
import { proposalText } from "@multiagency/sdk";
import { legText } from "../src/terms.ts";
import { proposal, USDC } from "./server-fixtures.ts";

const WNEAR = "nep141:wrap.near", ETH = "nep141:eth.omft.near";

test("each swap reads exactly as the owner signs it: the signed line without its raw amounts, never rounded", () => {
  const view = proposal({ legs: [
    { from: USDC, to: WNEAR, amount: "5000000", minAmountOut: "499996000000000000000000" },
    { from: WNEAR, to: ETH, amount: "1234567890123456789012345", minAmountOut: "1" },
    { from: ETH, to: USDC, amount: "1000000000000000000", minAmountOut: "2999999999" },
  ] });
  const signed = proposalText(view, "approve").split("\n").filter(line => /^\d+\. Swap /.test(line));
  assert.equal(signed.length, 3);
  for (const [i, leg] of view.legs.entries())
    assert.equal(legText(leg), signed[i]!.replace(/^\d+\. /, "").replaceAll(/ \(\d+\)/g, ""), `leg ${i + 1}`);
  assert.deepEqual(view.legs.map(legText), [
    "Swap 5 USDC for at least 0.499996 wNEAR",
    "Swap 1.234567890123456789012345 wNEAR for at least 0.000000000000000001 ETH",
    "Swap 1 ETH for at least 2999.999999 USDC",
  ], "a floor rounded up would overstate what the owner is guaranteed");
});
