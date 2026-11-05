import { NearConnector } from "@fastnear/near-connect";
import type { fundingTransaction } from "@multiagency/sdk";
import { fromBase64, HOT_WALLETS, namespaced, walletSession } from "../app/wallet";
import { transactionOutcome, type TransactionOutcome } from "../app/wallet-transaction";
import { signerProblem } from "./dao-filing";
import type { DaoRequest, GrantPrepared, SignRequest, Signed } from "./proposals-api";

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

/**
 * Signs a grant's NEP-413 intent exactly as the platform prepared it, in the owner's wallet, connecting it first: only as
 * `owner` (else it throws, having signed nothing). Answers the intent with the key that signed it and its signature.
 */
export async function signIntent(intent: NonNullable<GrantPrepared["intent"]>, owner: string) {
  if ((await wallet.connector.getConnectedWallet().catch(() => null))?.accounts.length !== 1) await wallet.connect();
  const { wallet: connected, accounts } = await wallet.connector.getConnectedWallet();
  if (accounts[0]?.accountId !== owner) throw new WrongAccount(`Your wallet is connected as ${accounts[0]?.accountId ?? "no account"}, not the owner ${owner}. Nothing was signed. Switch the wallet to ${owner}.`);
  const signed = await connected.signMessage({ ...intent.payload, nonce: fromBase64(intent.payload.nonce) });
  return { ...intent, public_key: signed.publicKey, signature: signed.signature };
}

/** The wallet is connected as another account than the member signed in: nothing was sent. */
export class WrongAccount extends Error {}

/**
 * A DAO acting through Trezu, beside the owner's own wallet: what it's sent, it files as one proposal the DAO's members
 * vote on. Its connection is kept apart from the owner UI's (`proposals-dao:` storage).
 */
const trezu = walletSession(() => new NearConnector({ network: "mainnet", manifest: HOT_WALLETS, storage: namespaced("proposals-dao") }), "trezu-wallet");

/**
 * Sends a funding transaction as `account`, the agent's funding account: from the owner's wallet, or for a DAO through
 * Trezu, which files it as a proposal. Each connects first, and sends only when connected as `account` (else it throws,
 * having sent nothing). Only a success the wallet reports proves it executed; a failure reverted it whole.
 */
export async function fund(transaction: ReturnType<typeof fundingTransaction>, account: string, { dao }: { dao: boolean }): Promise<TransactionOutcome> {
  const session = dao ? trezu : wallet;
  const connected = async () => (await session.connector.getConnectedWallet().catch(() => null))?.accounts[0]?.accountId;
  if (await connected() !== account) await session.connect();
  const now = await connected();
  if (now !== account) throw new WrongAccount(`${dao ? "Trezu" : "Your wallet"} is connected as ${now ?? "no account"}, not the funding account ${account}. Nothing was ${dao ? "filed" : "sent"}. ${dao ? "Connect Trezu to" : "Switch the wallet to"} ${account}.`);
  // The SDK types each call's arguments as `object`; they're its own plain JSON arguments, as the wallet sends them.
  return transactionOutcome(await session.send(transaction as Parameters<typeof session.send>[0]));
}
