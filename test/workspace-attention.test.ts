import assert from "node:assert/strict";
import { test } from "node:test";

// The compatibility client reads location when imported; these projections make no requests.
Object.defineProperty(globalThis, "location", { value: { pathname: "/" }, configurable: true });
const { attentionOf, attentionHref } = await import(new URL("../web/src/features/workspace/attention.ts", import.meta.url).href);
Reflect.deleteProperty(globalThis, "location");

const now = Date.now();
const at = new Date(now - 60_000).toISOString();
const grant = (days: number) => ({ id: "grant", label: "payout", expiresAt: new Date(now + days * 86_400_000).toISOString() });
const held = [{ at, correlationId: "held-payment", approvalId: "approval", request: { recipient: "payee.near" } }];
const overview = { area: "facilitator", notInForce: null, book: [], policy: { policy: { actions: ["transfer"], frozen: false } } };
const actions = (items: { action: string }[]) => items.map(item => item.action);

test("approve-only attention leads with held payout review instead of send-grant issuance or renewal", () => {
  for (const sendGrant of [null, grant(1), grant(-1)]) {
    const items = attentionOf({ setup: { executor: false, grant: sendGrant }, overview, held });
    assert.deepEqual(actions(items), ["Review payment"]);
    assert.equal(items[0].payment, "held-payment");
    assert.equal(attentionHref(items[0], "/a/payables"), "/a/payables/follow/payment?payment=held-payment");
    assert.match(items[0].text, /held for the owner's approval/);
  }
});

test("approve-only attention retains unresolved operations and policy problems before held payout review", () => {
  for (const policy of [
    { ...overview, policy: { policy: { ...overview.policy.policy, frozen: true } } },
    { ...overview, notInForce: "Policy is not applied" },
  ]) {
    const items = attentionOf({ setup: { executor: false, grant: null }, overview: policy, held, unresolved: [{ at }] });
    assert.deepEqual(actions(items), ["Check status", "Review", "Review payment"]);
    assert.equal(items[0].to, "/activity");
    assert.match(items[0].text, /no proven outcome/);
    assert.equal(items[1].to, "/policy");
    assert.equal(items[1].tone, "destructive");
    assert.equal(items[2].payment, "held-payment");
  }
});

test("executors and unknown executor roles retain missing and expiring grant tasks in their own area", () => {
  for (const executor of [true, undefined]) {
    for (const area of ["facilitator", "treasury"]) {
      for (const sendGrant of [null, grant(1), grant(-1)]) {
        const setup = { ...(executor === undefined ? {} : { executor }), grant: sendGrant };
        const items = attentionOf({ setup, overview: { ...overview, area }, held });
        assert.deepEqual(actions(items), [sendGrant ? "Renew" : "Issue", "Review payment"]);
        assert.equal(attentionHref(items[0]), area === "treasury" ? "/automations" : "/policy#grants");
      }
    }
  }
});

test("missing setup does not invent grant tasks and grants outside the renewal window stay quiet", () => {
  assert.deepEqual(actions(attentionOf({ overview, held })), ["Review payment"]);
  for (const executor of [true, false, undefined]) {
    assert.deepEqual(actions(attentionOf({ setup: { executor, grant: grant(30) }, overview, held })), ["Review payment"]);
  }
});
