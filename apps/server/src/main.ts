import { createServer as createHttpServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { fileAudit } from "./audit.ts";
import { loadConfig } from "./config.ts";
import { createCredential } from "./credential.ts";
import { createServer } from "./http.ts";
import { createDaoReader, runDaoReader } from "./dao-reader.ts";
import { createDaoRequests } from "./dao-requests.ts";
import { createSettle } from "./dao-settle.ts";
import { chainDaos } from "./dao.ts";
import { chainKeyLookup, rpcUrlFor } from "./keys.ts";
import { loadPage } from "./page.ts";
import { createPlatform } from "./platform.ts";
import { createRequests } from "./requests.ts";
import { createSessions } from "./sessions.ts";
import { createSignIn } from "./signin.ts";
import { loadWatchConfig } from "./watch-config.ts";
import { createWatch, runWatch } from "./watch.ts";

const { settings, secrets } = loadConfig();
const credential = createCredential(settings.TREASURY_CREDENTIAL_FILE);
await credential.get(); // Refuse to start without a readable 0600 credential.
const audit = fileAudit(settings.TREASURY_AUDIT_FILE);
await audit.check(); // Refuse to start without an audit trail it can append to.

const sessions = createSessions({ idleMs: settings.SESSION_IDLE_MS, maxMs: settings.SESSION_MAX_MS });
// Ended sessions are also swept every minute, so abandoned ones don't accumulate between sign-ins.
setInterval(sessions.sweep, 60_000).unref();

const rpcUrl = rpcUrlFor(settings.NEAR_RPC_URL, secrets.FASTNEAR_API_KEY);
const keyLookup = chainKeyLookup({ rpcUrl, apiKey: secrets.FASTNEAR_API_KEY, timeoutMs: settings.CHAIN_TIMEOUT_MS });
const daos = chainDaos({ rpcUrl, apiKey: secrets.FASTNEAR_API_KEY, timeoutMs: settings.CHAIN_TIMEOUT_MS });
// Refuse to start with watch named but its agents or its stored requests unreadable, or past the read budget.
const watched = settings.TREASURY_WATCH_FILE ? {
  agents: await loadWatchConfig(settings.TREASURY_WATCH_FILE),
  requests: await createRequests(settings.TREASURY_REQUESTS_FILE!),
} : undefined;

// Refuse to start with the DAO requests unreadable.
const daoRequests = await createDaoRequests(settings.TREASURY_DAO_REQUESTS_FILE);

// One platform client for the routes and watch, so they share the identity cache and the credential's reads.
const platform = createPlatform({ origin: settings.TREASURY_PLATFORM_ORIGIN, credential, timeoutMs: settings.PLATFORM_TIMEOUT_MS });
// One settle for the routes and the reader, so reads of the same DAO request at once share one.
const settle = createSettle({ platform, daoRequests, audit });
const handler = createServer({
  platform,
  signIn: createSignIn({
    recipient: new URL(settings.TREASURY_PUBLIC_ORIGIN).host,
    keyLookup,
    ttlMs: settings.CHALLENGE_TTL_MS,
    perMinute: settings.CHALLENGES_PER_MINUTE,
  }),
  sessions,
  publicOrigin: settings.TREASURY_PUBLIC_ORIGIN,
  deployment: settings.TREASURY_DEPLOYMENT,
  trustedProxyHops: settings.TREASURY_TRUSTED_PROXY_HOPS,
  ownerRequestsPerMinute: settings.OWNER_REQUESTS_PER_MINUTE,
  audit,
  consentsPerDay: settings.CONSENTS_PER_DAY,
  daoFilingsPerDay: settings.DAO_FILINGS_PER_DAY,
  keyLookup,
  daos,
  daoRequests,
  settle,
  // Refuse to start without the page's files when a build is named.
  ...(settings.TREASURY_PAGE_DIR && { page: await loadPage(settings.TREASURY_PAGE_DIR) }),
});

const server = createHttpServer(handler).listen(settings.PORT, () => {
  const { port } = server.address() as AddressInfo;
  console.log(JSON.stringify({ listening: port, platform: settings.TREASURY_PLATFORM_ORIGIN, rpc: new URL(rpcUrl).host }));
});

// watch proposes for its agents beside the routes, through its own narrow view of the platform.
const shutdown = new AbortController();
const watching = watched
  ? runWatch({
    watch: createWatch({ platform: platform.watch, requests: watched.requests, publicOrigin: settings.TREASURY_PUBLIC_ORIGIN }),
    agents: watched.agents,
    log: event => console.log(JSON.stringify({ event: "watch", ...event })),
    sleep: (ms, signal) => delay(ms, undefined, { signal }).catch(() => {}),
    signal: shutdown.signal,
  })
  : Promise.resolve();

// The DAO requests still open are read on their own interval, watch or not: a vote that passed is completed only when
// it's read, and only until what the DAO signed expires.
const reading = runDaoReader({
  read: createDaoReader({ daoRequests, settle }, { limit: settings.DAO_READS_PER_PASS }).pass,
  everyMs: settings.DAO_READ_INTERVAL_MS,
  log: event => console.log(JSON.stringify({ event: "dao_read", ...event })),
  sleep: (ms, signal) => delay(ms, undefined, { signal }).catch(() => {}),
  signal: shutdown.signal,
});

// On shutdown, take no new requests and start no tick or read, and let those in flight finish.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    shutdown.abort();
    server.close(() => { void Promise.all([watching, reading]).then(() => process.exit(0)); });
  });
}
