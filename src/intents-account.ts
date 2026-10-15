/** near.com displays an Intents account with this prefix; the API takes the bare account. */
export const isNearcomAddress = (value: string) => /^nearcom:/i.test(value.trim());

/** Normalize owner-entered transfer destinations, never signed/provider evidence or chain addresses. */
export function intentsAccount(value: string): string {
  const trimmed = value.trim();
  return isNearcomAddress(trimmed) ? trimmed.slice("nearcom:".length).toLowerCase() : trimmed;
}

export const validIntentsAccount = (value: string) =>
  /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
