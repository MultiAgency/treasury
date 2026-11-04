/** Client-side feedback only. Server/provider authorization remains authoritative. */
export const accountError = (value: string) =>
  /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value.trim()) ? undefined : "Enter a NEAR account, for example payee.near.";
