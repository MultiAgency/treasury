// Use the production read-only adapter so timeline and recording fixtures share one run.
require('tsx/cjs');
const { tickLog } = require('../../../src/agui.ts');

function makeTick(outcome, budget) {
  const at = new Date().toISOString();
  const seen = { at, book: [], weightsBps: {}, targetBps: {}, driftBps: 0, budget, unresolved: 0 };
  const start = {
    id: 'fixture-run', agentId: 'fixture', at, trigger: 'schedule',
    schedule: { on: true, everyMin: 60, maxUsd: 10, lastRun: null },
    policy: { revision: 1, digest: 'fixture', status: 'APPLIED' }, strategy: 'fixture', grant: null,
    build: { deployment: 'offline-fixture', source: 'fixture', lockfile: null, packageJson: null },
  };
  if (outcome === 'unknown') return { ...start, at: '2020-01-01T00:00:00Z', end: null };
  return { ...start, end: { endedAt: at, before: seen, after: seen,
    plan: outcome === 'failed' ? { id: 'fixture-plan', usd: 1, legs: [{ amount: '1000000', amountOut: '1000000', minAmountOut: '1000000', from: 'usdc', to: 'usdc', costBps: 0 }] } : null,
    steps: outcome === 'failed' ? [{ index: 0, status: 'FAILED', correlationId: 'fixture-operation', failureCode: null }] : [],
    shields: [], rejected: [], refusal: outcome === 'refused' ? 'spend_budget_exceeded' : null,
    outcome: outcome === 'quiet' ? 'book on target' : outcome,
  } };
}

function recordingFor(tick) {
  const exportedAt = new Date().toISOString();
  return tickLog(tick, { agentId: tick.agentId, records: [], gaps: [] }, {
    exportedAt, display: { asOf: exportedAt, assets: [{ asset: 'usdc', symbol: 'USDC', decimals: 6 }] },
  });
}

module.exports = { makeTick, recordingFor };
