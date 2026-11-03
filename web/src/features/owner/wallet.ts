import { NearConnector } from "@fastnear/near-connect";
import type { Intent, Transaction } from "../../platform";
import type { Wallets } from "./owner-flow";
import { fromBase64, HOT_WALLETS, namespaced, wallet, walletSession } from "../../app/wallet";

/**
 * A DAO acting through Trezu, a second connection beside the owner's: it signs as the DAO by filing each transaction
 * as a proposal its members vote on.
 */
export const dao = walletSession(() => new NearConnector({ network: "mainnet", manifest: HOT_WALLETS, storage: namespaced("dao") }), "trezu-wallet");

/** Trezu connected as `daoId`, connecting first when it isn't. */
export async function ensureDao(daoId: string) {
  const current = (await dao.connector.getConnectedWallet().catch(() => null))?.accounts[0]?.accountId;
  if (current !== daoId) await dao.connect();
  const connected = (await dao.connector.getConnectedWallet()).accounts[0]?.accountId;
  if (connected !== daoId) throw new Error(`Trezu is connected as ${connected}, not ${daoId}`);
}

/** Sends a transaction from the signed-in member's own wallet, such as a DAO proposal they file. */
export const sendAsMember = (transaction: Transaction) => wallet.send(transaction);

/** Whether the signed-in member's own wallet is connected. */
export const memberConnected = async () => ((await wallet.connector.getConnectedWallet().catch(() => null))?.accounts.length ?? 0) > 0;

/**
 * The connected account as an agent owner. Some wallets report the key only with a signature, so a missing key is
 * read from a one-off signed message.
 */
export async function ownerWallet() {
  const { wallet: connected, accounts } = await wallet.connector.getConnectedWallet();
  const [account] = accounts;
  if (!account) throw new Error("Connect a wallet first");
  const publicKey = account.publicKey ?? (await connected.signMessage({
    message: "Identify my key as the owner of an Agentic Treasury agent",
    recipient: location.host,
    nonce: crypto.getRandomValues(new Uint8Array(32)),
  })).publicKey;
  wallet.update({ status: "connected", accountId: account.accountId, publicKey });
  return { type: "near" as const, account_id: account.accountId, public_key: publicKey };
}

/** Signs an owner intent's payload exactly as the API generated it, by the standard it chose. */
export async function signIntent(intent: Intent): Promise<Record<string, unknown>> {
  const { wallet: connected } = await wallet.connector.getConnectedWallet();
  switch (intent.standard) {
    case "nep413": {
      const { publicKey, signature } = await connected.signMessage({ ...intent.payload, nonce: fromBase64(intent.payload.nonce) });
      return { ...intent, public_key: publicKey, signature };
    }
    case "nep366": {
      const { signedDelegateActions } = await connected.signDelegateActions({ delegateActions: [intent.payload] });
      const signed = signedDelegateActions[0];
      // Wallets answer in one of two transport forms; an older object form has no stable encoding.
      if (typeof signed === "string") return { ...intent, signed_delegate: signed };
      if (signed && "borshSerializedBase64" in signed) return { ...intent, signed_delegate: signed.borshSerializedBase64 };
      throw new Error("This wallet returned its signature in an older format. Try another wallet.");
    }
    default:
      throw new Error(`This dashboard signs NEAR intents only, not ${intent.standard}`);
  }
}

/** The wallet steps an owner action takes, for `runOwnerAction`. */
export const wallets: Wallets = { signIntent, ownerWallet, memberConnected, sendAsMember, ensureDao, sendAsDao: transaction => dao.send(transaction) };
