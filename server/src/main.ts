import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "./config.ts";
import { createCredential } from "./credential.ts";
import { createServer } from "./http.ts";
import { chainKeyLookup, rpcUrlFor } from "./keys.ts";
import { createPlatform } from "./platform.ts";
import { createSessions } from "./sessions.ts";
import { createSignIn } from "./signin.ts";

const { settings, secrets } = loadConfig();
const credential = createCredential(settings.TREASURY_CREDENTIAL_FILE);
credential.get(); // Refuse to start without a readable 0600 credential.

const rpcUrl = rpcUrlFor(settings.NEAR_RPC_URL, secrets.FASTNEAR_API_KEY);
const handler = createServer({
  platform: createPlatform({ origin: settings.TREASURY_PLATFORM_ORIGIN, credential, timeoutMs: settings.PLATFORM_TIMEOUT_MS }),
  signIn: createSignIn({
    recipient: new URL(settings.TREASURY_PUBLIC_ORIGIN).host,
    keyLookup: chainKeyLookup({ rpcUrl, apiKey: secrets.FASTNEAR_API_KEY, timeoutMs: settings.CHAIN_TIMEOUT_MS }),
    ttlMs: settings.CHALLENGE_TTL_MS,
    perMinute: settings.CHALLENGES_PER_MINUTE,
  }),
  sessions: createSessions({ idleMs: settings.SESSION_IDLE_MS, maxMs: settings.SESSION_MAX_MS }),
  publicOrigin: settings.TREASURY_PUBLIC_ORIGIN,
});

const server = createHttpServer(handler).listen(settings.PORT, () => {
  const { port } = server.address() as AddressInfo;
  console.log(JSON.stringify({ listening: port, platform: settings.TREASURY_PLATFORM_ORIGIN, rpc: new URL(rpcUrl).host }));
});

// On shutdown, take no new requests and let the ones in flight finish.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
