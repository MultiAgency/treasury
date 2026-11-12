import { test } from "node:test";
import assert from "node:assert/strict";
import { askWhy, onAskWhy, proposalQuestion, RISK_QUESTION } from "../src/ask-why.ts";

test("an ask reaches the panel that is listening, with the agent it is for, and stops after it unsubscribes", () => {
  const heard: [string, string][] = [];
  const stop = onAskWhy((agent, question) => heard.push([agent, question]));
  askWhy("ballast", "Why?");
  stop();
  askWhy("ballast", "Again?");
  assert.deepEqual(heard, [["ballast", "Why?"]]);
});

test("with no assistant mounted, asking does nothing", () => {
  assert.doesNotThrow(() => askWhy("ballast", "Why?"));
});

test("the proposal's question names its ID, and the risk question needs none", () => {
  const id = "a".repeat(32);
  assert.match(proposalQuestion(id), new RegExp(id));
  assert.match(RISK_QUESTION, /risk level/);
});
