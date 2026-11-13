/** Legacy API replies carry raw residuals too: classify their sign without claiming full history coverage. */
export function confidentialStanding(raw: string) {
  if (!/^-?\d+$/.test(raw)) return "History unavailable";
  const value = BigInt(raw);
  return value === 0n ? "Recorded balance matches" : value > 0n ? "Incoming history incomplete" : "Balance below recorded funds";
}

/** Retain the weaker trust label when any applied credit is an operator attestation. */
export function incomingCreditBasis(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("credits" in value) || !Array.isArray(value.credits) || !value.credits.length) return null;
  const credits = value.credits;
  if (!credits.every(c => c && typeof c === "object" && (c.evidence === "operator-receipt" || c.evidence === "provider-status"))) return "Incoming credit evidence unavailable";
  return credits.some(c => c.evidence === "operator-receipt") ? "Includes operator-attested funding receipts" : "Includes provider-reported funding credits";
}
