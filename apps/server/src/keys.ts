import { AccessKeyDoesNotExistError, AccountDoesNotExistError, Near } from "near-kit";
import type { Secret } from "./config.ts";

/** Whether `publicKey` is a full-access key of `accountId` now; `unavailable` when the chain didn't answer in time. */
export type KeyState = "full" | "limited" | "none" | "unavailable";
export type KeyLookup = (accountId: string, publicKey: string) => Promise<KeyState>;

/**
 * FastNEAR's hosts, the only ones the API key is sent to (the platform's `src/fastnear.ts`), with testnet's, where the
 * anchors are sent and read back (`ANCHOR_NETWORKS`): its archival RPC answers nothing without a key.
 */
const FASTNEAR_HOSTS = new Set(["rpc.mainnet.fastnear.com", "archival-rpc.mainnet.fastnear.com", "free.rpc.fastnear.com",
  "rpc.testnet.fastnear.com", "archival-rpc.testnet.fastnear.com"]);

/** The RPC the platform's `src/chain.ts` uses: `NEAR_RPC_URL`, else FastNEAR's keyed RPC, else its free one. */
export function rpcUrlFor(override: string | undefined, apiKey: Secret | undefined) {
  return override ?? (apiKey ? "https://rpc.mainnet.fastnear.com" : "https://free.rpc.fastnear.com");
}

/** The FastNEAR key as a Bearer header, only for FastNEAR's own hosts over HTTPS. */
export function rpcHeaders(rpcUrl: string, apiKey: Secret | undefined): Record<string, string> {
  const url = new URL(rpcUrl);
  return apiKey && url.protocol === "https:" && !url.username && !url.password && !url.port && FASTNEAR_HOSTS.has(url.hostname)
    ? { Authorization: `Bearer ${apiKey.reveal()}` } : {};
}

/** The part of near-kit's RPC client the lookup uses: it throws typed errors for a missing key or account. */
export type AccessKeyRpc = { getAccessKey(accountId: string, publicKey: string, options: { finality: "final" }): Promise<{ permission: unknown }> };

/**
 * The chain's answer through near-kit's RPC client, at final finality. A missing key or account is `none`, a key that
 * isn't `"FullAccess"` is `limited`, and anything else (a network error, a timeout) is `unavailable`. `Near.getAccessKey`
 * isn't used: it turns every error into `null`, so an outage would read as a missing key. One retry at most and a
 * timeout, so a slow RPC makes sign-in fail rather than hang.
 */
export function chainKeyLookup({ rpcUrl, apiKey, timeoutMs, rpc }: {
  rpcUrl: string; apiKey: Secret | undefined; timeoutMs: number; rpc?: AccessKeyRpc;
}): KeyLookup {
  const client = rpc ?? new Near({ network: { networkId: "mainnet", rpcUrl }, headers: rpcHeaders(rpcUrl, apiKey), retryConfig: { maxRetries: 1, initialDelayMs: 250 } }).rpc;
  return async (accountId, publicKey) => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
    try {
      const key = await Promise.race([client.getAccessKey(accountId, publicKey, { finality: "final" }), timeout]);
      if (key === "timeout") return "unavailable";
      return key.permission === "FullAccess" ? "full" : "limited";
    } catch (error) {
      // An invalid account ID never gets here: `contract.accountId` refuses it before any lookup.
      const missing = error instanceof AccessKeyDoesNotExistError || error instanceof AccountDoesNotExistError;
      return missing ? "none" : "unavailable";
    } finally {
      clearTimeout(timer);
    }
  };
}

/** A fixed set of full-access keys per account: for tests and for the platform's stack, whose chain RPC isn't published. */
export function standInKeyLookup(fullAccess: Record<string, readonly string[]>): KeyLookup {
  return async (accountId, publicKey) => fullAccess[accountId]?.includes(publicKey) ? "full" : "none";
}
