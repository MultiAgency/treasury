import { type DataStorage, NearConnector } from "@fastnear/near-connect";
import type { OwnerOutput } from "@multiagency/sdk";
import { asSigner } from "./wallet-transaction";

/** What a member's wallet sends: a DAO's transaction as the platform prepared it. */
type Transaction = NonNullable<OwnerOutput<"owner/prepare">["dao"]>["transaction"];

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
 * One wallet connection: the connector, made on first use, connecting, and sending a transaction as the connected
 * account. `walletId` connects that wallet without asking which.
 */
export function walletSession(createConnector: () => NearConnector, walletId?: string) {
  let instance: NearConnector | undefined;
  const connector = () => instance ??= createConnector();
  return {
    get connector() { return connector(); },
    async connect() { await connector().connect(walletId ? { walletId } : undefined); },
    /** Sends `transaction` as the connected account. Through Trezu that files it as a DAO proposal. */
    async send(transaction: Transaction) {
      const { wallet, accounts } = await connector().getConnectedWallet();
      const signerId = accounts[0]?.accountId;
      if (!signerId) throw new Error("Connect a wallet first");
      return wallet.signAndSendTransaction(asSigner(signerId, transaction));
    },
  };
}

export const fromBase64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));

