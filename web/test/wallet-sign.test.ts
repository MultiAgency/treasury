import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

// Run the actual signing entry point with a wallet double, without loading wallet UI or its network manifest.
const source = readFileSync(new URL("../src/wallet.ts", import.meta.url), "utf8");
const entry = source.slice(source.indexOf("export async function sign("), source.indexOf("/** A transaction"));
const js = stripTypeScriptTypes(entry.replace("export ", "").replace(": SignRequest", "").replace(": Promise<Signed>", ""));
function harness(accounts: { accountId: string }[] | null) {
  let connections = 0;
  let signatures = 0;
  const signed = { accountId: "owner.near", publicKey: "key", signature: "signature" };
  const wallet = {
    connect: async () => { connections++; },
    connector: { getConnectedWallet: async () => {
      if (accounts === null) throw new Error("No wallet selected");
      return { accounts, wallet: { signMessage: async () => { signatures++; return signed; } } };
    } },
  };
  const sign = new Function("wallet", "fromBase64", `${js}; return sign;`)(wallet, () => new Uint8Array());
  return { sign, signed, counts: () => ({ connections, signatures }) };
}
const request = { message: "setup consent", recipient: "treasury.example", nonce: "AA==" };

test("setup reuses an existing wallet even when it exposes multiple accounts", async () => {
  for (const accounts of [[{ accountId: "owner.near" }], [{ accountId: "owner.near" }, { accountId: "other.near" }]]) {
    const h = harness(accounts);
    assert.deepEqual(await h.sign(request), h.signed);
    assert.deepEqual(h.counts(), { connections: 0, signatures: 1 });
  }
});
test("a missing wallet reports an error without opening login or signing", async () => {
  for (const accounts of [null, []]) {
    const h = harness(accounts);
    await assert.rejects(h.sign(request), /wallet connection is unavailable/);
    assert.deepEqual(h.counts(), { connections: 0, signatures: 0 });
  }
});
test("explicit sign-in still opens the wallet chooser", async () => {
  const h = harness([{ accountId: "owner.near" }]);
  await h.sign(request, { chooseWallet: true });
  assert.deepEqual(h.counts(), { connections: 1, signatures: 1 });
});
