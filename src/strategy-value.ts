/** A finite Number's shortest decimal representation, without rounding it during addition. */
function decimal(value: number) {
  const [mantissa, exponent = "0"] = value.toString().split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length - Number(exponent) };
}

/**
 * Compare recorded numeric USD estimates exactly as their decimal representations. This does not
 * recover precision lost when each estimate was calculated, or establish provider accounting.
 * Unknown or invalid evidence remains unknown even when the other values already exceed the limit.
 */
export function withinRunCeiling(values: readonly (number | null | undefined)[], maxUsd: number): boolean | null {
  if (typeof maxUsd !== "number" || !Number.isFinite(maxUsd) || maxUsd < 0) return null;
  const limit = decimal(maxUsd);
  const amounts: ReturnType<typeof decimal>[] = [];
  let scale = limit.scale;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    const amount = decimal(value);
    amounts.push(amount);
    scale = Math.max(scale, amount.scale);
  }
  const atScale = (amount: ReturnType<typeof decimal>) => amount.units * 10n ** BigInt(scale - amount.scale);
  const ceiling = atScale(limit);
  let total = 0n;
  for (const amount of amounts) {
    total += atScale(amount);
    if (total > ceiling) return false;
  }
  return true;
}
