import { PROPOSAL_TOKENS } from "@multiagency/sdk";
import type { Overview } from "../platform";
// With its extension, unlike the other app modules: test/format.test.ts loads this one under Node, which resolves only
// explicit `.ts` paths.
import { totalUsd } from "./prices.ts";

export type Holding = Overview["book"][number];

/** Whether the policy lets the agent swap. The target allocation, rebalancing and the steward apply only then. */
export const swaps = (data: Overview) => Boolean(data.policy.policy?.actions.includes("swap"));

export const units = (raw: bigint | string, decimals: number) => Number(raw) / 10 ** decimals;

/** The book's value at the API's prices. */
export const bookValue = (data: Pick<Overview, "book">) => totalUsd(data.book);

/**
 * A raw amount of `asset` in words: at the book's decimals, or the platform's for its own assets when the book doesn't
 * list them (an empty wallet's book lists nothing). Any other asset stays in raw units, never read as whole tokens.
 */
export function amountOf(raw: string, asset: string, book: Holding[]) {
  const h = assetInfo(asset, book);
  return h ? amount(raw, h) : `${raw} raw units · ${asset}`;
}

/** An asset's symbol and decimals: the book's, else the platform's for its own assets; undefined for any other. */
function assetInfo(asset: string, book: Holding[]): Pick<Holding, "decimals" | "symbol"> | undefined {
  return book.find((b) => b.asset === asset) ?? (Object.hasOwn(PROPOSAL_TOKENS, asset) ? PROPOSAL_TOKENS[asset] : undefined);
}

/** A money action's request in words: what moves, how much, and to whom. */
export function describeRequest(request: Record<string, unknown>, book: Holding[], nameOf: (account: string) => string = (a) => a) {
  const r = request as Partial<Record<"origin_asset" | "destination_asset" | "asset" | "amount" | "recipient", string>>;
  return r.origin_asset && r.destination_asset && r.amount
    ? `${amountOf(r.amount, r.origin_asset, book)} → ${assetInfo(r.destination_asset, book)?.symbol ?? r.destination_asset}`
    : r.asset && r.amount
      ? `${amountOf(r.amount, r.asset, book)}${r.recipient ? ` to ${nameOf(r.recipient)}` : ""}`
      : JSON.stringify(request);
}

const amount = (raw: bigint | string, h: Pick<Holding, "decimals" | "symbol">) => {
  const n = units(raw, h.decimals);
  const digits = n === 0 ? 0 : n < 1 ? 5 : n < 100 ? 3 : 2;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: digits })} ${h.symbol}`;
};

export const usd = (n: number | string | null | undefined) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
export function ago(iso: string) {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [unit, size] of [["day", 86400], ["hour", 3600], ["minute", 60]] as const)
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  return relative.format(Math.round(seconds), "second");
}

/** "1500000" at 6 decimals → "1.5", exactly. */
export function fromUnits(raw: string, decimals: number) {
  const digits = raw.padStart(decimals + 1, "0");
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${digits.slice(0, digits.length - decimals)}${fraction ? `.${fraction}` : ""}`;
}

const ASSET_COLOR: Record<string, string> = {
  USDC: "bg-chart-3",
  wNEAR: "bg-chart-2",
  ETH: "bg-chart-1",
};
/** Per-asset colour, used everywhere an asset appears in a chart; an asset without its own is neutral. */
export const assetColor = (symbol: string) => ASSET_COLOR[symbol] ?? "bg-muted-foreground";
