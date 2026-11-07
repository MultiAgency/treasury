import { test } from "node:test";
import assert from "node:assert/strict";
import { failureText } from "../src/proposals/words.ts";

test("a creation the platform refused reads as a refusal, naming the creation already waiting, not as an outage", () => {
  const text = failureText({ ok: false, kind: "refused", code: "creation_refused" }, "setup");
  assert.notEqual(text, failureText({ ok: false, kind: "unavailable" }, "setup"));
  assert.doesNotMatch(text, /creation_refused|didn't answer/);
  assert.match(text, /already waiting/);
});

test("the platform's limit on the app's calls reads the same everywhere, as nothing done and not the account's own limit", () => {
  const contexts = ["setup", "consent", "proposal", "funding", "autopilot"] as const;
  const texts = contexts.map(context => failureText({ ok: false, kind: "refused", code: "platform_rate_limited" }, context));
  assert.equal(new Set(texts).size, 1);
  assert.match(texts[0]!, /Nothing was done/);
  assert.doesNotMatch(texts[0]!, /platform_rate_limited|this account|tomorrow/);
});
