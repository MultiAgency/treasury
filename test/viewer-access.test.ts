import assert from "node:assert/strict";
import { test } from "node:test";
import { viewerOf, type GatewayViewer } from "../web/src/app/viewer.js";

const account: GatewayViewer = { account: "alice.near", access: {
  treasury: { canSign: false, canPropose: true, canVote: true, canExecute: true, canManage: true },
  payables: { canSign: false, canPropose: false, canVote: false, canExecute: false, canManage: false },
} };

test("workspace identity never inherits authority from one of its agents", () => {
  const workspace = viewerOf(account, null);
  assert.equal(workspace.account, account.account);
  assert.equal(workspace.access, null);
});

test("selected-agent access cannot borrow another agent's permissions", () => {
  assert.deepEqual(viewerOf(account, "payables"), { account: account.account, access: account.access.payables });
  const missing = viewerOf(account, "unknown");
  assert.equal(missing.access, null);
});
