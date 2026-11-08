import { createServer as createHttpServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { ANCHOR_NETWORKS, anchorKey, createAnchorer, nearAnchorChain, readAnchorKey, runAnchor, type AnchorEntry } from "./anchor.ts";
import type { AuditEntry } from "./audit.ts";
import { createAgentTokens, fileTokenRecords, memoryTokenRecords } from "./agent-tokens.ts";
import { chainedFileAudit, movePlainLogAside } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { createCredential } from "./credential.ts";
import { createServer } from "./http.ts";
import { createDaoReader, runDaoReader } from "./dao-reader.ts";
import { createBallast, createEngineState, createPriceHistory, type DecisionEntry } from "./ballast.ts";
import { createDaoRequests } from "./dao-requests.ts";
import { createSettle } from "./dao-settle.ts";
import { chainDaos } from "./dao.ts";
import { chainKeyLookup, rpcHeaders, rpcUrlFor } from "./keys.ts";
import { loadPage } from "./page.ts";
import { createPlatform } from "./platform.ts";
import { createHolds, createRequests } from "./requests.ts";
import { createSessions } from "./sessions.ts";
import { createSignIn } from "./signin.ts";
import { createStrategyProposals, fileProposalRecords, memoryProposalRecords } from "./strategy-proposals.ts";
import { loadWatchConfig } from "./watch-config.ts";
import { createWatch, runWatch } from "./watch.ts";

const { settings, secrets } = loadConfig();
const credential = createCredential(settings.TREASURY_CREDENTIAL_FILE);
await credential.get(); // Refuse to start without a readable 0600 credential.
// The audit trail is a hash chain (A7, #53). A log in the old plain format is moved aside first (#90), never chained over.
const asidePlain = await movePlainLogAside(settings.TREASURY_AUDIT_FILE);
if (asidePlain) console.log(JSON.stringify({ event: "audit_plain_log_moved", to: asidePlain }));
const audit = chainedFileAudit<AuditEntry | AnchorEntry | DecisionEntry>(settings.TREASURY_AUDIT_FILE);
await audit.check(); // Refuse to start without an audit trail it can append to, or with one whose chain is broken.

const sessions = createSessions({ idleMs: settings.SESSION_IDLE_MS, maxMs: settings.SESSION_MAX_MS });
// Ended sessions are also swept every minute, so abandoned ones don't accumulate between sign-ins.
setInterval(sessions.sweep, 60_000).unref();

const rpcUrl = rpcUrlFor(settings.NEAR_RPC_URL, secrets.FASTNEAR_API_KEY);
const keyLookup = chainKeyLookup({ rpcUrl, apiKey: secrets.FASTNEAR_API_KEY, timeoutMs: settings.CHAIN_TIMEOUT_MS });
const daos = chainDaos({ rpcUrl, apiKey: secrets.FASTNEAR_API_KEY, timeoutMs: settings.CHAIN_TIMEOUT_MS });
// The audit anchor writes to its own account through FastData, under `audit/<deployment>` (A7.3, #55). Testnet anchors
// go to FastNEAR's testnet RPC; sign-in and DAO reads stay on mainnet. Refuse to start without a readable 0600 key.
const anchorNetwork = ANCHOR_NETWORKS[settings.TREASURY_ANCHOR_NETWORK];
const anchorRpcUrl = "rpcUrl" in anchorNetwork ? anchorNetwork.rpcUrl : rpcUrl;
const anchorChain = settings.TREASURY_ANCHOR_ACCOUNT && settings.TREASURY_ANCHOR_KEY_FILE ? nearAnchorChain({
  account: settings.TREASURY_ANCHOR_ACCOUNT, key: anchorKey(settings.TREASURY_DEPLOYMENT),
  signer: await readAnchorKey(settings.TREASURY_ANCHOR_KEY_FILE), networkId: settings.TREASURY_ANCHOR_NETWORK,
  send: { rpcUrl: anchorRpcUrl, headers: rpcHeaders(anchorRpcUrl, secrets.FASTNEAR_API_KEY) },
  archival: { rpcUrl: anchorNetwork.archivalRpcUrl, headers: rpcHeaders(anchorNetwork.archivalRpcUrl, secrets.FASTNEAR_API_KEY) },
  timeoutMs: settings.CHAIN_TIMEOUT_MS,
}) : undefined;
// Refuse to start with watch named but its agents or its stored requests unreadable, or past the read budget.
const watched = settings.TREASURY_WATCH_FILE ? {
  agents: await loadWatchConfig(settings.TREASURY_WATCH_FILE),
  requests: await createRequests(settings.TREASURY_REQUESTS_FILE!),
  // Why each agent was last reported held, beside the requests (`<TREASURY_REQUESTS_FILE>.holds`): a restart doesn't announce it again.
  holds: await createHolds(`${settings.TREASURY_REQUESTS_FILE!}.holds`),
} : undefined;
// Ballast's price history and engine state, beside the requests (`.history`, `.engine`), when any agent runs it (#47).
const ballast = watched?.agents.some(agent => agent.ballast) ? createBallast({
  history: await createPriceHistory(`${settings.TREASURY_REQUESTS_FILE!}.history`),
  states: await createEngineState(`${settings.TREASURY_REQUESTS_FILE!}.engine`),
  // Every decision goes to the audit log with its inputs, so a replay of the log makes the same one (A7.2, #54).
  audit,
}) : undefined;

// Refuse to start with the DAO requests unreadable.
const daoRequests = await createDaoRequests(settings.TREASURY_DAO_REQUESTS_FILE);

// Refuse to start with the agent tokens unreadable; without a file they last as long as the process.
const agentTokens = createAgentTokens(settings.TREASURY_AGENT_TOKENS_FILE ? await fileTokenRecords(settings.TREASURY_AGENT_TOKENS_FILE) : memoryTokenRecords());

// Refuse to start with the strategy proposals unreadable; without a file they last as long as the process.
const strategyProposals = createStrategyProposals(settings.TREASURY_STRATEGY_PROPOSALS_FILE ? await fileProposalRecords(settings.TREASURY_STRATEGY_PROPOSALS_FILE) : memoryProposalRecords(), { audit });

// One platform client for the routes and watch, so they share the identity cache and the credential's reads.
const platform = createPlatform({ origin: settings.TREASURY_PLATFORM_ORIGIN, credential, timeoutMs: settings.PLATFORM_TIMEOUT_MS,
  executeTimeoutMs: settings.PLATFORM_EXECUTE_TIMEOUT_MS });
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
  agentTokens,
  strategyProposals,
  tokenRequestsPerHour: settings.TOKEN_REQUESTS_PER_HOUR,
  tokenBudgetPerHour: settings.TOKEN_BUDGET_PER_HOUR,
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
    watch: createWatch({ platform: platform.watch, requests: watched.requests, holds: watched.holds, publicOrigin: settings.TREASURY_PUBLIC_ORIGIN, ...(ballast && { ballast }), strategyProposals }),
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

// The audit log's head goes on NEAR every interval (A7.3, #55), when an anchor account is configured. A failed anchor
// is logged and tried again next interval; it never stops the server.
const anchoring = anchorChain ? runAnchor({
  anchor: createAnchorer({ audit, file: settings.TREASURY_AUDIT_FILE, chain: anchorChain }),
  everyMs: settings.TREASURY_ANCHOR_INTERVAL_S * 1000,
  log: event => console.log(JSON.stringify({ event: "anchor", ...event })),
  sleep: (ms, signal) => delay(ms, undefined, { signal }).catch(() => {}),
  signal: shutdown.signal,
}) : Promise.resolve();

// On shutdown, take no new requests and start no tick or read, and let those in flight finish.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    shutdown.abort();
    server.close(() => { void Promise.all([watching, reading, anchoring]).then(() => process.exit(0)); });
  });
}
