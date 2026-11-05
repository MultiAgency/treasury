import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSETS, PROPOSAL_TOKENS } from "@multiagency/sdk";
import { PROPOSAL_ASSETS } from "../../../packages/core/src/legs.ts";

test("core's proposal assets are the SDK's, symbol for symbol: legsFor refuses anything else", () => {
  assert.deepEqual(PROPOSAL_ASSETS, ASSETS);
  assert.deepEqual(Object.values(PROPOSAL_ASSETS).sort(), Object.keys(PROPOSAL_TOKENS).sort());
});
