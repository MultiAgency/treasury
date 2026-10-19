import type { RefusalDetails } from "@multiagency/sdk";

/** Metadata describes the provider's observation; a time never grants permission to repeat a payment. */
export function providerDetailText(details?: RefusalDetails | null): string {
  const parts: string[] = [];
  if (typeof details?.budgetRemainingUsd === "string" && /^\d{1,12}(\.\d{1,18})?$/.test(details.budgetRemainingUsd))
    parts.push(`Provider-reported budget remaining: ${details.budgetRemainingUsd} USD.`);
  if (typeof details?.availableAt === "string" && details.availableAt.length <= 40 && Number.isFinite(Date.parse(details.availableAt)))
    parts.push(`Provider-reported availability: ${new Date(details.availableAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}. Check the current state before another action.`);
  return parts.join(" ");
}

export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const extra = providerDetailText((error as Error & { data?: RefusalDetails }).data);
  return extra ? `${error.message.replace(/\.?\s*$/, ".")} ${extra}` : error.message;
}
