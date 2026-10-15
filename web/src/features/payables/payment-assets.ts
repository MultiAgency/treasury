import { ASSETS } from "../../../../src/policy";
import type { Holding } from "../../shared/format";

/** Payout and invoice grants can transfer confidential USDC only. */
export function paymentAssets(book: Holding[], label?: string) {
  return label === "payout" || label === "invoices" ? book.filter(h => h.asset === ASSETS.USDC) : book;
}
