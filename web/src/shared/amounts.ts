/** "1500000" at 6 decimals → "1.5", exactly. */
export function fromUnits(raw: string, decimals: number) {
  const digits = raw.padStart(decimals + 1, "0");
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${digits.slice(0, digits.length - decimals)}${fraction ? `.${fraction}` : ""}`;
}
