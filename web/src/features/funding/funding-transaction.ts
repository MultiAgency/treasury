import { ASSETS } from "@multiagency/sdk";
import type { OwnerOutput } from "@multiagency/sdk";
import { fromUnits } from "../../shared/format.ts";

export type FundingAsset = "USDC" | "NEAR";
export type Funding = OwnerOutput<"treasury/fund">;

/** What the treasury signs: the asset's contract, and the decimals it is entered in. */
const TOKENS = {
  USDC: { contract: ASSETS.USDC.replace(/^nep141:/, ""), decimals: 6, symbol: "USDC" },
  NEAR: { contract: ASSETS.wNEAR.replace(/^nep141:/, ""), decimals: 24, symbol: "NEAR" },
} as const;
export const decimalsOf = (asset: FundingAsset) => TOKENS[asset].decimals;

/** The exact transfer a prepared funding transaction makes, read from the transaction itself. */
export type Transfer = { amount: string; symbol: string; contract: string; address: string; storage: string };

/**
 * Reads the transaction `treasury/fund` prepared, and answers the transfer it makes, or why it must not be signed: it
 * must pay exactly `amount` of `asset` into the deposit address it came with (wNEAR wrapped from the same NEAR amount),
 * with nothing else attached but that address's storage registration. A deposit address that needs a memo, or a
 * minimum above the amount, can't be paid by this transaction: funds sent there could be lost.
 */
export function fundingTransfer(funding: Funding, asset: FundingAsset, amount: string): { transfer: Transfer } | { problem: string } {
  const { deposit, transaction } = funding;
  const token = TOKENS[asset];
  const refuse = (problem: string) => ({ problem: `${problem} Nothing was sent.` });
  if (deposit.memo) return refuse("This deposit address needs a memo, which a funding transfer can't carry.");
  if (deposit.minAmount && BigInt(amount) < BigInt(deposit.minAmount))
    return refuse(`This deposit address takes at least ${fromUnits(deposit.minAmount, token.decimals)} ${token.symbol}.`);
  if (transaction.receiverId !== token.contract) return refuse(`The prepared transaction isn't a ${token.symbol} transfer.`);
  const calls = transaction.actions.map(action => ({ method: action.params.methodName, args: action.params.args as Record<string, unknown>, deposit: action.params.deposit }));
  const expected = asset === "USDC" ? ["storage_deposit", "ft_transfer"] : ["storage_deposit", "near_deposit", "ft_transfer"];
  if (calls.map(call => call.method).join() !== expected.join()) return refuse("The prepared transaction isn't the funding transfer this page sends.");
  const [storage, ...rest] = calls;
  const transfer = rest.at(-1)!;
  const wrap = asset === "NEAR" ? rest[0] : undefined;
  if (storage!.args.account_id !== deposit.address || storage!.args.registration_only !== true
    || transfer.args.receiver_id !== deposit.address || transfer.args.amount !== amount || transfer.deposit !== "1"
    || (wrap && (wrap.deposit !== amount || Object.keys(wrap.args).length)))
    return refuse("The prepared transaction doesn't pay exactly this amount into its deposit address.");
  return { transfer: { amount: fromUnits(amount, token.decimals), symbol: token.symbol, contract: token.contract, address: deposit.address, storage: fromUnits(storage!.deposit, 24) } };
}
