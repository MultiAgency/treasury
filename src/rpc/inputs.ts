import { z } from "zod";
import { intentsAccount, validIntentsAccount } from "../intents-account.js";
export const run = z.object({ execute: z.boolean() });
export const account = z.string().trim().min(2).max(64);
// Only owner-entered Intents destinations: owner identities and provider evidence stay unchanged.
export const transferAccount = z.string().transform(intentsAccount).refine(validIntentsAccount, "Enter a NEAR Intents account or nearcom: address");
export const units = z.string().regex(/^[0-9]{1,40}$/, "an atomic integer amount");
/** A USD amount in the policy's budget; null leaves that window uncapped. */
export const usdAmount = z.string().regex(/^\d+(\.\d+)?$/).nullable();
/** Per-asset caps in raw units. */
export const caps = z.record(z.string(), units);

export const reviewedPolicy = z.object({ revision: z.number().int().nonnegative(), digest: z.string().regex(/^sha256:[0-9a-f]{64}$/) });
