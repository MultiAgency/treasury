import { type DataStorage, NearConnector } from "@fastnear/near-connect";
import { useSyncExternalStore } from "react";
import type { Challenge, SignedChallenge, Transaction } from "../platform";
import { asSigner } from "./wallet-transaction";

type WalletState = { status: "idle" | "connecting" | "connected"; accountId?: string; publicKey?: string };

/**
 * HOT's near-connect wallet list. It declares delegate actions for more wallets than FastNear's, which owner actions
 * need. Not pinned: each wallet's own code loads from addresses that change anyway.
 */
export const HOT_WALLETS = "https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json";

/** Keeps each connection's session apart from the others in the same browser. */
export const namespaced = (prefix: string): DataStorage => ({
  get: async key => localStorage.getItem(`${prefix}:${key}`),
  set: async (key, value) => localStorage.setItem(`${prefix}:${key}`, value),
  remove: async key => localStorage.removeItem(`${prefix}:${key}`),
});

/**
 * One wallet connection as an external store: its account, connect and disconnect, and sending a transaction as that
 * account. `walletId` connects that wallet without asking which.
 */
export function walletSession(createConnector: () => NearConnector, walletId?: string) {
  let instance: NearConnector | undefined;
  let state: WalletState = { status: "idle" };
  const listeners = new Set<() => void>();
  const update = (next: WalletState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const connector = () => {
    if (!instance) {
      instance = createConnector();
      instance.on("wallet:signIn", sync);
      instance.on("wallet:signOut", () => update({ status: "idle" }));
      void sync();
    }
    return instance;
  };
  async function sync() {
    try {
      const [account] = (await connector().getConnectedWallet()).accounts;
      update(account ? { status: "connected", ...account } : { status: "idle" });
    } catch {
      update({ status: "idle" });
    }
  }
  return {
    get connector() { return connector(); },
    update,
    use: () => useSyncExternalStore(listener => {
      listeners.add(listener);
      connector();
      return () => { listeners.delete(listener); };
    }, () => state),
    async connect() {
      update({ status: "connecting" });
      try { await connector().connect(walletId ? { walletId } : undefined); } finally { await sync(); }
    },
    async disconnect() {
      await connector().disconnect();
      update({ status: "idle" });
    },
    /** Sends `transaction` as the connected account. Through Trezu that files it as a DAO proposal. */
    async send(transaction: Transaction) {
      const { wallet, accounts } = await connector().getConnectedWallet();
      const signerId = accounts[0]?.accountId;
      if (!signerId) throw new Error("Connect a wallet first");
      return wallet.signAndSendTransaction(asSigner(signerId, transaction));
    },
  };
}

/**
 * The owner's wallet, which also signs the member in: NEP-413 messages for sign-in and grants, NEP-366 delegate actions
 * for creating and freezing, so only wallets offering both are listed.
 */
export const wallet = walletSession(() => new NearConnector({ network: "mainnet", manifest: HOT_WALLETS,
  features: { signMessage: true, signDelegateActions: true }, storage: namespaced("member") }));
export const useWallet = wallet.use;
export const connect = () => wallet.connect();
export const disconnect = () => wallet.disconnect();

export const fromBase64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));

/** Signs the gateway's sign-in challenge with the member's wallet, connecting first. */
export async function signChallenge({ message, recipient, nonce }: Challenge): Promise<SignedChallenge> {
  if ((await wallet.connector.getConnectedWallet().catch(() => null))?.accounts.length !== 1) await wallet.connect();
  const { wallet: connected } = await wallet.connector.getConnectedWallet();
  const signed = await connected.signMessage({ message, recipient, nonce: fromBase64(nonce) });
  // Some wallets also sign the page that asked as a callback URL, without saying so: offer the candidates.
  const callbackUrls = [...new Set([`${location.origin}/`, location.href])];
  return { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce, callbackUrls };
}
