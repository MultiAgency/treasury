import { NearConnector } from "@fastnear/near-connect";
import { fromBase64, HOT_WALLETS, namespaced, walletSession } from "../app/wallet";
import { transactionOutcome, type TransactionOutcome } from "../app/wallet-transaction";
import type { DaoRequest, SignRequest, Signed } from "./proposals-api";

type DaoTransaction = NonNullable<DaoRequest["transaction"]>;

/**
 * The owner's wallet on the proposals page: NEP-413 messages (sign-in, the consent, verdicts), and for a DAO's member
 * the transaction that files a DAO request, so any wallet that signs messages is listed. Its connection is kept apart from the owner UI's (`proposals:` storage).
 */
const wallet = walletSession(() => new NearConnector({ network: "mainnet", manifest: HOT_WALLETS,
  features: { signMessage: true }, storage: namespaced("proposals") }));

/** Signs `message` for `recipient` with `nonce` in the owner's wallet, connecting it first. */
export async function sign({ message, recipient, nonce }: SignRequest): Promise<Signed> {
  if ((await wallet.connector.getConnectedWallet().catch(() => null))?.accounts.length !== 1) await wallet.connect();
  const { wallet: connected } = await wallet.connector.getConnectedWallet();
  const signed = await connected.signMessage({ message, recipient, nonce: fromBase64(nonce) });
  return { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature };
}

/**
 * Files a DAO request's transaction from the member's wallet, exactly as the platform answered it (never one built
 * here), connecting first. What the wallet reports decides only what the page says: `unknown` may have been filed.
 */
export async function fileTransaction(transaction: DaoTransaction): Promise<TransactionOutcome> {
  if ((await wallet.connector.getConnectedWallet().catch(() => null))?.accounts.length !== 1) await wallet.connect();
  return transactionOutcome(await wallet.send(transaction as Parameters<typeof wallet.send>[0]));
}
