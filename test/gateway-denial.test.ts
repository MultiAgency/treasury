import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { mayCall } from "../src/gateway/allowlist.js";
import { consentDescription } from "../src/gateway/dao-consent.js";
import { router } from "../src/router.js";
import { sessionToken } from "../src/signin.js";

/**
 * The real gateway process in front of an instrumented agent server: every call that gets past the
 * gateway is counted there, so a refused call is proven never to reach a handler, let alone the
 * provider. Two agents: one owned by a DAO, whose policy comes from a stand-in RPC, and one owned by a
 * plain account, which the RPC knows no contract for. No membership is changed anywhere.
 */

const SECRET = "test-only-gateway-session-secret-0123456789";
const DAO = "fixture.sputnik-dao.near";
const OWNER = "owner.near";
const policy = {
  proposal_bond: "0",
  roles: [
    { name: "Viewer", kind: { Group: ["member.near"] }, permissions: [], vote_policy: {} },
    { name: "Requestor", kind: { Group: ["requestor.near"] }, permissions: ["call:AddProposal"], vote_policy: {} },
    { name: "Approver", kind: { Group: ["approver.near"] }, permissions: ["call:VoteApprove"], vote_policy: {} },
    { name: "Executor", kind: { Group: ["executor.near"] }, permissions: ["call:*"], vote_policy: {} },
    { name: "Manager", kind: { Group: ["manager.near"] }, permissions: ["policy:*"], vote_policy: {} },
    { name: "Council", kind: { Group: ["council.near"] }, permissions: ["*:*"], vote_policy: {} },
  ],
  default_vote_policy: { threshold: [1, 2] },
};

const reached: string[] = [];
const forwardedCredentials: unknown[] = [];
let walletIdentityUnavailable = false;
let walletAgentId = "a".repeat(64);
let daoAgentId = "a".repeat(64);
/** The DAO's proposals as the stand-in chain stores them (Sputnik `get_proposal`). */
const proposals = new Map<number, unknown>();
let agentServers: Server[], rpcServer: Server, gateway: ChildProcess, base: string, dir: string;

const listen = (server: Server) => new Promise<number>((done) => server.listen(0, "127.0.0.1", () => done((server.address() as AddressInfo).port)));

function paths(node: object, prefix = ""): string[] {
  return Object.entries(node).flatMap(([name, child]) =>
    "~orpc" in child ? [`${prefix}${name}`] : paths(child as object, `${prefix}${name}/`));
}

/** The DAO's MPC key as the stand-in RPC derives it, and so the account that signs as the DAO's agents' owner. */
const DAO_KEY = "ed25519:11111111111111111111111111111111";
const DAO_SIGNER = "0".repeat(64);

/**
 * An agent server whose agent is owned by `owner` (null: not created yet). It counts every call the
 * gateway forwards; the gateway's own owner check (marked `x-gateway`) is answered, not counted.
 */
const agentServer = (owner: string | null) => createServer((req, res) => {
  const path = req.url!.replace(/^\/rpc\//, "");
  if (req.headers["x-gateway"]) {
    if (owner === OWNER && walletIdentityUnavailable) return res.writeHead(503).end();
    const setup = { agentId: owner && (owner === OWNER ? walletAgentId : daoAgentId), owner: owner && { type: "near", account_id: owner } };
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ json: path === "ownerIdentity" ? setup : null }));
  }
  reached.push(path);
  forwardedCredentials.push(req.headers.authorization, req.headers.cookie, req.headers["x-gateway"]);
  res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=3600" }).end('{"json":null}');
});

before(async () => {
  agentServers = [agentServer(DAO_SIGNER), agentServer(OWNER), agentServer(null), agentServer("someone-else.near")];
  rpcServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk)).on("end", () => {
      const { id, params } = JSON.parse(body) as { id: unknown; params: { account_id?: string; method_name?: string; args_base64?: string } };
      const view = (value: unknown) => ({ result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" } });
      // Only the DAO and the MPC signer have contracts; any other account is answered as the chain answers an unknown one.
      const unknown = { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: params.account_id } }, code: -32000, message: "Server error" } };
      const proposal = () => proposals.get(JSON.parse(Buffer.from(params.args_base64 ?? "e30=", "base64").toString()).id);
      const answer = params.account_id === DAO && params.method_name === "get_proposal" ? (proposal() ? view(proposal()) : unknown)
        : params.account_id === DAO ? view(policy) : params.account_id === "v1.signer" ? view(DAO_KEY)
        : { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: params.account_id } }, code: -32000, message: "Server error" } };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, ...answer }));
    });
  });
  const [treasuryPort, walletPort, newPort, strayPort, rpcPort] = await Promise.all([...agentServers.map(listen), listen(rpcServer)]);

  dir = mkdtempSync(join(tmpdir(), "gateway-denial-"));
  const file = join(dir, "dashboard.json");
  writeFileSync(file, JSON.stringify({ host: "dao.test", agents: [
    { name: "treasury", area: "treasury", owner: DAO, operators: ["ops.near"], port: treasuryPort },
    { name: "wallet", area: "treasury", owner: OWNER, operators: ["ops.near"], port: walletPort },
    // Not created yet: its configured owner sets it up.
    { name: "new", owner: OWNER, port: newPort },
    // Configured as OWNER's, but its server reports another owner: closed to everyone.
    { name: "stray", owner: OWNER, operators: ["ops.near"], port: strayPort },
  ] }));
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((done) => probe.close(done));
  gateway = spawn(join(process.cwd(), "node_modules/.bin/tsx"), [join(process.cwd(), "src/gateway/server.ts")], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), DASHBOARD_FILE: file, SESSION_SECRET: SECRET, NEAR_RPC_URL: `http://127.0.0.1:${rpcPort}` },
    stdio: ["ignore", "pipe", "inherit"],
  });
  base = `http://127.0.0.1:${port}`;
  await new Promise<void>((done, fail) => {
    gateway.stdout!.on("data", (chunk: Buffer) => chunk.toString().includes("on port") && done());
    gateway.on("exit", (code) => fail(new Error(`The gateway exited (${code})`)));
  });
});

after(() => {
  gateway?.kill();
  for (const server of agentServers ?? []) server.close();
  rpcServer?.close();
});

const session = (account: string) => ({ cookie: `dao_session=${sessionToken(account, SECRET)}` });
const call = (path: string, account?: string, agent = "treasury") =>
  fetch(`${base}/a/${agent}/rpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(account && { cookie: `dao_session=${sessionToken(account, SECRET)}` }) },
    body: "{}",
  });

const all = paths(router);
const viewerAccess = { canSign: false, canPropose: false, canVote: false, canExecute: false, canManage: false };
const beyondReads = all.filter((path) => !mayCall(viewerAccess, path));

// Fetch owns Host in current Node; raw HTTP exercises the gateway's actual host boundary.
const machineFetch = (url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<Response>((done, fail) => {
  const req = request(url, options, res => {
    const chunks: Buffer[] = [];
    res.on("data", chunk => chunks.push(Buffer.from(chunk))).on("end", () => done(new Response(Buffer.concat(chunks), {
      status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    })));
  });
  req.on("error", fail); req.end(options.body);
});
const credentialRequest = (account: string | undefined, scopes: string[], agent = "treasury", extra: object = {}) => machineFetch(`${base}/gw/machine-credentials/${agent}`, {
  method: "POST", headers: { host: "dao.test", "content-type": "application/json", ...(account && session(account)) },
  body: JSON.stringify({ label: "fixture assistant", scopes, ttlSeconds: 60, ...extra }),
});
const machineCall = (token: string, path: string, agent = "treasury", headers: Record<string, string> = {}) => machineFetch(`${base}/machine/v1/a/${agent}/rpc/${path}`, {
  method: "POST", headers: { host: "dao.test", authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: "{}",
});

test("DAO member permissions alone cannot authorize machine delegation", async () => {
  assert.equal((await credentialRequest("council.near", ["read", "prepare", "execute"])).status, 403);
});

test("a warmed ownership cache cannot authorize a machine call during a failed identity read", async () => {
  const issued = await credentialRequest(OWNER, ["read"], "wallet");
  assert.equal(issued.status, 201);
  const { token } = await issued.json();
  assert.equal((await machineCall(token, "overview", "wallet")).status, 200);
  reached.length = 0;
  walletIdentityUnavailable = true;
  try {
    assert.equal((await machineCall(token, "overview", "wallet")).status, 403);
    assert.deepEqual(reached, []);
  } finally { walletIdentityUnavailable = false; }
});

test("replacing an agent under the same workspace name does not inherit machine authority", async () => {
  const { token } = await (await credentialRequest(OWNER, ["read"], "wallet")).json();
  reached.length = 0;
  walletAgentId = "b".repeat(64);
  try {
    assert.equal((await machineCall(token, "overview", "wallet")).status, 403);
    assert.deepEqual(reached, []);
  } finally { walletAgentId = "a".repeat(64); }
});

test("machine provisioning requires wallet management and cannot delegate more authority than its issuer holds", async () => {
  assert.equal((await credentialRequest(undefined, ["read"])).status, 401);
  assert.equal((await credentialRequest("member.near", ["read"])).status, 403);
  assert.equal((await credentialRequest("executor.near", ["execute-plan"])).status, 403);
  assert.equal((await credentialRequest("manager.near", ["execute-plan"])).status, 403);
  assert.equal((await credentialRequest("manager.near", ["prepare"])).status, 403);
  assert.equal((await credentialRequest(OWNER, ["unknown"], "wallet")).status, 400);
  assert.equal((await credentialRequest(OWNER, ["read"], "wallet", { ttlSeconds: 86_401 })).status, 400);
  assert.equal((await credentialRequest(OWNER, ["read"], "wallet", { scopes: ["read", "read"] })).status, 400);
  assert.equal((await credentialRequest("owner.near", ["read"], "stray")).status, 403);
});

test("machine scope, Treasury, host and browser boundaries refuse before forwarding; revocation is immediate", async () => {
  const issued = await credentialRequest(OWNER, ["read", "prepare", "execute-plan", "sweep"], "wallet");
  assert.equal(issued.status, 201);
  const { token, credential } = await issued.json();
  reached.length = 0; forwardedCredentials.length = 0;
  assert.equal((await machineCall(token, "overview", "wallet")).status, 200);
  assert.equal((await machineCall(token, "rebalance", "wallet")).status, 200);
  assert.equal((await machineCall(token, "executePlan", "wallet")).status, 200);
  assert.equal((await machineCall(token, "sweep", "wallet")).status, 200);
  assert.deepEqual(reached, ["overview", "rebalance", "executePlan", "sweep"]);
  assert.ok(forwardedCredentials.every(value => value === undefined), "bearer tokens never reach agent handlers");
  const audit = readFileSync(join(dir, ".evidence", "interventions.jsonl"), "utf8");
  assert.ok(audit.includes(credential.id));
  assert.ok(!audit.includes(token));
  reached.length = 0;
  for (const path of ["owner/prepare", "owner/submit", "pay", "autopilot/enable", "autopilot/tick", "strategy/save", "recover", "setup", "unknown"])
    assert.equal((await machineCall(token, path, "wallet")).status, 403, path);
  assert.equal((await machineCall(token, "overview", "treasury")).status, 403);
  assert.equal((await machineCall(token, "overview", "wallet", { host: "elsewhere.test" })).status, 421);
  assert.equal((await machineCall(token, "overview", "wallet", { origin: "https://dao.test" })).status, 403);
  assert.equal((await machineCall(token, "overview", "wallet", session(OWNER))).status, 403);
  assert.equal((await machineCall(token + "x", "overview", "wallet")).status, 401);
  assert.equal((await fetch(`${base}/a/treasury/rpc/overview`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" })).status, 401);
  const listed = await machineFetch(`${base}/gw/machine-credentials/wallet`, { headers: { host: "dao.test", ...session(OWNER) } });
  const records = await listed.json();
  assert.ok(!JSON.stringify(records).includes(token));
  assert.ok(!JSON.stringify(records).includes("secretHash"));
  assert.equal((await machineFetch(`${base}/gw/machine-credentials/wallet/${credential.id}`, { method: "DELETE", headers: { host: "dao.test", ...session(OWNER) } })).status, 200);
  assert.equal((await machineCall(token, "overview", "wallet")).status, 401);
  assert.deepEqual(reached, []);
});

test("a read-only machine cannot prepare or execute even when issued by the wallet owner", async () => {
  const { token } = await (await credentialRequest(OWNER, ["read"], "wallet")).json();
  reached.length = 0;
  assert.equal((await machineCall(token, "rebalance", "wallet")).status, 403);
  assert.equal((await machineCall(token, "executePlan", "wallet")).status, 403);
  assert.equal((await machineCall(token, "sweep", "wallet")).status, 403);
  assert.deepEqual(reached, []);
});

test("saved-plan execution and sweeping are independent at the HTTP boundary", async () => {
  const plan = await (await credentialRequest(OWNER, ["execute-plan"], "wallet")).json();
  const sweep = await (await credentialRequest(OWNER, ["sweep"], "wallet")).json();
  reached.length = 0;
  assert.equal((await machineCall(plan.token, "sweep", "wallet")).status, 403);
  assert.equal((await machineCall(sweep.token, "executePlan", "wallet")).status, 403);
  assert.deepEqual(reached, []);
});

test("machine calls fail closed on lost account access, changed ownership, unreadable credentials or audit failure", async () => {
  const { token, credential } = await (await credentialRequest(OWNER, ["read", "execute-plan"], "wallet")).json();
  const file = join(dir, ".machine-auth", `${credential.id}.json`);
  const saved = readFileSync(file, "utf8");
  reached.length = 0;
  try {
    writeFileSync(file, JSON.stringify({ ...JSON.parse(saved), account: "outsider.near" }));
    assert.equal((await machineCall(token, "overview", "wallet")).status, 403);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(saved), owner: "changed.near" }));
    assert.equal((await machineCall(token, "executePlan", "wallet")).status, 403);
    writeFileSync(file, "{broken");
    assert.equal((await machineCall(token, "executePlan", "wallet")).status, 500);
    writeFileSync(file, saved);
    const audit = join(dir, ".machine-auth", "access.jsonl");
    const retained = readFileSync(audit);
    rmSync(audit); mkdirSync(audit);
    try { assert.equal((await machineCall(token, "executePlan", "wallet")).status, 500); }
    finally { rmSync(audit, { recursive: true }); writeFileSync(audit, retained); }
    assert.deepEqual(reached, []);
  } finally { writeFileSync(file, saved); }
});

test("without a session, no procedure reaches the agent server", async () => {
  reached.length = 0;
  for (const path of all) assert.equal((await call(path)).status, 401, path);
  assert.deepEqual(reached, []);
});

test("an outsider's valid session reaches nothing", async () => {
  reached.length = 0;
  for (const path of all) assert.equal((await call(path, "outsider.near")).status, 403, path);
  assert.deepEqual(reached, []);
});

test("a legacy configured operator outside the DAO's groups reaches no handler", async () => {
  reached.length = 0;
  for (const path of ["overview", "pay", "autopilot/tick", "strategy/save"])
    assert.equal((await call(path, "ops.near")).status, 403, path);
  assert.deepEqual(reached, []);
});

test("a read-only member is refused every money, preparation and settings procedure before it reaches the agent server", async () => {
  assert.ok(beyondReads.includes("pay") && beyondReads.includes("executePlan") && beyondReads.includes("owner/prepare"));
  reached.length = 0;
  for (const path of beyondReads) assert.equal((await call(path, "member.near")).status, 403, path);
  assert.deepEqual(reached, []);
});

test("a forged or altered session is refused", async () => {
  reached.length = 0;
  const forged = await fetch(`${base}/a/treasury/rpc/pay`, { method: "POST", headers: { cookie: "dao_session=bWVtYmVyLm5lYXI.9999999999999.forged" }, body: "{}" });
  assert.equal(forged.status, 401);
  const token = sessionToken("member.near", SECRET).split(".");
  const altered = `${Buffer.from("ops.near").toString("base64url")}.${token[1]}.${token[2]}`;
  const promoted = await fetch(`${base}/a/treasury/rpc/pay`, { method: "POST", headers: { cookie: `dao_session=${altered}` }, body: "{}" });
  assert.equal(promoted.status, 401);
  assert.deepEqual(reached, []);
});

test("path tricks don't turn a member read into a money call", async () => {
  reached.length = 0;
  for (const path of ["overview/../pay", "overview%2F..%2Fpay", "overview/", "pay?x=overview", "./pay"])
    assert.notEqual((await call(path, "member.near")).status, 200, path);
  assert.ok(reached.every((path) => mayCall(viewerAccess, path.split("?")[0]!)), JSON.stringify(reached));
});

test("the controls: admitted reads and a DAO executor's calls do get through", async () => {
  reached.length = 0;
  assert.equal((await call("overview", "member.near")).status, 200);
  assert.equal((await call("pay", "executor.near")).status, 200);
  assert.deepEqual(reached, ["overview", "pay"]);
});

test("DAO proposal, approval, execution and management permissions stay distinct at the gateway", async () => {
  reached.length = 0;
  for (const account of ["requestor.near", "approver.near"])
    for (const path of ["pay", "autopilot/tick", "strategy/save", "owner/submit"])
      assert.equal((await call(path, account)).status, 403, `${account}: ${path}`);
  assert.equal((await call("owner/prepare", "approver.near")).status, 403);
  assert.equal((await call("strategy/save", "executor.near")).status, 403);
  assert.equal((await call("pay", "manager.near")).status, 403);
  for (const account of ["executor.near", "manager.near"])
    assert.equal((await call("autopilot/set", account)).status, 403, "legacy setter needs both capabilities");
  assert.equal((await call("owner/submit", "council.near")).status, 403, "DAO rights do not grant a wallet-owner submission path");
  for (const [account, agent] of [[OWNER, "wallet"], ["council.near", "treasury"]])
    for (const path of ["futureProcedure", "ownerIdentity"])
      assert.equal((await call(path, account, agent)).status, 403, path);
  assert.deepEqual(reached, []);
  for (const [account, path] of [
    ["requestor.near", "owner/prepare"], ["executor.near", "autopilot/enable"],
    ["manager.near", "strategy/save"], ["manager.near", "autopilot/stop"],
    ["council.near", "autopilot/set"], ["member.near", "invoices"],
  ]) assert.equal((await call(path!, account)).status, 200, `${account}: ${path}`);
  assert.deepEqual(reached, ["owner/prepare", "autopilot/enable", "strategy/save", "autopilot/stop", "autopilot/set", "invoices"]);
});

test("denials distinguish lost sessions, agent access and procedure permission", async () => {
  assert.equal((await (await call("overview")).json()).access, "session");
  assert.equal((await (await call("overview", "member.near", "wallet")).json()).access, "agent");
  assert.equal((await (await call("pay", "member.near")).json()).access, "procedure");
});

test("run-log exports enforce per-agent membership and cannot inherit public caching", async () => {
  reached.length = 0;
  const denied = await call("autopilot/log");
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("cache-control")!, /no-store/);
  assert.equal((await call("autopilot/log", "member.near", "wallet")).status, 403);
  assert.deepEqual(reached, []);
  const allowed = await call("autopilot/log", "member.near");
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(reached, ["autopilot/log"]);
});

const recorded = () => {
  const path = join(dir, ".evidence", "interventions.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { account: string; path: string }) : [];
};
const interventions = (account?: string) =>
  fetch(`${base}/gw/interventions?since=2000-01-01T00:00:00Z`, { headers: account ? { cookie: `dao_session=${sessionToken(account, SECRET)}` } : {} });

test("an execution call is recorded before it runs; ordinary reads, proposals and refusals aren't", async () => {
  const before = recorded().length;
  await call("overview", "executor.near");
  await call("owner/prepare", "requestor.near");
  await call("pay", "member.near");
  assert.equal(recorded().length, before);
  reached.length = 0;
  assert.equal((await call("autopilot/tick", "executor.near")).status, 200);
  assert.deepEqual(reached, ["autopilot/tick"]);
  assert.deepEqual(recorded().slice(before).map((r) => [r.account, r.path]), [["executor.near", "autopilot/tick"]]);
});

test("intervention history requires execution or management permission", async () => {
  assert.equal((await interventions()).status, 401);
  assert.equal((await interventions("member.near")).status, 403);
  assert.equal((await interventions("requestor.near")).status, 403);
  assert.equal((await interventions("manager.near")).status, 200);
  const answer = await interventions("executor.near");
  assert.equal(answer.status, 200);
  assert.ok(((await answer.json()) as { calls: { path: string }[] }).calls.some((i) => i.path === "autopilot/tick"));
});

test("a torn line in the intervention record is counted, and the call recorded after it still reads", async () => {
  const path = join(dir, ".evidence", "interventions.jsonl");
  appendFileSync(path, '{"at":"2026-'); // a crash mid-append
  const torn = readFileSync(path, "utf8").split("\n").length;
  assert.equal((await call("autopilot/tick", "executor.near")).status, 200);
  const { calls, corrupt } = (await (await interventions("executor.near")).json()) as { calls: { path: string }[]; corrupt: number[] };
  assert.deepEqual(corrupt, [torn]);
  assert.equal(calls.at(-1)?.path, "autopilot/tick");
});

test("an intervention that can't be recorded is not run", async () => {
  const path = join(dir, ".evidence", "interventions.jsonl");
  rmSync(path, { force: true });
  mkdirSync(path); // a directory where the record should be
  try {
    reached.length = 0;
    assert.equal((await call("pay", "executor.near")).status, 503);
    assert.deepEqual(reached, []);
  } finally {
    rmSync(path, { recursive: true });
  }
});

test("a cross-site or malformed Origin is refused 403, not mistaken for a bad request", async () => {
  reached.length = 0;
  for (const origin of ["null", "https://elsewhere.example", "not a url"]) {
    const answer = await fetch(`${base}/a/treasury/rpc/pay`, {
      method: "POST",
      headers: { origin, cookie: `dao_session=${sessionToken("executor.near", SECRET)}` },
      body: "{}",
    });
    assert.equal(answer.status, 403, origin);
  }
  assert.deepEqual(reached, []);
});

test("signed out, the gateway serves no roster or proposals: the old public view is gone", async () => {
  assert.equal((await fetch(`${base}/gw/public`)).status, 404);
  assert.equal((await fetch(`${base}/gw/proposals`)).status, 401);
});

test("a failure on the gateway's side is a 500 that shows no internals", async () => {
  // The stand-in RPC answers every view of the DAO with its policy, which is not a proposal list.
  const answer = await fetch(`${base}/gw/proposals?dao=${DAO}`, { headers: session("member.near") });
  assert.equal(answer.status, 500);
  assert.deepEqual(await answer.json(), { error: "Something went wrong. Try again later." });
});

test("a wallet owner controls only its own agents; DAO permissions and legacy operator config grant no wallet access", async () => {
  reached.length = 0;
  assert.equal((await call("pay", OWNER, "wallet")).status, 200);
  assert.equal((await call("overview", OWNER, "treasury")).status, 403);
  assert.equal((await call("overview", "member.near", "wallet")).status, 403);
  assert.equal((await call("pay", "executor.near", "wallet")).status, 403);
  assert.equal((await call("overview", "ops.near", "wallet")).status, 403, "a named operator cannot read another wallet owner's agent");
  assert.equal((await call("pay", "ops.near", "wallet")).status, 403, "a named operator cannot act for another wallet owner");
  assert.deepEqual(reached, ["pay"]);
});

test("who sees what: the agents a visitor may know of, each with its owner, and a viewer's access to each", async () => {
  type Me = { agents: unknown; invoices: unknown; viewer: { account: string; access: Record<string, unknown> } | null };
  const me = (account?: string) => fetch(`${base}/gw/me`, { headers: account ? session(account) : {} }).then((r) => r.json() as Promise<Me>);
  const dao = { name: "treasury", area: "treasury", owner: DAO, dao: true };
  const wallet = { name: "wallet", area: "treasury", owner: OWNER, dao: false };
  // Signed out, a wallet's agent isn't listed: who owns an agent here is the owner's to tell.
  assert.deepEqual(await me(), { agents: [dao], invoices: null, viewer: null });
  const ownerAccess = { canSign: true, canPropose: false, canVote: false, canExecute: true, canManage: true };
  assert.deepEqual(await me(OWNER), {
    agents: [wallet, { name: "new", owner: OWNER, dao: false }],
    invoices: null,
    viewer: { account: OWNER, access: { wallet: ownerAccess, new: ownerAccess } },
  });
  assert.deepEqual((await me("member.near")).agents, [dao]);
});

test("proposals are listed per DAO, for viewers of an agent it owns", async () => {
  const proposals = (dao: string, account: string) => fetch(`${base}/gw/proposals?dao=${dao}`, { headers: session(account) });
  assert.equal((await proposals(DAO, OWNER)).status, 403);
  assert.equal((await proposals(OWNER, "member.near")).status, 403);
  assert.equal((await proposals(OWNER, OWNER)).status, 400, "a plain account files no proposals");
});

test("the configured owner must be the agent's real owner: an agent owned by anyone else is closed to everyone", async () => {
  reached.length = 0;
  assert.equal((await call("overview", OWNER, "stray")).status, 403, "even the configured owner is denied when provider ownership disagrees");
  assert.equal((await call("overview", "ops.near", "stray")).status, 403);
  assert.equal((await call("pay", OWNER, "new")).status, 200, "an agent not created yet is its configured owner's to set up");
  assert.equal((await call("overview", "member.near", "treasury")).status, 200, "the DAO's agent is owned by the account the DAO signs with");
  assert.deepEqual(reached, ["pay", "overview"]);
});

test("intervention history preserves old operator records and stays scoped to permitted agents", async () => {
  assert.equal((await call("autopilot/tick", "executor.near")).status, 200);
  appendFileSync(join(dir, ".evidence", "interventions.jsonl"), `${JSON.stringify({ at: "2026-01-01T00:00:00Z", account: "ops.near", agent: "treasury", path: "pay" })}\n`);
  const calls = async (account: string) => ((await (await interventions(account)).json()) as { calls: { agent: string }[] }).calls;
  const history = await (await interventions("executor.near")).json() as { calls: { agent: string; account: string; path: string }[] };
  assert.ok(history.calls.some((c) => c.agent === "treasury" && c.account === "ops.near" && c.path === "pay"));
  assert.ok((await calls("manager.near")).some((c) => c.agent === "treasury"));
  assert.deepEqual((await calls(OWNER)).filter((c) => c.agent !== "wallet" && c.agent !== "new"), []);
});

test("owner recovery and receipt discovery require agent membership and prohibit caching", async () => {
  for (const path of ["owner/actions", "paymentHistory", "strategy/get"]) {
    reached.length = 0;
    assert.equal((await call(path)).status, 401);
    assert.equal((await call(path, "member.near", "wallet")).status, 403);
    assert.deepEqual(reached, []);
    const response = await call(path, "member.near");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(reached, [path]);
  }
});

// DAO consent: a passed Vote proposal that names the credential, verified against the chain.
const DAO_AGENT_ID = "a".repeat(64);
const approval = (id: number, over: { scopes?: string[]; status?: string; kind?: unknown; agentId?: string; ttlSeconds?: number; issueBy?: string; agent?: string } = {}) => {
  proposals.set(id, { id, proposer: "council.near", status: over.status ?? "Approved", kind: over.kind ?? "Vote", submission_time: String(BigInt(Date.now()) * 1_000_000n),
    description: consentDescription({ agent: over.agent ?? "treasury", agentId: over.agentId ?? DAO_AGENT_ID, host: "dao.test", label: "fixture assistant",
      scopes: (over.scopes ?? ["read"]) as never, ttlSeconds: over.ttlSeconds ?? 60, issueBy: over.issueBy ?? new Date(Date.now() + 3_600_000).toISOString() }) });
  return id;
};
const issued = async (response: Response) => (await response.json()) as { token: string; credential: { id: string; consent?: { dao: string; proposalId: number } } };

test("a DAO-approved credential can be issued, used within its scopes, and revoked like a wallet owner's", async () => {
  const response = await credentialRequest("council.near", ["read", "prepare"], "treasury", { proposalId: approval(101, { scopes: ["read", "prepare"] }) });
  assert.equal(response.status, 201);
  const { token, credential } = await issued(response);
  assert.deepEqual(credential.consent && { dao: credential.consent.dao, proposalId: credential.consent.proposalId }, { dao: DAO, proposalId: 101 });
  reached.length = 0;
  assert.equal((await machineCall(token, "overview")).status, 200);
  assert.equal((await machineCall(token, "rebalance")).status, 200);
  assert.deepEqual(reached, ["overview", "rebalance"]);
  // Only what the approval names: no execution, sweep, owner signing or management.
  for (const path of ["executePlan", "sweep", "owner/prepare", "owner/submit", "strategy/save", "autopilot/enable", "pay", "recover"])
    assert.equal((await machineCall(token, path)).status, 403, path);
  assert.deepEqual(reached, ["overview", "rebalance"], "refused calls never reach the agent");
  // Bound to this treasury and this host, like any credential.
  assert.equal((await machineCall(token, "overview", "wallet")).status, 403);
  assert.equal((await machineCall(token, "overview", "treasury", { host: "elsewhere.test" })).status, 421);
  // Any current manager revokes it, as for a wallet owner; the call then fails at once.
  assert.equal((await machineFetch(`${base}/gw/machine-credentials/treasury/${credential.id}`, { method: "DELETE", headers: { host: "dao.test", ...session("manager.near") } })).status, 200);
  assert.equal((await machineCall(token, "overview")).status, 401);
});

test("DAO member permissions alone never issue a credential, however strong; the approval must be the DAO's and match", async () => {
  // Strongest members, no proposal, then proposals that are not consent for this credential.
  assert.equal((await credentialRequest("council.near", ["read"])).status, 403);
  assert.equal((await credentialRequest("council.near", ["read"], "treasury", { proposalId: 9_999 })).status, 403, "no such proposal");
  const refusals: [string, number, string[]][] = [
    ["not yet approved", approval(110, { status: "InProgress" }), ["read"]],
    ["rejected", approval(111, { status: "Rejected" }), ["read"]],
    ["expired", approval(112, { status: "Expired" }), ["read"]],
    ["a proposal that does something", approval(113, { kind: { Transfer: { token_id: "", receiver_id: "x.near", amount: "1" } } }), ["read"]],
    ["wider scopes than approved", approval(114, { scopes: ["read"] }), ["read", "prepare"]],
    ["narrower scopes than approved", approval(115, { scopes: ["read", "prepare"] }), ["read"]],
    ["another agent's approval", approval(116, { agent: "wallet" }), ["read"]],
    ["another provider agent", approval(117, { agentId: "b".repeat(64) }), ["read"]],
    ["a longer lifetime than approved", approval(118, { ttlSeconds: 60 }), ["read"]],
    ["issue-by passed", approval(119, { issueBy: new Date(Date.now() - 1_000).toISOString() }), ["read"]],
  ];
  for (const [name, id, scopes] of refusals) {
    const longer = name === "a longer lifetime than approved";
    const response = await credentialRequest("council.near", scopes, "treasury", { proposalId: id, ...(longer && { ttlSeconds: 3_600 }) });
    assert.equal(response.status, 403, name);
  }
  // A member without management permission cannot present even a valid approval.
  assert.equal((await credentialRequest("member.near", ["read"], "treasury", { proposalId: approval(120) })).status, 403);
  assert.equal((await credentialRequest("executor.near", ["read"], "treasury", { proposalId: approval(121) })).status, 403);
  assert.equal((await credentialRequest(undefined, ["read"], "treasury", { proposalId: approval(122) })).status, 401);
  // Wallet-owned treasuries take no proposalId.
  assert.equal((await credentialRequest(OWNER, ["read"], "wallet", { proposalId: 1 })).status, 400);
});

test("one DAO approval backs one credential, even if the first is revoked", async () => {
  const id = approval(130);
  const first = await credentialRequest("manager.near", ["read"], "treasury", { proposalId: id });
  assert.equal(first.status, 201);
  assert.equal((await credentialRequest("council.near", ["read"], "treasury", { proposalId: id })).status, 409);
  const { credential } = await issued(first);
  await machineFetch(`${base}/gw/machine-credentials/treasury/${credential.id}`, { method: "DELETE", headers: { host: "dao.test", ...session("council.near") } });
  assert.equal((await credentialRequest("council.near", ["read"], "treasury", { proposalId: id })).status, 409);
});

test("a DAO credential stops working the moment the chain no longer shows the approval it rests on", async () => {
  const id = approval(140, { scopes: ["read"] });
  const { token } = await issued(await credentialRequest("council.near", ["read"], "treasury", { proposalId: id }));
  assert.equal((await machineCall(token, "overview")).status, 200);
  const original = proposals.get(id);
  // The stored approval changes status, vanishes, or reads differently: every one refuses before forwarding.
  for (const changed of [{ ...(original as object), status: "Removed" }, { ...(original as object), kind: { Transfer: {} } },
    { ...(original as object), description: (original as { description: string }).description + " " }, undefined]) {
    if (changed) proposals.set(id, changed); else proposals.delete(id);
    reached.length = 0;
    assert.equal((await machineCall(token, "overview")).status, 403);
    assert.deepEqual(reached, []);
  }
  proposals.set(id, original);
  assert.equal((await machineCall(token, "overview")).status, 200);
  // Replacing the provider agent under the same workspace name also ends it: the approval named the old one.
  daoAgentId = "b".repeat(64);
  try { assert.equal((await machineCall(token, "overview")).status, 403); } finally { daoAgentId = "a".repeat(64); }
  assert.equal((await machineCall(token, "overview")).status, 200);
});
