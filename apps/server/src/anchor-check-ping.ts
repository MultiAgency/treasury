import { setTimeout as wait } from "node:timers/promises";

// One check's bearer URL, never a project ping key, query, alternate host or redirect destination.
const PING_URL = /^https:\/\/hc-ping\.com\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Options = { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> };

/** Success-only heartbeat after the independent anchor check; sends no application data and logs no credential. */
export async function pingAnchorCheck(value: string | undefined, { fetch: send = fetch, sleep = wait }: Options = {}) {
  const url = value?.trim();
  if (!url) return "not_configured";
  if (!PING_URL.test(url)) throw new Error("Invalid audit monitor ping URL.");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await send(url, { method: "POST", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(10_000) });
      // Reject unknown/rate-limited responses even when HTTP 200. Exact OK means API acceptance;
      // operators must still verify an unpaused check, disabled content filtering and a success event.
      if (response.status === 200 && await response.text() === "OK") return "sent";
    } catch { /* Network errors can contain the bearer URL: never print them. A repeated success ping is harmless. */ }
    if (attempt < 2) await sleep(1_000);
  }
  throw new Error("Audit monitor heartbeat was not accepted.");
}

export async function main(env: NodeJS.ProcessEnv, out: (line: string) => void, options?: Options): Promise<number> {
  try {
    const result = await pingAnchorCheck(env.ANCHOR_CHECK_PING_URL, options);
    out(result === "sent" ? "Audit monitor heartbeat accepted."
      : "::notice::Audit monitor heartbeat is not configured: ANCHOR_CHECK_PING_URL is unset; missing-run alerts are inactive.");
    return 0;
  } catch {
    out("::error::Audit monitor heartbeat failed. Check the ping URL and service availability; no heartbeat was confirmed.");
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.env, line => console.log(line));
