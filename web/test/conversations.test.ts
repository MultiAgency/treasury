import { test } from "node:test";
import assert from "node:assert/strict";
import { busyKeys, clearConversations, conversationKey, conversations, subscribe, version } from "../src/proposals/conversations.ts";

test("signing in or out clears every conversation, so the next account in this tab never sees the last one's questions or drafts", () => {
  const key = conversationKey("portfolio", "stabilization");
  conversations.set(key, [{ role: "user", text: "What's our runway?" }]);
  busyKeys.add(key);
  let heard = 0;
  const unsubscribe = subscribe(() => { heard++; });
  const before = version();
  clearConversations();
  unsubscribe();
  assert.equal(conversations.size, 0);
  assert.equal(busyKeys.size, 0);
  assert.equal(heard, 1, "an open panel is told, and shows the empty conversation");
  assert.ok(version() > before);
});
