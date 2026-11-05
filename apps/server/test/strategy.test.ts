import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { AuditEntry } from "../src/audit.ts";
import * as contract from "../src/contract.ts";
import { createDaoRequests } from "../src/dao-requests.ts";
import { standInDaos } from "../src/dao.ts";
import { createServer } from "../src/http.ts";
import { standInKeyLookup } from "../src/keys.ts";
import { createSessions } from "../src/sessions.ts";
import { createSignIn } from "../src/signin.ts";
import { fakePlatform, HOST, ORIGIN, wallet } from "./fakes.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const owner = wallet("owner.near");
const fake = fakePlatform({ portfolio: "owner.near" });
const audit: AuditEntry[] = [];
const DIGEST = `sha256:${"a".repeat(64)}`;
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", WNEAR = "nep141:wrap.near", ETH = "nep141:eth.omft.near";
const strategy = { targetBps: { [USDC]: 5_000, [WNEAR]: 2_500, [ETH]: 2_500 }, minLegUsd: 2, maxCostBps: 250, autopilot: { everyMin: 60, maxUsd: 0 } };
let server: Server, base: string, cookie: string;

before(async () => {
  server = createHttpServer(createServer({
    platform: fake.platform,
    signIn: createSignIn({ recipient: HOST, ttlMs: 5 * 60_000, perMinute: 1_000, keyLookup: standInKeyLookup({ [owner.accountId]: [owner.publicKey] }) }),
    sessions: createSessions({ idleMs: 30 * 60_000, maxMs: 12 * 60 * 60_000 }),
    publicOrigin: ORIGIN, deployment: "treasury", trustedProxyHops: 0, ownerRequestsPerMinute: 1_000,
    audit: { append: async entry => { audit.push(entry); } }, consentsPerDay: 1_000, daoFilingsPerDay: 1_000, keyLookup: async () => "full",
    daos: standInDaos({}), daoRequests: await createDaoRequests(join(tempDir("treasury-strategy-"), "dao-requests.json")),
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const issued = await (await fetch(`${base}/api/session/challenge`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" })).json() as any;
  cookie = (await fetch(`${base}/api/session`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(owner.sign(issued.value)) }))
    .headers.get("set-cookie")!.split(";")[0]!;
});
after(() => server.close());

const call = async (method: "GET" | "POST", body?: unknown) => {
  const response = await fetch(`${base}/api/agents/portfolio/strategy`, { method, headers: { cookie, ...(method === "POST" && { origin: ORIGIN, "content-type": "application/json" }) },
    ...(method === "POST" && { body: JSON.stringify(body) }) });
  return { status: response.status, text: await response.clone().text(), body: await response.json() as any };
};
const saves = () => fake.calls.filter(made => made.startsWith("autopilot.save"));
const reset = () => { fake.calls.length = 0; audit.length = 0; fake.schedules.portfolio = { on: true }; };

test("a strategy saved over the one the owner saw: autopilot off, the grant no longer binding it, its new digest answered and recorded", async () => {
  reset();
  const saved = await call("POST", { strategy, expectedDigest: DIGEST });
  assert.equal(saved.status, 200, saved.text);
  const { digest } = contract.strategySaved.parse(saved.body.value);
  const read = contract.strategyRead.parse((await call("GET")).body.value);
  assert.deepEqual([read.digest, read.on, read.grantMatches, read.strategy.targetBps], [digest, false, false, strategy.targetBps]);
  assert.deepEqual(saves(), [`autopilot.save owner--near portfolio ${DIGEST}`]);
  assert.deepEqual(audit.map(entry => [entry.action, entry.stage]), [["strategy-save", "attempt"], ["strategy-save", "result"]]);
});

test("a strategy the platform wouldn't take is refused before anything is asked or recorded", async () => {
  reset();
  const cases: [string, unknown][] = [
    ["targets not adding up", { ...strategy, targetBps: { [USDC]: 5_000, [WNEAR]: 2_500, [ETH]: 2_000 } }],
    ["a managed asset left out", { ...strategy, targetBps: { [USDC]: 5_000, [WNEAR]: 5_000 } }],
    ["an asset it doesn't manage", { ...strategy, targetBps: { ...strategy.targetBps, "nep141:usdt.tether-token.near": 0 } }],
    ["a fractional basis point", { ...strategy, targetBps: { [USDC]: 4_999.5, [WNEAR]: 2_500.5, [ETH]: 2_500 } }],
    ["a cost over 10%", { ...strategy, maxCostBps: 1_001 }],
    ["runs more often than every 5 minutes", { ...strategy, autopilot: { everyMin: 4, maxUsd: 0 } }],
    ["a field the platform doesn't know", { ...strategy, extra: 1 }],
  ];
  for (const [label, bad] of cases)
    assert.deepEqual((await call("POST", { strategy: bad, expectedDigest: DIGEST })).body, { ok: false, kind: "refused", code: "bad_request" }, label);
  assert.deepEqual((await call("POST", { strategy, expectedDigest: "abc" })).body, { ok: false, kind: "refused", code: "bad_request" }, "no digest");
  assert.deepEqual([saves(), audit], [[], []]);
});

test("a refusal is strategy_changed when the strategy changed since the owner saw it, and strategy_refused otherwise, never the platform's text", async () => {
  reset();
  fake.schedules.portfolio = { on: false, digest: `sha256:${"c".repeat(64)}` };
  fake.autopilotAnswers.save = [{ ok: false, kind: "refused", status: 409, error: "digest mismatch: secret" }, { ok: false, kind: "refused", status: 400, error: "nope: secret" }];
  const changed = await call("POST", { strategy, expectedDigest: DIGEST });
  assert.deepEqual(changed.body, { ok: false, kind: "refused", code: "strategy_changed" });
  const refusedSave = await call("POST", { strategy, expectedDigest: `sha256:${"c".repeat(64)}` });
  assert.deepEqual(refusedSave.body, { ok: false, kind: "refused", code: "strategy_refused" });
  assert.ok(![changed.text, refusedSave.text].some(text => text.includes("secret")));
  fake.autopilotAnswers.save = [new Error("socket hang up")];
  assert.equal((await call("POST", { strategy, expectedDigest: DIGEST })).status, 503);
  assert.equal(audit.filter(entry => entry.stage === "result").length, 3, "each recorded");
});
