import { NearConnector } from "@fastnear/near-connect";
import { fromBase64, HOT_WALLETS, namespaced, walletSession } from "../app/wallet";
import { transactionOutcome, type TransactionOutcome } from "../app/wallet-transaction";
import { signerProblem } from "./dao-filing";
import type { DaoRequest, SignRequest, Signed } from "./proposals-api";

/**
 * The owner's wallet on the proposals page: NEP-413 messages (sign-in, the consent, verdicts), so any wallet that
 * signs messages is listed, and for a DAO's member the proposal they file. Its connection is kept apart from the owner
 * UI's (`proposals:` storage).
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

/** A transaction a DAO member files: the platform's, as the server stored it, sent as is. */
export type MemberTransaction = NonNullable<Extract<NonNullable<DaoRequest["offer"]>, { state: "file" }>["transaction"]>;

/**
 * Sends a DAO member's filing from their wallet, connecting it first, only when the connected account is `member`, the
 * account signed in here (else it throws, having sent nothing). Only a success the wallet reports proves it executed; a
 * failure reverted it whole, so nothing was filed.
 */
export async function file(transaction: MemberTransaction, member: string): Promise<TransactionOutcome> {
  if ((await wallet.connector.getConnectedWallet().catch(() => null))?.accounts.length !== 1) await wallet.connect();
  const problem = signerProblem((await wallet.connector.getConnectedWallet()).accounts[0]?.accountId, member);
  if (problem) throw new WrongAccount(problem);
  return transactionOutcome(await wallet.send(transaction));
}

/** The wallet is connected as another account than the member signed in: nothing was sent. */
export class WrongAccount extends Error {}
