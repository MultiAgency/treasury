import { NearConnector } from "@fastnear/near-connect";
import type { fundingTransaction } from "@multiagency/sdk";
import { fromBase64, HOT_WALLETS, namespaced, walletSession } from "./wallet-session";
import { transactionOutcome, type TransactionOutcome } from "./wallet-transaction";
import { signerProblem } from "./dao-filing";
import type { DaoRequest, GrantPrepared, SignRequest, Signed } from "./server-api";

/**
 * The owner's wallet in the app: NEP-413 messages (sign-in, the consent, verdicts), so any wallet that
 * signs messages is listed, and for a DAO's member the proposal they file. Its connection is kept in
 * its own storage (`proposals:`).
 */
const wallet = walletSession(() => new NearConnector({ network: "mainnet", manifest: HOT_WALLETS,
  features: { signMessage: true }, storage: namespaced("proposals") }));

/** Signs the message in a wallet; new server sign-ins set `chooseWallet` to offer another wallet or account. */
export async function sign({ message, recipient, nonce }: SignRequest, { chooseWallet = false }: { chooseWallet?: boolean } = {}): Promise<Signed> {
  if (chooseWallet) await wallet.connect();
  const session = await wallet.connector.getConnectedWallet().catch(() => null);
  if (!session?.accounts.length) {
    throw new Error("Your wallet connection is unavailable. Sign out and sign in again to reconnect your wallet, then try again");
  }
  const { wallet: connected } = session;
  const signed = await connected.signMessage({ message, recipient, nonce: fromBase64(nonce) });
  return { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature };
}

/** A transaction a DAO member files: the platform's, as the server stored it, sent as is. */
export type MemberTransaction = NonNullable<Extract<NonNullable<DaoRequest["offer"]>, { state: "file" }>["transaction"]>;

/**
 * Sends a DAO member's filing from their wallet, connecting it only when none is, only when its first account is
 * `member`, the account signed in here (else it throws, having sent nothing). Only a success the wallet reports proves it
 * executed; a failure reverted it whole, so nothing was filed.
 */
export async function file(transaction: MemberTransaction, member: string): Promise<TransactionOutcome> {
  const problem = signerProblem((await connectedWallet()).accounts[0]?.accountId, member);
  if (problem) throw new WrongAccount(problem);
  return transactionOutcome(await wallet.send(transaction));
}

/**
 * Signs a grant's NEP-413 intent exactly as the platform prepared it, in the owner's wallet, connecting it only when none
 * is: only when `owner` is a connected account (else it throws, having signed nothing), and answers it only when `owner`
 * signed (else it throws, having sent nothing). Answers the intent with the key that signed it and its signature.
 */
export async function signIntent(intent: NonNullable<GrantPrepared["intent"]>, owner: string, beforeSign?: () => Promise<void>) {
  const { wallet: connected, accounts } = await connectedWallet();
  if (!accounts.some(({ accountId }) => accountId === owner)) throw new WrongAccount(`Your wallet is connected as ${accounts.map(({ accountId }) => accountId).join(", ") || "no account"}, not the owner ${owner}. Nothing was signed. Switch the wallet to ${owner}.`);
  // A review may become stale while the wallet connects. Recheck after connecting, immediately before signing.
  await beforeSign?.();
  const signed = await connected.signMessage({ ...intent.payload, nonce: fromBase64(intent.payload.nonce) });
  if (signed.accountId !== owner) throw new WrongAccount(`Your wallet signed as ${signed.accountId}, not the owner ${owner}. Nothing was sent. Sign with ${owner}.`);
  return { ...intent, public_key: signed.publicKey, signature: signed.signature };
}

/** The wallet's connection, reused when it has any account (a wallet may expose several); connects only when it has none. */
async function connectedWallet() {
  const session = await wallet.connector.getConnectedWallet().catch(() => null);
  if (session?.accounts.length) return session;
  await wallet.connect();
  return wallet.connector.getConnectedWallet();
}

/** The wallet is connected as another account than the member signed in: nothing was sent. */
export class WrongAccount extends Error {}

/**
 * A DAO acting through Trezu, beside the owner's own wallet: what it's sent, it files as one proposal the DAO's members
 * vote on. Its connection is kept in its own storage (`proposals-dao:`).
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
