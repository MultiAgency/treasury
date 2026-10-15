import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { remoteStore } from "../src/agreements.js";

afterEach(() => mock.restoreAll());
const store = remoteStore("https://invoices.example", "fixture-secret");
const offer = { payee: "fixture.near", amount: "1", note: "fixture", until: new Date("2099-01-01") };
const calls = {
  list: () => store.list(),
  offer: () => store.offer(offer),
  propose: () => store.propose("fixture", offer.until),
  decline: () => store.decline("fixture"),
};
const agreement = { id: "fixture", at: "2026-01-01T00:00:00Z", origin: "owner", payee: "fixture.near",
  amount: "1000000", note: "fixture", status: "proposed", terms: { maxAmount: "1000000", until: offer.until.toISOString() } };

for (const [name, call] of Object.entries(calls)) {
  test(`${name} rejects malformed successful responses without retrying`, async () => {
    const invalid = name === "list"
      ? [{ agreements: null }, { agreements: [{}] }, { agreements: [{ ...agreement, status: "unknown" }] },
        { agreements: [{ ...agreement, terms: { maxAmount: "NaN", until: "bad date" } }] }]
      : name === "offer" ? [{ id: "" }, { id: 1 }, { id: "   " }] : [{ ok: false }, { ok: "true" }];
    for (const body of ["private malformed body", "null", "[]", "{}", ...invalid.map(value => JSON.stringify(value))]) {
      const fetch = mock.method(globalThis, "fetch", async () => new Response(body));
      try {
        await assert.rejects(call, error => error instanceof Error && /invalid response/i.test(error.message)
          && !error.message.includes("private malformed body"));
        assert.equal(fetch.mock.callCount(), 1);
      } finally { mock.restoreAll(); }
    }
  });
}

test("valid agreement responses retain their values and request timeout", async () => {
  const fetch = mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    assert.ok(init?.signal instanceof AbortSignal);
    const path = new URL(String(url)).pathname;
    return Response.json(path.endsWith("/offer") ? { id: "fixture" }
      : path.endsWith("/agreements") ? { agreements: [agreement] } : { ok: true });
  });
  assert.deepEqual(await store.list(), [agreement]);
  assert.equal(await store.offer(offer), "fixture");
  assert.equal(await store.propose("fixture", offer.until), undefined);
  assert.equal(await store.decline("fixture"), undefined);
  assert.equal(fetch.mock.callCount(), 4);
});

test("HTTP failures preserve valid error messages and safely handle malformed error bodies", async () => {
  for (const [body, expected] of [[JSON.stringify({ error: "No such agreement" }), "No such agreement"],
    ["private malformed body", "The invoice host answered 502"], ["null", "The invoice host answered 502"],
    [JSON.stringify({ error: {} }), "The invoice host answered 502"]]) {
    mock.method(globalThis, "fetch", async () => new Response(body, { status: 502 }));
    try { await assert.rejects(store.list(), { message: expected }); }
    finally { mock.restoreAll(); }
  }
});
