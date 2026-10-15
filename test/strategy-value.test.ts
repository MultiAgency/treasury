import assert from "node:assert/strict";
import { test } from "node:test";
import { withinRunCeiling } from "../src/strategy-value.js";

test("decimal addition rejects an excess that binary addition rounds down to the ceiling", () => {
  assert.equal(0.9 + 0.10000000000000005, 1);
  assert.equal(withinRunCeiling([0.9, 0.10000000000000005], 1), false);
  assert.equal(9 + 1.0000000000000004, 10);
  assert.equal(withinRunCeiling([9, 1.0000000000000004], 10), false);
});

test("decimal equality and values below the ceiling are accepted without an epsilon", () => {
  assert.equal(withinRunCeiling([0.1, 0.2], 0.3), true);
  assert.equal(withinRunCeiling([0.2, 0.1], 0.3), true);
  assert.equal(withinRunCeiling([0.875, 0.125], 1), true);
  assert.equal(withinRunCeiling([0.8750000000000002, 0.125], 1), false);
  assert.equal(withinRunCeiling([0.1, 0.19999999999999998], 0.3), true);
  assert.equal(withinRunCeiling([25, 25], 50), true);
  assert.equal(withinRunCeiling([25, 25.000000000000004], 50), false);
});

test("scientific notation and different decimal scales retain their exact recorded values", () => {
  assert.equal(withinRunCeiling([1e-7, 2e-7], 3e-7), true);
  assert.equal(withinRunCeiling([1e-7, 2.0000000000000002e-7], 3e-7), false);
  assert.equal(withinRunCeiling([1e21, 2e21], 3e21), true);
  assert.equal(withinRunCeiling([1e21, 1e-7], 1e21), false);
  assert.equal(withinRunCeiling([Number.MIN_VALUE, Number.MIN_VALUE], 1e-323), true);
  assert.equal(withinRunCeiling([Number.MIN_VALUE], 0), false);
});

test("finite values whose numeric sum would overflow still produce a comparison", () => {
  assert.equal(Number.MAX_VALUE + Number.MAX_VALUE, Infinity);
  assert.equal(withinRunCeiling([Number.MAX_VALUE], Number.MAX_VALUE), true);
  assert.equal(withinRunCeiling([Number.MAX_VALUE, Number.MAX_VALUE], Number.MAX_VALUE), false);
  assert.equal(withinRunCeiling([Number.MAX_VALUE, Number.MIN_VALUE], Number.MAX_VALUE), false);
});

test("missing, invalid and overflow-valued evidence never becomes zero or a known refusal", () => {
  for (const value of [null, undefined, NaN, Infinity, -Infinity, -1, -Number.MIN_VALUE]) {
    assert.equal(withinRunCeiling([value], 1), null);
    assert.equal(withinRunCeiling([2, value], 1), null, "validate every observation before comparing");
  }
  for (const maximum of [NaN, Infinity, -Infinity, -1])
    assert.equal(withinRunCeiling([0], maximum), null);
});

test("sparse histories and malformed values remain unavailable instead of being coerced", () => {
  assert.equal(withinRunCeiling(new Array<number>(1), 1), null);
  for (const value of ["0", {}, false]) {
    assert.equal(withinRunCeiling([2, value as never], 1), null);
    assert.equal(withinRunCeiling([0], value as never), null);
  }
});

test("an empty history and zero estimates work at a zero ceiling", () => {
  assert.equal(withinRunCeiling([], 0), true);
  assert.equal(withinRunCeiling([0, -0], -0), true);
  assert.equal(withinRunCeiling([0, 1], 0), false);
});
