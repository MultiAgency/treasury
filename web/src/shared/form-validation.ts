/** Client-side feedback only. Server/provider authorization remains authoritative. */
import { intentsAccount, validIntentsAccount } from "../../../src/intents-account.js";

export const payeeError = (value: string) => validIntentsAccount(intentsAccount(value))
  ? undefined : "Enter a NEAR Intents account or near.com address, for example nearcom:payee.near.";

export const accountError = (value: string) =>
  /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value.trim()) ? undefined : "Enter a NEAR account, for example payee.near.";

export const deadlineError = (value: string, now = Date.now()) => {
  const date = new Date(`${value}T23:59:59.999Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && date.getTime() > now
    ? undefined : "Choose today or a later date. Terms end at 23:59:59 UTC.";
};
