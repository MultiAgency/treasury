/** The guided-run fixture: one Treasury and one payout agent, every request intercepted. No executor or wallet starts. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { rpcAnswer, rpcBody, rpcEvents } = require('./rpc.cjs');
const { planEvent, savedEvent, actionEvent } = require('./plans.cjs');
const digest = 'sha256:' + 'a'.repeat(64);
const paymentId = 'demo-payment-fixture';
// A saved plan's identifier is a UUID, so the page address can keep it.
const planId = '0f0e0d0c-0b0a-4908-8706-050403020100';
const operationId = 'demo-swap-fixture';
const usdc = { asset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', symbol: 'USDC', decimals: 6 };
const near = { asset: 'near', symbol: 'NEAR', decimals: 24 };
const payment = { recipient: 'payee.near', asset: usdc.asset, amount: '1000000', confidential: true };
const grantLabel = (kind, state) => state.wrongPurpose ? 'approval' : kind === 'treasury' ? 'treasury' : 'payout';
const budget = Object.fromEntries(['daily', 'weekly', 'monthly'].map(period => [period,
  { limit_usd: '100', remaining_usd: '90', spent_usd: '10', resets_at: null },
]));

function overview(kind, state) {
  return { agentId: kind, area: kind, digest, notInForce: state.notInForce ? 'Policy is not in force.' : null,
    agreed: state.noPayees ? [] : ['payee.near'], unmanaged: [],
    grants: state.unverifiedGrant ? [] : [{ grant_id: 'grant-fixture', label: grantLabel(kind, state),
      expires_at: state.expired ? '2020-01-01T00:00:00Z' : '2030-01-01T00:00:00Z', revoked_at: state.revoked ? '2026-10-01T00:00:00Z' : null, agent_id: 'fixture', wallet_id: 'agent.near', owner_epoch: 1, owner_message: {}, issued_at: '2026-10-01T00:00:00Z' }],
    rebalance: { minLegUsd: 1, maxCostBps: 100 }, target: { [usdc.asset]: 0.5, near: 0.5 },
    book: [{ ...usdc, public: 0n, confidential: state.empty ? 0n : 10000000n, usd: state.empty ? 0 : 10, price: 1, priceUpdatedAt: null, priceExpiresAt: null }],
    policy: { status: 'APPLIED', revision: 1, policy: { actions: kind === 'treasury' ? ['swap', 'transfer'] : ['transfer'],
      frozen: false, owner_approval: true, destinations: { mode: 'only', list: [{ action: 'transfer', address: 'payee.near', confidential: true }] },
      assets: 'any', budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, limits: {}, confidential: false, max_actions_per_hour: 10, timelock_ms: 0 }, usage: { budget, timelock: { delay_ms: 0, scheduled_count: 0 } }, cooldowns: { policy_change_available_at: null, unfreeze_available_at: null }, wallet_id: 'agent.near', provider_policy_synced: true },
  };
}

async function openRun(browser, root, routePath, options = {}) {
  const context = await browser.newContext({ viewport: { width: options.width || 390, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  if (options.clock) await page.clock.install();
  const calls = [], writes = [], errors = [], requests = [];
  const state = { ...options, submitted: false, settled: false };
  page.on('pageerror', error => errors.push(error.message));
  // A fixture assertion (an unexpected RPC, a published-schema mismatch) fails the scenario through `errors`.
  await page.route('**/*', route => answer(route).catch(error => { errors.push(`fixture: ${error.message}`); return route.abort(); }));
  async function answer(route) {
    const url = new URL(route.request().url());
    if (url.hostname !== 'frontend.test') return route.abort();
    const pathname = url.pathname;
    requests.push(pathname);
    if (pathname === '/gw/me') return route.fulfill({ json: {
      agents: ['treasury', 'payables'].map(name => ({ name, area: name, owner: 'owner.near', dao: false })),
      invoices: 'https://invoices.example', viewer: state.public ? null : { account: 'owner.near',
        access: Object.fromEntries(['treasury', 'payables'].map(name => [name, { canSign: !state.member, canPropose: !state.member, canVote: !state.member, canExecute: !state.member, canManage: !state.member }])) },
    } });
    if (pathname.includes('/rpc/')) {
      const method = pathname.split('/rpc/')[1];
      const kind = pathname.includes('/payables/') ? 'payables' : 'treasury';
      calls.push(method);
      if (method === state.error) return route.fulfill({ status: 500, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Fixture observation unavailable' } } });
      const setup = { agentId: kind, wallet: kind + '.near', owner: { type: 'near', account_id: 'owner.near', public_key: 'ed25519:fixture' }, executor: !state.approveOnly,
        grant: state.noGrant ? null : { id: 'grant-fixture', label: grantLabel(kind, state), expiresAt: state.expired ? '2020-01-01T00:00:00Z' : '2030-01-01T00:00:00Z' }, dao: null };
      const knownPayment = { correlationId: paymentId, kind: 'payout', approvalId: 'approval-fixture', at: '2026-10-14T12:00:00Z', request: payment };
      const values = { setup, instance: { agentId: kind, executor: !state.approveOnly }, overview: overview(kind, state),
        'treasury/get': null, unresolved: state.unresolved ? [{ kind: kind === 'treasury' ? 'swap' : 'payout', key: 'unresolved-fixture', at: '2026-10-14T12:00:00Z', status: 'PROCESSING', request: {}, sent: false }] : [],
        held: (state.held || state.submitted) && !state.settled ? [knownPayment] : [],
        'inbox/list': [], 'agreements/list': [], activity: [
          { kind: 'swap', correlationId: 'unrelated-operation', planId: 'another-plan', at: '2026-10-15T12:00:00Z', status: 'SUCCESS', request: {} },
          ...(state.executed && !state.rejected ? [
            { kind: 'shield', correlationId: 'demo-shield-fixture', planId, at: '2026-10-14T11:59:00Z', status: 'SUCCESS', request: {} },
            { kind: 'swap', correlationId: state.interrupted ? undefined : operationId, planId, at: '2026-10-14T12:00:00Z', status: state.interrupted ? undefined : 'SUCCESS', request: {} },
          ] : []),
        ],
        invoices: [], reconcileBooks: [], 'owner/pending': [], 'owner/actions': [],
        paymentHistory: { items: state.held || state.submitted ? [knownPayment] : [], complete: true },
        paymentStatus: { status: state.settled ? 'SUCCESS' : 'PENDING_APPROVAL', request: payment, approvalId: 'approval-fixture', expiresAt: '2030-01-01T00:00:00Z', failureCode: null, createdAt: null, updatedAt: null, detailError: null, evidence: { txHash: null, destinationTxHash: null, refundTxHash: null, refundTo: null, refundedAmount: null } },
        'strategy/get': { strategy: { targetBps: { [usdc.asset]: 5000, near: 5000 }, minLegUsd: 1, maxCostBps: 100, autopilot: { everyMin: 60, maxUsd: 10 } },
              digest, grantSuffix: 'fixture', executor: !state.approveOnly, on: false, grantMatches: false, unresolved: 0, grant: null, observedAt: new Date().toISOString(),
              readiness: { state: 'authorization-required', canEnable: false, reasons: ['The saved strategy has no matching grant.'] } },
            policyHistory: [], 'autopilot/get': { on: false, everyMin: 60, maxUsd: 10, lastRun: null, nextRun: null }, 'autopilot/evidence': { ticks: [], corrupt: [] },
      };
      if (method === 'paymentStatus') assert.equal(route.request().postDataJSON().json.correlationId, paymentId, 'follow the selected operation');
      if (method === 'pay') {
        assert.ok(state.allowPay, 'only the explicit payment scenario may submit');
        writes.push({ method, input: route.request().postDataJSON().json });
        if (state.payRefused) return route.fulfill({ json: rpcAnswer(method, { outcome: 'refused', code: 'insufficient_balance' }) });
        state.submitted = true;
        return route.fulfill({ json: rpcAnswer(method, { outcome: 'settled', correlationId: paymentId, status: 'PENDING_APPROVAL', failureCode: null }) });
      }
      if (method === 'rebalance' || method === 'executePlan') {
        assert.ok(state.allowRebalance, 'only the explicit rebalance scenario may preview or execute');
        writes.push({ method, input: route.request().postData() ? route.request().postDataJSON().json : undefined });
        if (method === 'executePlan') state.executed = true;
        if (method === 'executePlan' && state.interrupted) return route.fulfill({ status: 500, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Execution response interrupted' } } });
        const legs = [{ from: usdc, to: near, amount: '1000000', usd: 1 }];
        const quotes = [{ type: 'quote', leg: 0, amountOut: '1000000000000000000000000', minAmountOut: '990000000000000000000000', costBps: 5, worstCostBps: 100, skipped: false }];
        const events = method === 'rebalance' && state.noLegs ? [planEvent({ legs: [], budget: 90 })] : method === 'rebalance'
          ? [planEvent({ legs, budget: 90 }), ...quotes, savedEvent({ id: planId, expiresAt: '2030-01-01T00:00:00Z', legs, quotes, steps: [0] })]
          : state.rejected ? [{ type: 'rejected', problems: ['The reviewed policy changed.'] }] : [actionEvent({ index: 0, status: 'SUCCESS', correlationId: operationId })];
        return route.fulfill({ contentType: 'text/event-stream', body: rpcEvents(method, events) });
      }
      return route.fulfill({ json: rpcBody(values, method) });
    }
    if (pathname.startsWith('/static/')) return route.fulfill({ path: root + pathname,
      contentType: pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'font/woff2' });
    return route.fulfill({ path: path.join(root, 'index.html'), contentType: 'text/html' });
  }
  await page.goto('http://frontend.test' + routePath);
  return { page, context, calls, writes, errors, requests, state };
}

module.exports = { openRun, overview, digest, paymentId, planId, operationId, usdc, near, payment };
