import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mock, test } from "node:test";
import { agreements, declineAgreement, offerTerms, proposeTerms, remoteStore, requestAgreement, termsFor, withinTerms } from "../src/agreements.js";
import { ASSETS } from "../src/policy.js";
import { listInvoices, prepareInvoice } from "../src/invoice-store.js";
import { freshDirectory } from "./fixtures/harness.js";

freshDirectory("agreements");

const none = new Set<string>();
const request = (submission: string, payee = "bob.near", amount = "250000000") =>
  ({ payee, amount, note: "October design work", submission: `4f6b2c1e-9d7a-4c3b-8e2f-${submission.padStart(12, "0")}` });

test("a request from an account not yet agreed is recorded once, and is never a payment", () => {
  const first = requestAgreement(request("1"), none);
  assert.equal(first.status, "requested");
  assert.deepEqual(requestAgreement(request("1"), none), first, "the same submission files once");
  assert.equal(agreements(none).length, 1);
  assert.deepEqual(listInvoices(), [], "no invoice, payment or reservation exists");
  assert.ok(!existsSync(".ops"), "no operation was recorded");
});

test("open requests are bounded per account", () => {
  for (const n of ["1", "2", "3"]) assert.equal(requestAgreement(request(n), none).status, "requested");
  assert.equal(requestAgreement(request("4"), none).status, "busy");
  assert.equal(requestAgreement(request("5", "carol.near"), none).status, "requested", "other accounts aren't held up");
});

test("a request moves from proposed to agreed to filed, or is declined", () => {
  const { id } = requestAgreement(request("1"), none);
  proposeTerms(id, new Date("2026-11-30T00:00:00Z"));
  assert.equal(agreements(none)[0]!.status, "proposed");
  assert.deepEqual(termsFor("bob.near"), { maxAmount: "250000000", until: "2026-11-30T00:00:00.000Z" });
  const agreed = new Set(["bob.near"]);
  assert.equal(agreements(agreed)[0]!.status, "agreed", "agreed once the policy lists the payee");
  prepareInvoice(request("1"), ASSETS.USDC);
  assert.equal(agreements(agreed)[0]!.status, "filed", "the payee filed it: same submission, same invoice");

  const other = requestAgreement(request("2", "carol.near"), none);
  declineAgreement(other.id);
  assert.equal(agreements(none).find((r) => r.id === other.id)!.status, "declined");
  assert.throws(() => proposeTerms(other.id, new Date()), /declined/);
  assert.equal(termsFor("carol.near"), undefined);
});

test("the owner offers terms first (an order or an award); the payee's next invoice files under them", () => {
  const id = offerTerms({ payee: "dana.near", amount: "500000000", note: "Bounty: audit report", until: new Date("2026-11-30T00:00:00Z") });
  const offer = () => agreements(none).find((a) => a.id === id)!;
  assert.equal(offer().origin, "owner");
  assert.equal(offer().status, "proposed");
  assert.deepEqual(termsFor("dana.near"), { maxAmount: "500000000", until: "2026-11-30T00:00:00.000Z" });
  const agreed = new Set(["dana.near"]);
  assert.equal(agreements(agreed).find((a) => a.id === id)!.status, "agreed");
  prepareInvoice(request("9", "dana.near", "500000000"), ASSETS.USDC);
  assert.equal(agreements(agreed).find((a) => a.id === id)!.status, "filed");
});

test("a payment is within the terms only up to the agreed amount and before the deadline", () => {
  const terms = { maxAmount: "250000000", until: "2026-11-30T00:00:00.000Z" };
  const before = new Date("2026-11-01T00:00:00Z");
  assert.ok(withinTerms(terms, "250000000", before));
  assert.ok(!withinTerms(terms, "250000001", before), "over the amount");
  assert.ok(!withinTerms(terms, "1", new Date("2026-12-01T00:00:00Z")), "after the deadline");
});

test("requests left unanswered for weeks stop holding the intake's slots", () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() - 15 * 86_400_000 });
  try { for (const n of ["1", "2", "3"]) assert.equal(requestAgreement(request(n), none).status, "requested"); }
  finally { mock.timers.reset(); }
  assert.equal(requestAgreement(request("4"), none).status, "requested", "the old ones are still listed, but no longer count");
  assert.equal(agreements(none).filter((a) => a.payee === "bob.near").length, 4);
});

test("the dashboard's reads of the invoice host give up rather than hang", async () => {
  let signal: AbortSignal | null | undefined;
  mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => { signal = init?.signal; return new Response(JSON.stringify({ agreements: [] })); });
  try { await remoteStore("https://invoices.example", "s".repeat(32)).list(); }
  finally { mock.restoreAll(); }
  assert.ok(signal instanceof AbortSignal);
});
