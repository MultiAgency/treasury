import { test } from "node:test";
import assert from "node:assert/strict";
import { failureText } from "../src/proposals/words.ts";

test("a creation the platform refused reads as a refusal, naming the creation already waiting, not as an outage", () => {
  const text = failureText({ ok: false, kind: "refused", code: "creation_refused" }, "setup");
  assert.notEqual(text, failureText({ ok: false, kind: "unavailable" }, "setup"));
  assert.doesNotMatch(text, /creation_refused|didn't answer/);
  assert.match(text, /already waiting/);
});
