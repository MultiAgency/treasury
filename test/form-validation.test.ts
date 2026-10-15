import assert from "node:assert/strict";
import { test } from "node:test";
import { accountError, deadlineError, payeeError } from "../web/src/shared/form-validation.js";

test("payee entry accepts near.com accounts without changing owner-account validation", () => {
  for (const account of ["nearcom:Payee.near", "NEARCOM:0x" + "AB".repeat(20), "nearcom:" + "a".repeat(64)]) {
    assert.equal(payeeError(account), undefined);
    assert.ok(accountError(account));
  }
  for (const account of ["nearcom:", "nearcom:nearcom:payee.near", "nearcom:alice..near", "nearcom: alice.near"])
    assert.ok(payeeError(account));
});

test("NEAR account feedback accepts full named and implicit accounts, rejects malformed identifiers", () => {
  for (const account of ["payee.near", "team.sputnik-dao.near", "a".repeat(64), " payee.near ", "aa", "alice_bob.near"])
    assert.equal(accountError(account), undefined, account);
  for (const account of ["", "a", "Alice.near", "alice..near", "alice-.near", "alice near", "a".repeat(65)])
    assert.ok(accountError(account), account);
});

test("agreement deadline feedback rejects empty, impossible and expired days before date conversion", () => {
  const now = Date.parse("2026-10-14T12:00:00.000Z");
  for (const value of ["", "not-a-date", "2026-02-30", "2026-10-13", "2026-1-4"])
    assert.ok(deadlineError(value, now), value);
  for (const value of ["2026-10-14", "2026-10-15", "2028-02-29"])
    assert.equal(deadlineError(value, now), undefined, value);
  assert.ok(deadlineError("2026-10-14", Date.parse("2026-10-15T00:00:00Z")));
});
