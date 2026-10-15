import type { client } from "./client";
import { ASSETS } from "../../../src/policy.js";
import type { Kind } from "../features/evidence/beats";
import { totalUsd } from "../../../src/valuation.js";
export { exactPayment, fromUnits } from "../features/payables/payment-copy";

export type Overview = Awaited<ReturnType<typeof client.overview>>;
export type Holding = Overview["book"][number];

/** Whether the policy lets the agent swap. The target allocation, rebalancing and the steward apply only then. */
export const swaps = (data: Overview) => Boolean(data.policy.policy?.actions.includes("swap"));

/** Configured area is stable across policy changes. Legacy servers retain their policy-based fallback. */
export const kindOf = (data: Overview): Kind => data.area ? (data.area === "treasury" ? "treasury" : "facilitator") : (swaps(data) ? "treasury" : "facilitator");

export const units = (raw: bigint | string, decimals: number) => Number(raw) / 10 ** decimals;

/** The book's value at the API's prices. */
export const bookValue = (data: Pick<Overview, "book">) => totalUsd(data.book);

/** Payouts are confidential USDC (src/authorize.ts), which an empty wallet's book doesn't list. */
const USDC = { asset: ASSETS.USDC, decimals: 6, symbol: "USDC" };

/** A raw amount of `asset` in words at the book's decimals, or in raw units when the book doesn't list it. */
export function amountOf(raw: string, asset: string, book: Holding[]) {
  const h = book.find((b) => b.asset === asset) ?? (asset === USDC.asset ? USDC : undefined);
  return h ? amount(raw, h) : `${raw} ${asset.replace(/^nep141:/, "")}`;
}

/** A money action's request in words: what moves, how much, and to whom. */
export function describeRequest(request: Record<string, unknown>, book: Holding[], nameOf: (account: string) => string = (a) => a) {
  const r = request as Partial<Record<"origin_asset" | "destination_asset" | "asset" | "amount" | "recipient", string>>;
  return r.origin_asset && r.destination_asset && r.amount
    ? `${amountOf(r.amount, r.origin_asset, book)} → ${book.find((b) => b.asset === r.destination_asset)?.symbol ?? r.destination_asset}`
    : r.asset && r.amount
      ? `${amountOf(r.amount, r.asset, book)}${r.recipient ? ` to ${nameOf(r.recipient)}` : ""}`
      : JSON.stringify(request);
}

/** An account or id short enough for a badge: its head and tail, when it is longer than `max`. */
export const short = (id: string, max = 20) => (id.length > max ? `${id.slice(0, 8)}…${id.slice(-6)}` : id);

export const amount = (raw: bigint | string, h: Pick<Holding, "decimals" | "symbol">) => {
  const n = units(raw, h.decimals);
  const digits = n === 0 ? 0 : n < 1 ? 5 : n < 100 ? 3 : 2;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: digits })} ${h.symbol}`;
};

/** "1.5" at 6 decimals → "1500000"; null unless it is a positive decimal that fits. */
export function toUnits(value: string, decimals: number) {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const [, whole = "", fraction = ""] = match;
  if (fraction.length > decimals) return null;
  const raw = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  return raw > 0n ? raw.toString() : null;
}

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

/** 125 seconds → "2:05". */
export const minutesSeconds = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** Per-asset colour, used everywhere an asset appears in a chart. */
export const ASSET_COLOR: Record<string, string> = {
  USDC: "bg-chart-3",
  wNEAR: "bg-chart-2",
  ETH: "bg-chart-1",
};
