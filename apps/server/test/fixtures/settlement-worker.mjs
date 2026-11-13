// Test-only provider adapter: native sandbox transfers, fixture policy/grant responses.
// Imports the pinned platform without changing its runtime bytes.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Near } from 'near-kit';

const config = await new Promise(resolve => process.once('message', resolve));
const load = path => import(pathToFileURL(join(config.platform, path)).href);
const { api } = await load('src/api.ts');
const { dispatch, LocalRefusal } = await load('src/agent.ts');
const { acquireMoneyLock, MoneyLockBusy, UnresolvedOperations } = await load('src/lock.ts');
const { readOps } = await load('src/ops.ts');
const { recover } = await load('src/recover.ts');
const { ASSETS, payoutPolicy } = await load('src/policy.ts');
const { authorityFixture, policyView } = await load('test/fixtures/authority.ts');
const { recipientChain } = await load('src/recipients.ts');
const near = new Near({ network: { networkId: 'sandbox', rpcUrl: config.rpcUrl }, privateKey: config.secretKey, defaultSignerId: config.signer });
const rpc = async (method, params) => {
  const response = await fetch(config.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'settlement', method, params }), signal: AbortSignal.timeout(15_000) });
  const body = await response.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
};
Object.assign(api, authorityFixture());
recipientChain.exists = async account => { await rpc('query', { request_type: 'view_account', account_id: account, finality: 'final' }); return true; };
const policy = { ...payoutPolicy([config.recipient]), frozen: config.frozen === true };
api.getPolicy = async () => policyView(policy);
// This adapter maps one fixture USDC raw unit to 10^18 yoctoNEAR. It does not emulate token custody.
assert.equal(BigInt(config.amount), BigInt(config.requestAmount) * 10n ** 18n);
api.getBalances = async () => ({ balances: [{ asset_id: ASSETS.USDC, balance_raw:
  (BigInt((await rpc('query', { request_type: 'view_account', account_id: config.signer, finality: 'final' })).amount) / 10n ** 18n).toString() }] });
const pause = async stage => {
  setInterval(() => {}, 1000);
  process.send({ stage });
  await new Promise(() => {});
};
api.forGrant = () => ({ transfer: async (_id, request, options) => {
  // Count attempts before rejecting a replay, even if recovery swallows the adapter's error.
  appendFileSync('adapter-sends.jsonl', JSON.stringify({ key: options.idempotencyKey, request }) + '\n', { mode: 0o600 });
  assert.equal(config.mode, 'submit', 'recovery must never call a send method');
  assert.equal(request.asset, ASSETS.USDC);
  assert.equal(request.recipient, config.recipient);
  assert.equal(request.amount, config.requestAmount);
  const result = await near.transaction(config.signer).transfer(config.recipient, BigInt(config.amount)).send({ waitUntil: 'FINAL' });
  assert.ok('SuccessValue' in result.status, JSON.stringify(result.status));
  const hash = result.transaction.hash;
  // Provider-side evidence survives loss of the reply; recovery never reads this file to invent an ID.
  writeFileSync('chain-evidence.json', JSON.stringify({ hash, signer: config.signer, recipient: config.recipient, amount: config.amount }), { mode: 0o600 });
  if (config.boundary === 'before-id') await pause('before-id');
  return { correlation_id: hash };
} });
api.getStatus = async hash => {
  if (config.mode === 'submit') await pause('after-id');
  const result = await near.getTransactionStatus(hash, config.signer, 'FINAL');
  assert.equal(result.transaction.hash, hash);
  assert.equal(result.transaction.signer_id, config.signer);
  assert.equal(result.transaction.receiver_id, config.recipient);
  assert.deepEqual(result.transaction.actions, [{ Transfer: { deposit: config.amount } }]);
  assert.ok('SuccessValue' in result.status);
  return { correlation_id: hash, agent_id: process.env.AGENT_ID, status: 'SUCCESS' };
};
if (config.mode === 'freeze-before') {
  const lock = await acquireMoneyLock();
  try {
    await assert.rejects(dispatch(lock, 'freeze-before', { method: 'transfer', request: {
      asset: ASSETS.USDC, amount: config.requestAmount, recipient: config.recipient, confidential: true,
    } }), error => error instanceof LocalRefusal && error.code === 'policy_not_in_force');
  } finally { await lock.release(); }
  assert.equal(existsSync('adapter-sends.jsonl'), false, 'a frozen policy never reaches the adapter');
  process.send({ stage: 'frozen', ops: readOps(), sends: [] });
  process.disconnect();
} else if (config.mode === 'submit') {
  const lock = await acquireMoneyLock();
  try { await dispatch(lock, 'sandbox-recovery', { method: 'transfer', request: {
    asset: ASSETS.USDC, amount: config.requestAmount, recipient: config.recipient, confidential: true,
  } }); } finally { await lock.release(); }
  throw new Error('submission unexpectedly completed instead of reaching the crash boundary');
} else {
  // proper-lockfile intentionally delays takeover of a killed executor's money lock.
  let recovery;
  for (let attempt = 0; ; attempt++) {
    try { recovery = await recover(); break; }
    catch (error) {
      if (!(error instanceof MoneyLockBusy) || attempt >= 80) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  let blocked = false;
  try { await (await acquireMoneyLock()).release(); }
  catch (error) { if (!(error instanceof UnresolvedOperations)) throw error; blocked = true; }
  const sends = readFileSync('adapter-sends.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
  process.send({ stage: 'recovered', recovery: recovery.map(({ outcome, status }) => ({ outcome, status })), ops: readOps(), blocked, sends });
  process.disconnect();
}
