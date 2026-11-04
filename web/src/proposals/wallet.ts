import { NearConnector } from "@fastnear/near-connect";
import { fromBase64, HOT_WALLETS, namespaced, walletSession } from "../app/wallet";
import type { SignRequest, Signed } from "./proposals-api";

/**
 * The owner's wallet on the proposals page: NEP-413 messages only (sign-in, the consent, verdicts), so any wallet that
 * signs messages is listed. Its connection is kept apart from the owner UI's (`proposals:` storage).
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
