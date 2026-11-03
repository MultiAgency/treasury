import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, InvalidConfigError, isNum, isPct, isPositiveInt, report } from "../src/validate.ts";

test("the primitives", () => {
  assert.deepEqual([isNum(1), isNum(Number.NaN), isNum(Number.POSITIVE_INFINITY), isNum("1")], [true, false, false, false]);
  assert.deepEqual([isPct(100), isPct(0), isPct(100.1), isPct(Number.NaN)], [true, false, false, false]);
  assert.deepEqual([isPositiveInt(1), isPositiveInt(0), isPositiveInt(1.5), isPositiveInt(Number.NaN)], [true, false, false, false]);
  const r = report(); r.need(true, "fine"); r.need(false, "broken");
  assert.deepEqual(r.problems, ["broken"]);
});

test("assertValid throws a named error listing every problem, and passes when there are none", () => {
  assertValid("x", []);
  assert.throws(() => assertValid("oracle", ["a", "b"]), (e: unknown) => e instanceof InvalidConfigError && e.problems.length === 2 && /oracle/.test(e.message));
});
