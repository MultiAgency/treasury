import { test } from "node:test";
import assert from "node:assert/strict";
import { AccessKeyDoesNotExistError, AccountDoesNotExistError, NetworkError } from "near-kit";
import { Secret } from "../src/config.ts";
import { chainKeyLookup, rpcHeaders, rpcUrlFor, type AccessKeyRpc } from "../src/keys.ts";

const KEY = "ed25519:DcybBqRYJ8uRirJWNG38C9R3c85y75WwrmYWC4TpYunu";
const rpc = (answer: () => Promise<{ permission: unknown }>): AccessKeyRpc => ({ getAccessKey: answer });
const lookup = (answer: () => Promise<{ permission: unknown }>, timeoutMs = 1_000) =>
  chainKeyLookup({ rpcUrl: "https://rpc.test", apiKey: undefined, timeoutMs, rpc: rpc(answer) })("owner.near", KEY);

test("a full-access key is full, a function-call key limited, and a missing key or account none", async () => {
  assert.equal(await lookup(async () => ({ permission: "FullAccess" })), "full");
  assert.equal(await lookup(async () => ({ permission: { FunctionCall: { receiver_id: "x.near", method_names: [] } } })), "limited");
  assert.equal(await lookup(async () => { throw new AccessKeyDoesNotExistError("owner.near", KEY); }), "none");
  assert.equal(await lookup(async () => { throw new AccountDoesNotExistError("owner.near"); }), "none");
});

test("an RPC that fails or doesn't answer in time is unavailable, never a missing key", async () => {
  assert.equal(await lookup(async () => { throw new NetworkError("down", 503, true); }), "unavailable");
  assert.equal(await lookup(() => new Promise(() => {}), 20), "unavailable");
});

test("the lookup reads at final finality", async () => {
  let options: unknown;
  await chainKeyLookup({ rpcUrl: "https://rpc.test", apiKey: undefined, timeoutMs: 1_000,
    rpc: { getAccessKey: async (_a, _k, given) => { options = given; return { permission: "FullAccess" }; } } })("owner.near", KEY);
  assert.deepEqual(options, { finality: "final" });
});

test("the RPC follows the platform: an override, else FastNEAR's keyed RPC, else its free one", () => {
  const key = new Secret("fn_key");
  assert.equal(rpcUrlFor("https://my.rpc", key), "https://my.rpc");
  assert.equal(rpcUrlFor(undefined, key), "https://rpc.mainnet.fastnear.com");
  assert.equal(rpcUrlFor(undefined, undefined), "https://free.rpc.fastnear.com");
});

test("the FastNEAR key goes only to FastNEAR's own hosts over HTTPS", () => {
  const key = new Secret("fn_key");
  assert.deepEqual(rpcHeaders("https://rpc.mainnet.fastnear.com", key), { Authorization: "Bearer fn_key" });
  assert.deepEqual(rpcHeaders("https://my.rpc", key), {});
  assert.deepEqual(rpcHeaders("http://rpc.mainnet.fastnear.com", key), {});
  assert.deepEqual(rpcHeaders("https://rpc.mainnet.fastnear.com:8443", key), {});
  assert.deepEqual(rpcHeaders("https://rpc.mainnet.fastnear.com", undefined), {});
});
