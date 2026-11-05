// The server against the platform's stack with a DAO-owned Treasury agent (platform at PLATFORM_COMMIT,
// `--dao-treasury --app`): a real gateway, its simulated Sputnik DAO and chain, and the `daoVote` control standing in
// for a proposal that passes. The DAO's members sign in with their own keys, which the server's key check stands in for;
// their membership is the DAO's policy, read from the stack's chain.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { appClient, type ProposalView } from "@multiagency/sdk";
import { daoVote, stackFetch, startStack, USDC, WNEAR, type Stack } from "../../../scripts/stack.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";
import { chainedFileAudit } from "../src/chain.ts";
import * as contract from "../src/contract.ts";
import { createCredential } from "../src/credential.ts";
import { chainDaos } from "../src/dao.ts";
import { createDaoReader } from "../src/dao-reader.ts";
import { createDaoRequests, type DaoRequests } from "../src/dao-requests.ts";
import { createSettle } from "../src/dao-settle.ts";
import { createServer } from "../src/http.ts";
import { standInKeyLookup } from "../src/keys.ts";
import { createPlatform } from "../src/platform.ts";
import { createSessions } from "../src/sessions.ts";
import { createSignIn } from "../src/signin.ts";
import { HOST, ORIGIN, wallet } from "./fakes.ts";

// The store the server records through (`main.ts`): a hash chain, checked before the first append.
const audit = chainedFileAudit(join(tempDir("treasury-dao-stack-"), "audit.jsonl"));
let stack: Awaited<ReturnType<typeof startStack>>, target: Stack, server: Server, base: string;
let council: ReturnType<typeof wallet>, member: ReturnType<typeof wallet>, dao: string;
let daoRequests: DaoRequests, settle: ReturnType<typeof createSettle>;

before(async () => {
  await audit.check();
  stack = await startStack({ owner: "dao", args: ["--no-browser", "--app", "treasury-test"] });
  target = stack.target;
  const state = stack.state();
  assert.ok(state.app && state.dao, "the stack was started with --dao-treasury --app");
  assert.deepEqual([state.treasury.owner, state.treasury.signer], [state.dao.account, "dao"]);
  dao = state.dao.account;
  council = wallet(state.dao.council);
  member = wallet(state.dao.member);
  const platform = createPlatform({ origin: state.dashboard, credential: createCredential(state.app.credentialFile), timeoutMs: 15_000, fetch: stackFetch(readFileSync(target.ca)) });
  daoRequests = await createDaoRequests(join(tempDir("treasury-dao-requests-"), "dao-requests.json"));
  settle = createSettle({ platform, daoRequests, audit });
  const keyLookup = standInKeyLookup({ [council.accountId]: [council.publicKey], [member.accountId]: [member.publicKey] });
  server = createHttpServer(createServer({
    platform,
    signIn: createSignIn({ recipient: HOST, ttlMs: 5 * 60_000, perMinute: 100, keyLookup }),
    sessions: createSessions({ idleMs: 30 * 60_000, maxMs: 12 * 60 * 60_000 }),
    publicOrigin: ORIGIN,
    deployment: state.app.deployment,
    ownerRequestsPerMinute: 1_000,
    trustedProxyHops: 0,
    audit,
    consentsPerDay: 1_000, daoFilingsPerDay: 1_000,
    keyLookup,
    daos: chainDaos({ rpcUrl: state.chain.rpc, apiKey: undefined, timeoutMs: 5_000 }),
    daoRequests, settle,
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, { timeout: 180_000 });

after(async () => {
  server?.close();
  await stack?.stop();
});

const call = async (method: "GET" | "POST", path: string, cookie: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, { method, headers: { cookie, ...(method === "POST" && { origin: ORIGIN, "content-type": "application/json" }) },
    ...(method === "POST" && { body: JSON.stringify(body ?? {}) }) });
  return { status: response.status, body: await response.json() as { ok: boolean; value?: unknown; kind?: string; code?: string } };
};
async function signIn(who: ReturnType<typeof wallet>) {
  const issued = await fetch(`${base}/api/session/challenge`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" });
  const { value } = await issued.json() as { value: { message: string; recipient: string; nonce: string } };
  const signedIn = await fetch(`${base}/api/session`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(who.sign(value)) });
  assert.equal(signedIn.status, 200, await signedIn.clone().text());
  return signedIn.headers.get("set-cookie")!.split(";")[0]!;
}
/** The NEP-413 hash the member's transaction asks the DAO to sign: the argument of its proposal's `v1.signer` call. */
function hashOf(request: { offer: unknown }): string {
  const offer = request.offer as { state: string; transaction: { actions: { params: { args: { proposal: { kind: { FunctionCall: { actions: { args: string }[] } } } } } }[] } };
  assert.equal(offer.state, "file", JSON.stringify(offer));
  const args = JSON.parse(Buffer.from(offer.transaction.actions[0]!.params.args.proposal.kind.FunctionCall.actions[0]!.args, "base64").toString());
  return args.request.payload_v2.Eddsa;
}
const agentPath = () => `/api/agents/${target.agent}`;

test("a council member reads the DAO's agent; a member who may only vote reads it but is refused filing", async () => {
  const read = await call("GET", agentPath(), await signIn(council));
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const agent = contract.agent.parse(read.body.value);
  assert.equal(agent.owner, dao);
  const voter = await signIn(member);
  assert.equal((await call("GET", agentPath(), voter)).status, 200, "a voter is a member too");
  const filed = await call("POST", `${agentPath()}/consent/text`, voter);
  assert.deepEqual({ status: filed.status, body: filed.body }, { status: 403, body: { ok: false, kind: "refused", code: "not_permitted" } });
});

test("a council member files the DAO's consent once; after its vote passes, reading the connection stores it", async () => {
  const cookie = await signIn(council);
  const filed = await call("POST", `${agentPath()}/consent/text`, cookie);
  assert.equal(filed.status, 200, JSON.stringify(filed.body));
  const { request } = contract.daoFiled.parse(filed.body.value);
  const again = contract.daoFiled.parse((await call("POST", `${agentPath()}/consent/text`, cookie)).body.value);
  assert.equal(again.request.id, request.id, "filed again, the open request answers");
  const pending = contract.consent.parse((await call("GET", `${agentPath()}/consent`, cookie)).body.value);
  assert.equal(pending.consent, null, "nothing stored before the vote");
  await daoVote(target, hashOf(request));
  const connected = contract.consent.parse((await call("GET", `${agentPath()}/consent`, cookie)).body.value);
  assert.ok(connected.consent, "stored once the vote passed");
  assert.deepEqual(connected.consent.scopes, ["read", "treasury"]);
});

test("the DAO approves one proposal and rejects another: a read relays the first, the background reader the second", async () => {
  const cookie = await signIn(council);
  const state = stack.state();
  const app = appClient({ base: state.dashboard as `https://${string}`, credential: readFileSync(state.app!.credentialFile, "utf8").trim(), fetch: stackFetch(readFileSync(target.ca)) });
  const calls = app.agent(dao.replaceAll(".", "--"), target.agent);
  const propose = async (requestId: string) => {
    const made = await calls.call("proposals/create", { requestId, legs: [{ from: USDC, to: WNEAR, amount: "1000000" }], expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    assert.ok(made.ok, JSON.stringify(made));
    return made.value as ProposalView;
  };
  const first = await propose(`dao-stack-${Date.now()}-1`), second = await propose(`dao-stack-${Date.now()}-2`);

  const approve = await call("POST", `${agentPath()}/proposals/${first.id}/approve`, cookie);
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  const vote = contract.daoFiled.parse(approve.body.value).request;
  assert.equal(vote.verdict, "approve");
  await daoVote(target, hashOf(vote));
  const relayed = contract.proposalRead.parse((await call("GET", `${agentPath()}/proposals/${first.id}`, cookie)).body.value);
  assert.equal(relayed.proposal.state, "approved", "the passed vote is relayed when the proposal is read");

  const reject = await call("POST", `${agentPath()}/proposals/${second.id}/reject`, cookie);
  await daoVote(target, hashOf(contract.daoFiled.parse(reject.body.value).request));
  await createDaoReader({ daoRequests, settle }, { limit: 5 }).pass();
  const read = await calls.call("proposals/get", { id: second.id });
  assert.ok(read.ok, JSON.stringify(read));
  assert.equal((read.value as ProposalView).state, "rejected", "relayed with nobody reading the page");
});

test("the DAO's council reads the DAO as the funding account and gets a deposit address; no member links another account", async () => {
  const cookie = await signIn(council);
  const read = await call("GET", `${agentPath()}/treasury`, cookie);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(contract.treasuryRead.parse(read.body.value).treasury?.accountId, dao, "fixed at setup");
  const deposit = await call("POST", `${agentPath()}/deposit`, cookie, { asset: "USDC" });
  assert.equal(deposit.status, 200, JSON.stringify(deposit.body));
  contract.depositRead.parse(deposit.body.value);
  assert.deepEqual((await call("POST", `${agentPath()}/treasury/link`, cookie, { accountId: council.accountId })).body,
    { ok: false, kind: "refused", code: "dao_funding_fixed" }, "the stack's council has every DAO permission");
});
