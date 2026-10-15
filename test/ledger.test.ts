import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { api } from "../src/api.js";
import { ledger } from "../src/ledger.js";
import { freshDirectory, offline } from "./fixtures/harness.js";

freshDirectory("ledger");
const deposit = (id = "fixture", hash = "tx", address = "deposit.near", at = "2026-01-01T00:00:00Z") => ({
  type: "deposit", status: "SUCCESS", correlation_id: id, created_at: at, updated_at: at,
  details: { deposit_tx_hash: hash, deposit_address: address },
});
const transfer = (address = "deposit.near") => `EVENT_JSON:${JSON.stringify({ standard: "nep141", event: "ft_transfer",
  data: [{ new_owner_id: address }] })}`;
const receipt = (asset = "token.near", logs = [transfer()]) => ({ receipt: { receiver_id: asset }, execution_outcome: { outcome: { logs } } });
const response = (...receipts: unknown[]) => ({ transactions: [{ receipts }] });
beforeEach(() => {
  offline();
  mock.method(api, "getHistory", async () => ({ data: [deposit()] }));
  mock.method(api, "listProviderRecords", async () => ({ data: { events: [] } }));
});
afterEach(() => mock.restoreAll());

test("valid deposit evidence identifies the asset and unmatched evidence stays null", async () => {
  for (const [body, asset] of [[response(receipt()), "nep141:token.near"], [response(receipt("token.near", [transfer("other.near")])), null],
    [response(receipt("token.near", ["ordinary log", 'EVENT_JSON:{"standard":"other","event":"other"}'])), null],
    [{ transactions: [] }, null]]) {
    mock.method(globalThis, "fetch", async () => Response.json(body));
    const [row] = await ledger();
    assert.equal(row?.assetIn, asset);
    assert.equal(row?.assetOut, asset);
  }
});

test("invalid deposit evidence fails explicitly without leaking response contents", async () => {
  const invalid = [
    {}, { transactions: null }, { transactions: [{}] }, response(null), response({}),
    response({ execution_outcome: { outcome: { logs: [transfer()] } } }),
    response(receipt("", [transfer()])), response(receipt("   ", [transfer()])),
    response({ receipt: { receiver_id: 42 }, execution_outcome: { outcome: { logs: [transfer()] } } }),
    response({ receipt: { receiver_id: "token.near" }, execution_outcome: { outcome: { logs: [42] } } }),
    response(receipt("token.near", ["EVENT_JSON:private-malformed"])),
    response(receipt("token.near", ["EVENT_JSON:null"])),
    response(receipt("token.near", ['EVENT_JSON:{"standard":"nep141","event":"ft_transfer"}'])),
    response(receipt("token.near", ['EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":[]}'])),
    response(receipt("token.near", ['EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":{}}'])),
    response(receipt("token.near", ['EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":[{}]}'])),
    response(receipt(), receipt("token.near", ["EVENT_JSON:private-malformed"])),
  ];
  for (const body of invalid) {
    mock.method(globalThis, "fetch", async () => Response.json(body));
    await assert.rejects(ledger(), error => error instanceof Error && /deposit evidence.*unavailable/i.test(error.message)
      && !error.message.includes("private-malformed"), JSON.stringify(body));
  }
});

test("lookups deduplicate hashes, retain address identity and order, and use at most four workers", async () => {
  const rows = [deposit("later", "shared", "second.near", "2026-02-01T00:00:00Z"), deposit("first", "shared"),
    ...Array.from({ length: 8 }, (_, i) => deposit(`row${i}`, `tx${i}`))];
  mock.method(api, "getHistory", async () => ({ data: rows }));
  let active = 0, peak = 0;
  const hashes: string[] = [];
  mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const { tx_hashes } = JSON.parse(String(init?.body));
    assert.equal(tx_hashes.length, 1);
    hashes.push(tx_hashes[0]);
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return Response.json(response(receipt(), receipt("second-token.near", [transfer("second.near")])));
  });
  const result = await ledger();
  assert.equal(peak, 4);
  assert.equal(hashes.length, 9);
  assert.equal(new Set(hashes).size, 9);
  assert.equal(result[0]?.correlationId, "first");
  assert.equal(result[0]?.assetIn, "nep141:token.near");
  assert.equal(result.at(-1)?.correlationId, "later");
  assert.equal(result.at(-1)?.assetIn, "nep141:second-token.near");
  await ledger();
  assert.equal(hashes.length, 18, "cache is confined to one invocation");
});

test("failed lookups reject the ledger and leave no workers running after rejection", async () => {
  mock.method(api, "getHistory", async () => ({ data: Array.from({ length: 8 }, (_, i) => deposit(`row${i}`, `tx${i}`)) }));
  let active = 0;
  const fetch = mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    active++;
    try {
      if (String(init?.body).includes('"tx0"')) throw new Error("private transport details");
      await new Promise(resolve => setImmediate(resolve));
      return Response.json(response(receipt()));
    } finally { active--; }
  });
  await assert.rejects(ledger(), /unavailable/i);
  assert.equal(active, 0);
  assert.equal(fetch.mock.callCount(), 4, "no queued lookups start after the failure");
});

test("only successful deposits with transaction and address evidence trigger lookups", async () => {
  mock.method(api, "getHistory", async () => ({ data: [
    { ...deposit(), type: "swap" }, { ...deposit(), status: "FAILED" },
    { ...deposit(), details: { deposit_tx_hash: "tx" } },
    { ...deposit(), details: { deposit_address: "deposit.near" } },
  ] }));
  const fetch = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected lookup"); });
  assert.equal((await ledger()).length, 4);
  assert.equal(fetch.mock.callCount(), 0);
});
