// Full server crash test. Only this parent owns the synthetic provider; both consumer processes are killed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { Server, createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { appClient, ownerClient, proposalText } from '@multiagency/sdk';

const [boundary, platform, directory, app] = process.argv.slice(2);
assert.ok(['before-id', 'after-id'].includes(boundary));
const load = p => import(pathToFileURL(join(platform, p)).href);
const { offlineEnvironment } = await load('scripts/test-environment.mjs');
const { environment } = await load('test/e2e/environment.mjs');
const { stackControls, appCredential, stackFetch } = await load('test/e2e/stack-controls.mjs');
const { OWNER, USDC, sign } = await load('test/e2e/provider.mjs');
const WNEAR = 'nep141:wrap.near';
const delay = ms => new Promise(r => setTimeout(r, ms));
const bounded = (promise, label, ms = 25_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
});
const freePort = async () => {
  const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const port = s.address().port; await new Promise(r => s.close(r)); return port;
};
const children = [];
async function start(entry, cwd, env, ready, args = []) {
  const child = spawn(process.execPath, [...args, entry], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let failure;
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve([code, signal]));
    child.on('error', error => {
      failure ??= error;
      // A failed spawn has no process and may never emit exit; other errors don't relinquish ownership.
      if (child.pid === undefined) resolve([null, null]);
    });
  });
  const managed = { child, exited };
  children.push(managed);
  let log = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', c => {
    log = (log + c).slice(-8192); appendFileSync(join(directory, 'servers.log'), c);
  });
  for (let i = 0; !log.includes(ready); i++) {
    if (failure) throw failure;
    if (child.exitCode !== null || child.signalCode || i >= 400) throw new Error(`Server did not start: ${log}`);
    await delay(50);
  }
  return managed;
}
async function kill(managed) {
  if (managed.child.exitCode === null && !managed.child.signalCode) managed.child.kill('SIGKILL');
  const [, signal] = await bounded(managed.exited, 'Child exit'); assert.equal(signal, 'SIGKILL');
}

// Hold the actual provider response after its ledger and balances change, before the consumer can acknowledge it.
// The barrier is outside both killed processes. No sleeps or polling of an already completed proposal choose the crash.
const originalEmit = Server.prototype.emit;
let armed = false, held, reached;
const barrier = new Promise(resolve => { reached = resolve; });
Server.prototype.emit = function(event, req, res, ...rest) {
  if (event === 'request' && armed) {
    const end = res.end;
    res.end = function(chunk, ...args) {
      let data; try { data = JSON.parse(String(chunk)); } catch {}
      const path = new URL(req.url, 'http://localhost');
      const match = boundary === 'before-id' ? req.method === 'POST' && path.pathname.endsWith('/swap') && data?.correlation_id
        : req.method === 'GET' && path.pathname === '/v1/status' && data?.type === 'swap';
      if (armed && match) {
        armed = false; held = { req, res, data, path: req.url };
        reached({ correlationId: data.correlation_id, path: req.url }); return this;
      }
      return end.call(this, chunk, ...args);
    };
  }
  return originalEmit.call(this, event, req, res, ...rest);
};

let stack, treasury, executor;
try {
  // tsx resolves from each agent's working directory; the fixture directory must have its own dependency link.
  symlinkSync(join(platform, 'node_modules'), join(directory, 'node_modules'), 'dir');
  stack = await environment(join(directory, 'platform'), { workspace: true, portfolioOwner: OWNER, owner: OWNER });
  const controls = stackControls(stack, { owner: OWNER });
  const deployment = 'crash-acceptance', credential = await appCredential(stack, deployment);
  const client = appClient({ base: stack.dashboard, credential, fetch: stackFetch(stack) });
  const calls = client.agent('owner--near', 'portfolio');
  // Recovery is an owner maintenance procedure, not an app permission. Use the fixture owner's real gateway session.
  const gatewayFetch = stackFetch(stack);
  const ownerChallenge = await (await gatewayFetch('/gw/challenge')).json();
  const ownerSignature = await sign(OWNER, ownerChallenge);
  const ownerSession = await gatewayFetch('/gw/session', { method: 'POST', headers: { 'content-type': 'application/json', origin: stack.dashboard },
    body: JSON.stringify({ ...ownerSignature, nonce: ownerChallenge.nonce }) });
  assert.equal(ownerSession.status, 200);
  const ownerCookie = ownerSession.headers.getSetCookie()[0].split(';')[0];
  const owner = ownerClient({ base: `${stack.dashboard}/a/portfolio`, fetch: (url, init = {}) => gatewayFetch(url, { ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), cookie: ownerCookie, origin: stack.dashboard } }) });
  const port = await freePort(), origin = `http://localhost:${port}`, state = join(directory, 'treasury');
  mkdirSync(state);
  writeFileSync(join(state, 'credential'), credential, { mode: 0o600 });
  writeFileSync(join(state, 'watch.json'), '{"agents":[]}', { mode: 0o600 });
  const appEnv = { ...offlineEnvironment(), NODE_OPTIONS: `--require ${join(platform, 'test/e2e/exit-with-parent.cjs')}`,
    PORT: String(port), TREASURY_PLATFORM_ORIGIN: stack.dashboard, TREASURY_DEPLOYMENT: deployment,
    TREASURY_PUBLIC_ORIGIN: origin, TREASURY_CREDENTIAL_FILE: join(state, 'credential'),
    TREASURY_AUDIT_FILE: join(state, 'audit.jsonl'), TREASURY_DAO_REQUESTS_FILE: join(state, 'dao.json'),
    TREASURY_WATCH_FILE: join(state, 'watch.json'), TREASURY_REQUESTS_FILE: join(state, 'requests.json'),
    NEAR_RPC_URL: `${stack.simulated.url}/chain`, INTENTS_PROVIDER: 'stub',
    NODE_EXTRA_CA_CERTS: join(stack.directory, 'localhost.crt'),
  };
  const startTreasury = () => start(join(app, 'src/start.ts'), app, appEnv, '"listening":');
  treasury = await startTreasury();
  let cookie;
  async function call(path, body) {
    const r = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
    return { response: r, body: await r.json() };
  }
  async function signIn() {
    const text = (await call('/api/session/challenge', {})).body.value;
    const answer = await call('/api/session', { ...await controls.signOwner(text), nonce: text.nonce });
    assert.equal(answer.response.status, 200, JSON.stringify(answer.body));
    cookie = answer.response.headers.get('set-cookie').split(';')[0];
  }
  await signIn();
  const agent = '/api/agents/portfolio';
  const text = (await call(agent + '/consent/text', {})).body.value;
  const signature = await controls.signOwner(text);
  const consent = await call(agent + '/consent', { message: text.message, nonce: text.nonce, publicKey: signature.publicKey, signature: signature.signature });
  assert.equal(consent.response.status, 200, JSON.stringify(consent.body));
  const clear = await calls.call('unresolved'); assert.ok(clear.ok); assert.deepEqual(clear.value, [], 'Each case starts with no unresolved operation');
  const initial = stack.portfolio.treasuryBalances();
  const proposed = await calls.call('proposals/create', { requestId: `boundary-${boundary}`, legs: [{ from: USDC, to: WNEAR, amount: '1000000' }], expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  assert.ok(proposed.ok, JSON.stringify(proposed));
  const view = proposed.value, message = proposalText(view, 'approve'), nonce = randomBytes(32).toString('base64');
  const signed = await controls.signOwner({ message, nonce, recipient: new URL(stack.dashboard).host });
  const approved = await call(`${agent}/proposals/${view.id}/approve`, { message, nonce, publicKey: signed.publicKey, signature: signed.signature });
  assert.equal(approved.response.status, 200, JSON.stringify(approved.body));
  armed = true;
  // Attach the rejection handler before killing the server closes the HTTP connection.
  let executionFinished = false;
  const executing = call(`${agent}/proposals/${view.id}/execute`, {}).then(answer => ({ answer }), error => ({ error: String(error) }))
    .finally(() => { executionFinished = true; });
  const witness = await bounded(barrier, 'Provider submission barrier');
  assert.equal(stack.portfolio.swaps.length, 1);
  const settledBalances = stack.portfolio.treasuryBalances();
  assert.equal(BigInt(initial[USDC]) - BigInt(settledBalances[USDC]), 1_000_000n);
  const swap = stack.portfolio.swaps[0];
  assert.equal(BigInt(settledBalances[WNEAR]) - BigInt(initial[WNEAR]), BigInt(swap.amountOut));
  const journalPath = join(stack.directory, 'portfolio/.ops', `${stack.portfolio.id}.jsonl`);
  const journalBefore = readFileSync(journalPath, 'utf8');
  const lines = journalBefore.trim().split('\n').map(JSON.parse);
  assert.equal(lines.filter(l => l.request).length, 1);
  const operationKey = lines.find(l => l.request).idempotencyKey;
  assert.ok(lines.some(l => l.submissionState === 'SUBMISSION_ATTEMPTED'));
  assert.equal(lines.some(l => l.correlation_id === witness.correlationId), boundary === 'after-id');
  assert.equal(lines.some(l => l.status === 'SUCCESS'), false, 'Crash precedes acknowledgement of settlement');
  // Freeze through the real owner API while the provider response is held. The send already took effect.
  const frozen = await call(agent + '/freeze', {});
  assert.equal(frozen.response.status, 200, JSON.stringify(frozen.body));
  const prepared = frozen.body.value; assert.ok(prepared.intent, 'Local fixture returns a signable intent');
  const freezeSignature = await controls.signOwner(prepared.intent.payload);
  const submitted = await call(`${agent}/owner/actions/${prepared.correlationId}/submit`, { signedData: { ...prepared.intent, public_key: freezeSignature.publicKey, signature: freezeSignature.signature } });
  assert.equal(submitted.response.status, 200, JSON.stringify(submitted.body));
  for (let i = 0; ; i++) {
    await call(`${agent}/owner/actions/${prepared.correlationId}`);
    const overview = await call(agent + '/overview');
    if (overview.body.value.policy.policy.frozen) break;
    assert.ok(i < 50, 'Freeze must take effect before crash'); await delay(100);
  }
  // The original platform child is owned by environment; portfolio is the third of its four initial services.
  const originalPids = stack.servicePids(); assert.equal(originalPids.length, 4);
  const portfolioPid = originalPids[2];
  assert.equal(executionFinished, false, 'Execution must still be awaiting its response at SIGKILL');
  assert.equal(readFileSync(journalPath, 'utf8'), journalBefore, 'No settlement acknowledgement before SIGKILL');
  await kill(treasury);
  process.kill(portfolioPid, 'SIGKILL');
  for (let i = 0; stack.servicePids().includes(portfolioPid); i++) { assert.ok(i < 100); await delay(20); }
  held.res.destroy();
  await executing;
  const config = JSON.parse(readFileSync(join(stack.directory, 'gateway/dashboard.json')));
  const agentPort = config.agents.find(a => a.name === 'portfolio').port;
  const executorEnv = { ...offlineEnvironment(), PORT: String(agentPort), EXECUTOR: 'on', AUTOPILOT: 'off', DASHBOARD_AREA: 'treasury',
    AGENT_ID: stack.portfolio.id, AGENT_GRANT_TOKEN: stack.portfolio.token,
    NEAR_INTENTS_AGENT_API_URL: stack.portfolio.url, NEAR_RPC_URL: `${stack.simulated.url}/chain`,
    NODE_OPTIONS: ['offline-network.cjs', '../e2e/fastnear-fixture.cjs', '../e2e/exit-with-parent.cjs'].map(f => `--require ${resolve(platform, 'test/fixtures', f)}`).join(' ') };
  const restarts = [];
  let ledger;
  for (let pass = 0; pass < 2; pass++) {
    // A killed executor's lease deliberately stays held until stale; never unlink it to accelerate recovery.
    for (const deadline = Date.now() + 20_000; ;) {
      try {
        executor = await start(join(platform, 'src/server.ts'), join(stack.directory, 'portfolio'), executorEnv, 'Treasury dashboard on', ['--import', join(platform, 'node_modules/tsx/dist/loader.mjs')]);
        break;
      } catch (error) {
        if (!error.message.includes('cannot acquire ownership') || Date.now() >= deadline) throw error;
        await delay(250);
      }
    }
    treasury = await startTreasury(); await signIn();
    let recovered;
    for (let i = 0; ; i++) {
      recovered = await calls.call('proposals/get', { id: view.id }); assert.ok(recovered.ok, JSON.stringify(recovered));
      if (boundary === 'before-id' || recovered.value.state === 'executed') break;
      assert.ok(i < 150, JSON.stringify(recovered)); await delay(100);
    }
    // Reading an unchanged `unknown` proposal does not prove recovery ran. Require a completed reconciliation on
    // each restart; an absent ID must report this exact key unknown, rather than merely stay unknown until shutdown.
    let reconciliation;
    for (const deadline = Date.now() + 20_000; ;) {
      reconciliation = await bounded(owner.call('recover'), 'Recovery RPC');
      if (reconciliation.ok) break;
      assert.ok(reconciliation.kind === 'busy' && Date.now() < deadline, JSON.stringify(reconciliation));
      await delay(100);
    }
    if (boundary === 'before-id') {
      assert.deepEqual(reconciliation.value.map(({ key, outcome, status }) => ({ key, outcome, status })),
        [{ key: operationKey, outcome: 'unknown', status: null }]);
    }
    const expected = boundary === 'after-id' ? 'executed' : 'unknown';
    assert.equal(recovered.value.state, expected, JSON.stringify(recovered));
    const replay = await call(`${agent}/proposals/${view.id}/execute`, {});
    assert.equal(replay.body.value.proposal.state, expected, JSON.stringify(replay.body));
    assert.equal(replay.body.value.proposal.operations.length, 1);
    assert.equal(replay.body.value.proposal.operations[0].correlationId, boundary === 'after-id' ? witness.correlationId : null);
    const overview = await call(agent + '/overview'); assert.equal(overview.body.value.policy.policy.frozen, true);
    assert.deepEqual(stack.portfolio.treasuryBalances(), settledBalances);
    assert.equal(stack.portfolio.swaps.length, 1);
    const sends = stack.portfolio.requests.filter(r => r.path.endsWith('/swap') && r.body?.dry !== true);
    assert.equal(sends.length, 1, 'Count all send attempts, including refused or duplicate calls');
    const history = await fetch(origin + agent + '/activity.csv', { headers: { cookie }, signal: AbortSignal.timeout(15_000) });
    assert.equal(history.status, 200);
    ledger = await history.text();
    const [header, ...rows] = ledger.trim().split('\n').map(line => line.split(','));
    const payments = rows.filter(row => row[header.indexOf('type')] === 'swap');
    assert.equal(payments.length, 1);
    assert.equal(payments[0][header.indexOf('correlationId')], witness.correlationId);
    assert.equal(payments[0][header.indexOf('amountIn')], '1000000');
    assert.equal(payments[0][header.indexOf('amountOut')], swap.amountOut);
    restarts.push({ pass, reconciliation: reconciliation.value, proposal: recovered.value, balances: stack.portfolio.treasuryBalances() });
    await kill(treasury); await kill(executor);
  }
  const auditText = readFileSync(join(state, 'audit.jsonl'), 'utf8');
  const { verifyChain } = await import(pathToFileURL(join(app, 'src/chain.ts')).href);
  const audit = verifyChain(auditText); assert.equal(audit.ok, true);
  const executions = auditText.trim().split('\n').map(line => JSON.parse(line).entry)
    .filter(entry => entry.action === 'execute' && entry.subject === view.id);
  assert.deepEqual(executions.map(entry => entry.stage), ['attempt'], 'Killed execution has no acknowledgement result; recovery never resubmits');
  process.send({ boundary, sends: 1, restarts: restarts.length, providerAlive: true,
    killed: ['Treasury server', 'platform executor'], witness, initial, settledBalances, swap,
    journalBefore, journalAfter: readFileSync(journalPath, 'utf8'), recovery: restarts, audit, ledger });
} finally {
  Server.prototype.emit = originalEmit;
  held?.res.destroy();
  try {
    await Promise.all(children.map(async ({ child, exited }) => {
      if (child.exitCode === null && !child.signalCode && child.pid !== undefined) child.kill('SIGKILL');
      await bounded(exited, 'Server cleanup', 5000);
      child.stdout?.destroy(); child.stderr?.destroy();
    }));
  } finally {
    await stack?.close();
    process.disconnect?.();
  }
}
