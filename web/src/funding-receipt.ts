export type FundingReceipt = { account: string; amount: string; symbol: string; address: string; dao: boolean; at: string; state: "submitted" | "unknown" };
export function readReceipt(key: string, storage: Pick<Storage, "getItem"> | undefined): FundingReceipt | undefined {
  try {
    const value = JSON.parse(storage?.getItem(key) ?? "null");
    if (value && ["submitted", "unknown"].includes(value.state) && typeof value.dao === "boolean" &&
      [value.account, value.amount, value.symbol, value.address, value.at].every(item => typeof item === "string") && Number.isFinite(Date.parse(value.at))) return value;
  } catch { /* Storage may be unavailable. The in-memory receipt still works. */ }
  return undefined;
}

/** Forgets a receipt the owner has checked and cleared. Storage may be unavailable: the page drops its own copy either way. */
export function clearReceipt(key: string, storage: Pick<Storage, "removeItem"> | undefined): void {
  try { storage?.removeItem(key); } catch { /* Nothing was stored, or it can't be reached: there is nothing to forget. */ }
}
