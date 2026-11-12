import { ASSETS } from "@multiagency/sdk";
import type { OwnerOutput } from "@multiagency/sdk";
import { fromUnits } from "./shared/format.ts";

export type FundingAsset = "USDC" | "NEAR";
export type Funding = OwnerOutput<"treasury/fund">;

/** What the treasury signs: the asset's contract, and the decimals it is entered in. */
const TOKENS = {
  USDC: { contract: ASSETS.USDC.replace(/^nep141:/, ""), decimals: 6, symbol: "USDC" },
  NEAR: { contract: ASSETS.wNEAR.replace(/^nep141:/, ""), decimals: 24, symbol: "NEAR" },
} as const;
export const decimalsOf = (asset: FundingAsset) => TOKENS[asset].decimals;

/** One NEP-145 registration: the platform's `STORAGE_DEPOSIT` (`src/chain.ts` at 1a7fe98), 0.00125 NEAR. */
const STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;
/** An address this close to its expiry isn't paid: the transfer may land after it. */
export const EXPIRY_MARGIN_MS = 2 * 60_000;

/** The exact transfer a prepared funding transaction makes, read from the transaction itself. */
export type Transfer = {
  amount: string; symbol: string; contract: string; address: string; storage: string; expiresAt: string | null;
  /** For a DAO, what the review must say about paying later. */
  caveat: string | null;
};

const exactly = (value: object, keys: string[]) => Object.keys(value).sort().join() === [...keys].sort().join();

/** Why a deposit address must not be paid now: expired, or expiring within the margin. */
export function expiryProblem(expiresAt: string | null, now: number) {
  if (expiresAt === null) return undefined;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return "This deposit address's expiry couldn't be read. Nothing was sent.";
  if (at <= now) return "This deposit address has expired. Nothing was sent.";
  if (at - now < EXPIRY_MARGIN_MS) return "This deposit address expires within two minutes: review the transfer again for a new one. Nothing was sent.";
  return undefined;
}

/**
 * Reads a funding transaction (the one `treasury/fund` prepared, or the SDK's `fundingTransaction` for a `deposit`
 * address), and answers the transfer it makes, or why it must not be signed: it
 * must pay exactly `amount` of `asset` into the deposit address it came with (wNEAR wrapped from the same NEAR amount),
 * with nothing else in it but one storage registration for that address. A deposit address that needs a memo, a
 * minimum above the amount, or that expires within the margin can't be paid by this transaction. A DAO pays only once
 * its vote passes, whose period this page can't read: the review says so.
 */
export function fundingTransfer(funding: Funding, asset: FundingAsset, amount: string,
  { now = Date.now(), dao = false }: { now?: number; dao?: boolean } = {}): { transfer: Transfer } | { problem: string } {
  const { deposit, transaction } = funding;
  const token = TOKENS[asset];
  const refuse = (problem: string) => ({ problem: `${problem} Nothing was sent.` });
  if (deposit.memo) return refuse("This deposit address needs a memo, which a funding transfer can't carry.");
  if (deposit.minAmount && BigInt(amount) < BigInt(deposit.minAmount))
    return refuse(`This deposit address takes at least ${fromUnits(deposit.minAmount, token.decimals)} ${token.symbol}.`);
  const expired = expiryProblem(deposit.expiresAt, now);
  if (expired) return { problem: expired };
  if (transaction.receiverId !== token.contract) return refuse(`The prepared transaction isn't a ${token.symbol} transfer.`);
  const expected = asset === "USDC" ? ["storage_deposit", "ft_transfer"] : ["storage_deposit", "near_deposit", "ft_transfer"];
  if (!exactly(transaction, ["receiverId", "actions"])
    || transaction.actions.some(action => !exactly(action, ["type", "params"]) || !exactly(action.params, ["methodName", "args", "gas", "deposit"]))
    || transaction.actions.map(action => action.params.methodName).join() !== expected.join())
    return refuse("The prepared transaction isn't the funding transfer this page sends.");
  const calls = transaction.actions.map(action => ({ args: action.params.args as Record<string, unknown>, deposit: action.params.deposit }));
  const [storage, ...rest] = calls;
  const transfer = rest.at(-1)!;
  const wrap = asset === "NEAR" ? rest[0] : undefined;
  if (!exactly(storage!.args, ["account_id", "registration_only"]) || storage!.args.account_id !== deposit.address || storage!.args.registration_only !== true
    || !exactly(transfer.args, ["receiver_id", "amount"]) || transfer.args.receiver_id !== deposit.address || transfer.args.amount !== amount || transfer.deposit !== "1"
    || (wrap && (wrap.deposit !== amount || Object.keys(wrap.args).length)))
    return refuse("The prepared transaction doesn't pay exactly this amount into its deposit address.");
  if (!/^\d+$/.test(storage!.deposit) || BigInt(storage!.deposit) > STORAGE_DEPOSIT)
    return refuse(`The prepared transaction attaches more than ${fromUnits(STORAGE_DEPOSIT.toString(), 24)} NEAR to register the address.`);
  const caveat = dao && deposit.expiresAt
    ? "The DAO pays once its vote passes, and its voting period can't be read here. If the vote ends after this address expires, the payment goes to an expired address and may not reach this agent: ask members to vote before then."
    : null;
  return { transfer: { amount: fromUnits(amount, token.decimals), symbol: token.symbol, contract: token.contract, address: deposit.address,
    storage: fromUnits(storage!.deposit, 24), expiresAt: deposit.expiresAt, caveat } };
}
