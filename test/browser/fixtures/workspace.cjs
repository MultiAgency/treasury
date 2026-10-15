const assert = require('node:assert/strict');
const { join } = require('node:path');
const { rpcValue } = require('./rpc.cjs');
const { makeTick, recordingFor } = require('./run.cjs');

/** Fresh presentation evidence; each suite still declares its own allowed RPCs and overrides. */
function workspaceEvidence({ policyDetails = false, grants = false } = {}) {
  const budget = Object.fromEntries(['daily', 'weekly', 'monthly'].map(period => [period,
    { limit_usd: '100', remaining_usd: '90', spent_usd: '10' },
  ]));
  const setup = { agentId: 'fixture', wallet: 'agent.near', owner: { type: 'near', account_id: 'owner.near' },
    grant: { label: 'treasury', expiresAt: '2030-01-01T00:00:00Z' }, dao: null };
  const overview = kind => ({ agentId: 'fixture', digest: 'fixture', notInForce: null, agreed: [], unmanaged: [], ...(grants && { grants: [] }),
    rebalance: { minLegUsd: 1, maxCostBps: 100 }, target: { usdc: 1 },
    book: [{ asset: 'usdc', symbol: 'USDC', decimals: 6, public: '0', confidential: '10000000', usd: 10, price: 1 }],
    policy: { policy: { actions: kind === 'treasury' ? ['swap', 'transfer'] : ['transfer'], frozen: false,
      destinations: { mode: 'only', list: [] }, assets: 'any', ...(policyDetails && { budget: {}, limits: {} }) },
      ...(policyDetails && { revision: 1 }), usage: { budget }, cooldowns: {} },
  });
  return { budget, setup, overview };
}

/** Shared transport only: no default RPC response, write handler, or missing-evidence repair. */
function workspaceOpener(root, { budget, values, proposals = false }) {
  return async function open(context, routePath, options = {}) {
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    if (options.clock) await page.clock.install();
    const calls = [], requests = [], errors = [];
    const state = { error: options.error, delay: options.delay,
      agents: options.onlyPayables ? ['payables'] : ['treasury', 'payables'], deniedAgent: null };
    const run = makeTick(options.outcome || 'quiet', budget);
    if (options.oldRun) {
      run.at = '2020-01-01T00:00:00Z';
      run.end.endedAt = run.at;
      run.end.before.at = run.at;
      run.end.after.at = run.at;
    }
    let gatewayReads = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const { hostname, pathname } = new URL(route.request().url());
      if (hostname !== 'frontend.test') return route.abort();
      if (pathname === '/gw/me') {
        if (++gatewayReads > 1 && options.invoiceLinkError) return route.fulfill({ status: 503, json: { error: 'Invoice link unavailable' } });
        return route.fulfill({ json: {
          agents: state.agents.map(name => ({ name, owner: 'owner.near', dao: Boolean(options.dao) })),
          invoices: options.noInvoiceLink ? null : 'https://invoices.example', viewer: options.public ? null : { account: 'owner.near',
            access: Object.fromEntries(state.agents.map(name => [name, { canSign: !options.dao && !(options.member && name === 'payables'), canPropose: !(options.member && name === 'payables'), canVote: !(options.member && name === 'payables'), canExecute: !(options.member && name === 'payables'), canManage: !(options.member && name === 'payables') }])) },
        } });
      }
      if (proposals && pathname === '/gw/proposals') return route.fulfill({ json: options.proposals || [] });
      if (pathname.includes('/rpc/')) {
        const method = pathname.split('/rpc/')[1];
        calls.push(method); requests.push(pathname);
        if (state.deniedAgent && pathname.startsWith(`/a/${state.deniedAgent}/rpc/`)) {
          return route.fulfill({ status: 403, json: { error: 'Fixture agent access removed', access: 'agent' } });
        }
        if (method === state.delay && (!options.onlyTreasury || pathname.includes('/treasury/'))) await new Promise(resolve => setTimeout(resolve, 2500));
        if (page.isClosed()) return;
        if (method === state.error && (!options.onlyTreasury || pathname.includes('/treasury/'))) {
          return route.fulfill({ status: 500, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Fixture read unavailable' } } });
        }
        if (method === 'autopilot/log') {
          assert.equal(route.request().postDataJSON().json.tickId, run.id, 'recording read must select the displayed run');
          assert.ok(!options.approveOnly, 'approve-only views must not read recordings');
          return route.fulfill({ json: { json: recordingFor(run) } });
        }
        const kind = pathname.includes('/payables/') ? 'payables' : 'treasury';
        const declared = values(kind, options, state, run);
        if (options.oldRun && method === 'autopilot/evidence') {
          const input = route.request().postData() || new URL(route.request().url()).search;
          declared[method] = { ticks: input.includes('since') ? [] : [run], corrupt: [] };
        }
        return route.fulfill({ json: { json: rpcValue(declared, method) } });
      }
      if (pathname.startsWith('/static/')) return route.fulfill({ path: join(root, pathname),
        contentType: pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'font/woff2' });
      if (pathname.startsWith('/gw/')) throw new Error('Unexpected gateway request: ' + pathname);
      return route.fulfill({ path: join(root, 'index.html'), contentType: 'text/html' });
    });
    await page.goto('http://frontend.test' + routePath);
    return { page, calls, requests, errors, state };
  };
}
module.exports = { workspaceEvidence, workspaceOpener };
