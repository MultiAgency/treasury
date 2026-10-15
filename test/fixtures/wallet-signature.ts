import { Near, type PrivateKey } from "near-kit";

/**
 * An owner's wallet for fixtures: a fixed key (test-only, never funded), an intent the API "generated"
 * for it, and the wallet's real signature over that intent, which the server checks before relaying.
 * Fixed, so a process that prepares and another that submits agree on both.
 */

const SECRET = "ed25519:vbKRaNtGLifEXMGHhMgHEnHyuLjX1Hb6VdEDQJ4NkARFxCcx4AYdyeLRLuLsoGbuDtwUZBHKtJkzM5RzBRafzNk";
export const walletSigner = { type: "near" as const, account_id: "owner.near", public_key: "ed25519:9S2phg9fejcY4tCT3vp2id9zrwFatEU7d77hnZcxjxkQ" };
export const walletIntent = {
  standard: "nep413" as const,
  payload: { message: '{"fixture":true}', nonce: "p/+tISaEROYbD1QLDJY72ZJt6pv24tOYSp5fWJOtiWo=", recipient: "api.test" },
};
/** What a prepared wallet intent records about it. */
export const preparedForWallet = { intent: walletIntent, signer: walletSigner };

/** The wallet's signed data for `walletIntent`, as the dashboard submits it. */
export async function walletSignature() {
  const near = new Near({ network: "mainnet", privateKey: SECRET as PrivateKey, defaultSignerId: walletSigner.account_id });
  const { publicKey, signature } = await near.signMessage({ ...walletIntent.payload, nonce: Buffer.from(walletIntent.payload.nonce, "base64") });
  return { ...walletIntent, public_key: publicKey, signature };
}
