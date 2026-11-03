import { type DataStorage, NearConnector } from "@fastnear/near-connect";
import { useSyncExternalStore } from "react";
import type { Challenge, SignedChallenge } from "../platform";

type WalletState = { status: "idle" | "connecting" | "connected"; accountId?: string; publicKey?: string };

/**
 * HOT's near-connect wallet list. It declares delegate actions for more wallets than FastNear's, which owner actions
 * need. Not pinned: each wallet's own code loads from addresses that change anyway.
 */
const HOT_WALLETS = "https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json";

/** Keeps the member's connection apart from any other in the same browser. */
const namespaced = (prefix: string): DataStorage => ({
  get: async key => localStorage.getItem(`${prefix}:${key}`),
  set: async (key, value) => localStorage.setItem(`${prefix}:${key}`, value),
  remove: async key => localStorage.removeItem(`${prefix}:${key}`),
});

/**
 * The owner's wallet, which also signs the member in: NEP-413 messages for sign-in and grants, NEP-366 delegate actions
 * for creating and freezing, so only wallets offering both are listed. One connection as an external store.
 */
function walletSession() {
  let instance: NearConnector | undefined;
  let state: WalletState = { status: "idle" };
  const listeners = new Set<() => void>();
  const update = (next: WalletState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const connector = () => {
    if (!instance) {
      instance = new NearConnector({ network: "mainnet", manifest: HOT_WALLETS, features: { signMessage: true, signDelegateActions: true }, storage: namespaced("member") });
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
    use: () => useSyncExternalStore(listener => {
      listeners.add(listener);
      connector();
      return () => { listeners.delete(listener); };
    }, () => state),
    async connect() {
      update({ status: "connecting" });
      try { await connector().connect(); } finally { await sync(); }
    },
    async disconnect() {
      await connector().disconnect();
      update({ status: "idle" });
    },
  };
}

const wallet = walletSession();
export const useWallet = wallet.use;
export const connect = () => wallet.connect();
export const disconnect = () => wallet.disconnect();

const fromBase64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));

/** Signs the gateway's sign-in challenge with the member's wallet, connecting first. */
export async function signChallenge({ message, recipient, nonce }: Challenge): Promise<SignedChallenge> {
  if ((await wallet.connector.getConnectedWallet().catch(() => null))?.accounts.length !== 1) await wallet.connect();
  const { wallet: connected } = await wallet.connector.getConnectedWallet();
  const signed = await connected.signMessage({ message, recipient, nonce: fromBase64(nonce) });
  // Some wallets also sign the page that asked as a callback URL, without saying so: offer the candidates.
  const callbackUrls = [...new Set([`${location.origin}/`, location.href])];
  return { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce, callbackUrls };
}
