import { PROPOSAL_TOKENS } from "@multiagency/sdk";
import type { OwnerOutput } from "@multiagency/sdk";

type Overview = OwnerOutput<"overview">;

export type Holding = Overview["book"][number];
/** What naming an asset's amount needs of a holding: its ID, symbol and decimals, whichever form its balances take. */
export type AssetInfo = Pick<Holding, "asset" | "decimals" | "symbol">;

export const units = (raw: bigint | string, decimals: number) => Number(raw) / 10 ** decimals;

/**
 * A raw amount of `asset` in words: at the book's decimals, or the platform's for its own assets when the book doesn't
 * list them (an empty wallet's book lists nothing). Any other asset stays in raw units, never read as whole tokens.
 */
export function amountOf(raw: string, asset: string, book: readonly AssetInfo[]) {
  const h = assetInfo(asset, book);
  return h ? amount(raw, h) : `${raw} raw units · ${asset}`;
}

/** A raw amount of `asset` exactly, never rounded: what a signed text names. An asset without known decimals stays in raw units. */
export function exactAmountOf(raw: string, asset: string, book: readonly AssetInfo[]) {
  const h = assetInfo(asset, book);
  return h ? `${fromUnits(raw, h.decimals)} ${h.symbol}` : `${raw} raw units · ${asset}`;
}

/** An asset's symbol and decimals: the book's, else the platform's for its own assets; undefined for any other. */
function assetInfo(asset: string, book: readonly AssetInfo[]): Pick<Holding, "decimals" | "symbol"> | undefined {
  return book.find((b) => b.asset === asset) ?? (Object.hasOwn(PROPOSAL_TOKENS, asset) ? PROPOSAL_TOKENS[asset] : undefined);
}

/** An asset's symbol: the book's, else the platform's for its own assets, else its id. */
export const symbolOf = (asset: string, book: readonly AssetInfo[]) => assetInfo(asset, book)?.symbol ?? asset;

/** Exact payment terms for a decision: never rounded, and the account never replaced with an alias. */
export function exactPayment(request: Record<string, unknown>, book: readonly AssetInfo[]) {
  const { amount: raw, asset, recipient } = request;
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || typeof asset !== "string" || typeof recipient !== "string") return "Payment terms unavailable";
  const token = assetInfo(asset, book);
  return `${token ? `${fromUnits(raw, token.decimals)} ${token.symbol}` : `${raw} raw units of ${asset}`} to ${recipient}`;
}

/** A money action's request in words: what moves, how much, and to whom. */
export function describeRequest(request: Record<string, unknown>, book: readonly AssetInfo[], nameOf: (account: string) => string = (a) => a) {
  const r = request as Partial<Record<"origin_asset" | "destination_asset" | "asset" | "amount" | "recipient", string>>;
  return r.origin_asset && r.destination_asset && r.amount
    ? `${amountOf(r.amount, r.origin_asset, book)} → ${symbolOf(r.destination_asset, book)}`
    : r.asset && r.amount
      ? `${amountOf(r.amount, r.asset, book)}${r.recipient ? ` to ${nameOf(r.recipient)}` : ""}`
      : JSON.stringify(request);
}

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

/** "1500000" at 6 decimals → "1.5", exactly. */
export function fromUnits(raw: string, decimals: number) {
  const digits = raw.padStart(decimals + 1, "0");
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${digits.slice(0, digits.length - decimals)}${fraction ? `.${fraction}` : ""}`;
}

/** A linked account's balances from `treasury/get`, which sends both raw: NEAR in yoctoNEAR (24 decimals), USDC at 6. */
export const linkedBalances = (balances: { near: string; usdc: string }) =>
  ({ near: fromUnits(balances.near, 24), usdc: fromUnits(balances.usdc, 6) });

/**
 * One colour per asset (#193), the theme's `--asset-*` variables (`theme/tokens.css`): wNEAR teal, USDC blue, ETH
 * violet. Any other asset is amber, and a second other pink: `other` counts the other assets before it in what's shown.
 */
const ASSET_TONE: Record<string, string> = { wNEAR: "wnear", NEAR: "wnear", USDC: "usdc", ETH: "eth" };
const OTHER_TONES = ["other", "other-2"] as const;
// Spelled out, so Tailwind finds each class in the source.
const ASSET_BG: Record<string, string> = {
  wnear: "bg-asset-wnear", usdc: "bg-asset-usdc", eth: "bg-asset-eth", other: "bg-asset-other", "other-2": "bg-asset-other-2",
};
const toneOf = (symbol: string, other: number) => ASSET_TONE[symbol] ?? OTHER_TONES[other % OTHER_TONES.length]!;
/** An asset's colour as a CSS value, `var(--asset-…)`, for a style (a chart's fill, a swatch's border). */
export const assetTone = (symbol: string, other = 0) => `var(--asset-${toneOf(symbol, other)})`;
/** An asset's colour as a background class (`bg-asset-usdc`), for a swatch or a meter's segment. */
export const assetColor = (symbol: string, other = 0) => ASSET_BG[toneOf(symbol, other)]!;
