/** Offline task journeys. Run through test/browser/run.cjs to retain failure diagnostics. */
const { runTask } = require('./fixtures/task.cjs');
const { rpcValue } = require('./fixtures/rpc.cjs');
const assert = require('node:assert/strict');
require('tsx/cjs');
const { tickLog } = require('../../src/agui.ts');
const { parseJournalHistory } = require('../../src/journal-history.ts');
const { assertResponsive } = require('./fixtures/layout.cjs');

async function runProgress(browser, root) {
  const at = new Date(Date.now() - 120_000).toISOString(), end = new Date(Date.now() - 60_000).toISOString();
  const context = { id: 'tick-1', agentId: 'fixture', at, trigger: 'schedule', schedule: { on: true, everyMin: 60, maxUsd: 10, lastRun: null },
    build: { deployment: null, source: 'fixture', lockfile: null, packageJson: null }, policy: { revision: 1, digest: 'fixture', status: 'APPLIED' }, strategy: 'fixture', grant: null };
  const metadata = (ref, time) => ({ eventId: ref, source: 'tick', recordRef: ref, recordedAt: time, observedAt: null, timing: time ? 'recorded' : 'unknown' });
  const recording = { schemaVersion: 1, aguiVersion: '1.0.2', agentId: 'fixture', tickId: 'tick-1', exportedAt: new Date().toISOString(), completion: 'recorded-end', context,
    display: { asOf: end, assets: [] }, gaps: [{ code: 'association_missing' }], events: [
      { type: 'RUN_STARTED', threadId: 'tick:fixture:tick-1', runId: 'tick-1', timestamp: Date.parse(at), metadata: metadata('start', at) },
      { type: 'CUSTOM', name: 'treasury.observation', metadata: metadata('send', null), value: { stage: 'send', index: 0, correlationId: 'op-1', status: 'SENT', failureCode: null, historySource: 'journal', history: [], untimedHistory: [] } },
      { type: 'RUN_FINISHED', threadId: 'tick:fixture:tick-1', runId: 'tick-1', timestamp: Date.parse(end), metadata: metadata('end', end), result: { outcome: 'awaiting outcome', refusal: null, rejected: [] } },
    ], laterObservations: [{ correlationId: 'op-1', source: 'journal', record: { line: 1, recordedAt: new Date(Date.parse(end) + 30_000).toISOString(), idempotencyKey: 'key-1', type: 'status', status: 'SUCCESS' } }] };
  function acceptedRecording(conflict) {
    const acceptedAt = new Date(Date.parse(at) + 5000).toISOString();
    const settledAt = new Date(Date.parse(end) + 1000).toISOString();
    const rows = [
      { at, idempotencyKey: 'accepted-key', kind: 'autopilot', method: 'shield', request: {} },
      { at: acceptedAt, idempotencyKey: 'accepted-key', correlation_id: 'accepted-op', status: 'SENT' },
      { at: settledAt, idempotencyKey: 'accepted-key', correlation_id: 'accepted-op', status: 'SUCCESS' },
    ];
    if (conflict) rows.push({ ...rows[2], idempotencyKey: 'conflicting-key' });
    return tickLog({ ...context, progressVersion: 1, end: { endedAt: end, before: { error: 'Unavailable' }, after: { error: 'Unavailable' },
      plan: null, steps: [], shields: [], rejected: [], refusal: null, outcome: 'Outcome unknown after submission' } },
      parseJournalHistory('fixture', rows.map(row => JSON.stringify(row)).join('\n')),
      { exportedAt: new Date().toISOString(), display: { asOf: end, assets: [] }, progress: [{ version: 1, agentId: 'fixture', tickId: 'tick-1', sequence: 1, at: acceptedAt,
        event: { type: 'CUSTOM', name: 'treasury.observation', value: { stage: 'submission', method: 'shield', correlationId: 'accepted-op' } } }] });
  }
  const strategy = { targetBps: { usdc: 10000 }, minLegUsd: 2, maxCostBps: 250, autopilot: { everyMin: 60, maxUsd: 10 } };
  const ready = { strategy, digest: 'fixture', grantSuffix: 'fixture', executor: true, on: true, grantMatches: false, unresolved: 0, grant: null, observedAt: at,
    readiness: { state: 'authorization-required', canEnable: false, reasons: ["The owner must issue a matching grant before this strategy can act on its schedule."] } };
  const setup = { executor: true, agentId: 'fixture', wallet: 'agent.near', owner: { type: 'near', account_id: 'owner.near' }, grant: { id: 'grant', label: 'treasury', expiresAt: '2030-01-01T00:00:00Z' }, dao: null };
  const budget = Object.fromEntries(['daily', 'weekly', 'monthly'].map(p => [p, { limit_usd: '100', remaining_usd: '90', spent_usd: '10' }]));
  const overview = { agentId: 'fixture', digest: 'fixture', grants: [], rebalance: { minLegUsd: 2, maxCostBps: 250 }, notInForce: null, agreed: [], unmanaged: [], target: { usdc: 1 },
    book: [{ asset: 'usdc', symbol: 'USDC', decimals: 6, public: '0', confidential: '10000000', usd: 10, price: 1 }],
    policy: { status: 'APPLIED', revision: 1, policy: { actions: ['swap'], frozen: false, destinations: { mode: 'only', list: [] }, assets: 'any' }, usage: { budget }, cooldowns: {} } };
  {
    const width = 390;
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    // Install before mounting: the expiry timer must be created on this clock too.
    await page.clock.install();
    let acceptedOnly = false, conflict = false;
    let progressing = false, submitted = false, completed = false, failure = false, mismatch = false, reads = 0, payables = false, agreed = true, policyBlocked = false;
    ready.grantMatches = false; ready.readiness.canEnable = false;
    const writes = [], errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()), p = url.pathname;
      if (url.hostname !== 'frontend.test') return route.abort();
      if (p === '/gw/me') return route.fulfill({ json: { agents: [{ name: 'treasury', owner: 'owner.near', dao: false }], invoices: 'https://invoices.test',
        viewer: { account: 'member.near', access: { treasury: { canSign: false, canPropose: false, canVote: false, canExecute: false, canManage: false } } } } });
      if (p.includes('/rpc/')) {
        const method = p.split('/rpc/')[1];
        if (method === 'autopilot/log') {
          reads++;
          if (failure) return route.fulfill({ status: 503, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Unavailable' } } });
          let value = completed ? structuredClone(recording) : { ...recording, completion: 'no-recorded-end', events: recording.events.slice(0,1), laterObservations: [] };
          if (progressing) {
            const stage = (type, stepName, n) => {
              const time = new Date(Date.parse(at) + n * 1000).toISOString();
              return { type, stepName, timestamp: Date.parse(time), metadata: metadata(`progress:${n}`, time) };
            };
            const stages = [stage('STEP_STARTED', 'balances-before', 1), stage('STEP_FINISHED', 'balances-before', 2), stage('STEP_STARTED', 'planning', 3)];
            if (submitted) {
              const time = new Date(Date.parse(at) + 6000).toISOString();
              stages.push(stage('STEP_FINISHED', 'planning', 4), stage('STEP_STARTED', 'execution', 5),
                { type: 'CUSTOM', name: 'treasury.observation', timestamp: Date.parse(time), metadata: metadata('progress:6', time), value: { stage: 'submission', method: 'swap', correlationId: 'op-1' } });
            }
            value.schemaVersion = 2;
            value.context = { ...value.context, progressVersion: 1 };
            value.events = [value.events[0], ...stages, ...value.events.slice(1)];
          }
          if (acceptedOnly) value = acceptedRecording(conflict);
          const tickId = route.request().postDataJSON().json.tickId;
          if (tickId === 'tick-2') {
            value.tickId = 'tick-2'; value.context = { ...context, id: 'tick-2' };
            value.events = value.events.map(e => e.type !== 'RUN_STARTED' && e.type !== 'RUN_FINISHED' ? e : { ...e, runId: 'tick-2', threadId: 'tick:fixture:tick-2' });
          }
          return route.fulfill({ json: { json: mismatch ? { ...value, agentId: 'wrong' } : value } });
        }
        const shownOverview = payables ? { ...overview, notInForce: policyBlocked ? 'frozen' : null, agreed: agreed ? ['payee.near'] : [], policy: { ...overview.policy, policy: { ...overview.policy.policy, actions: ['transfer'], destinations: { mode: 'only', list: agreed ? [{ action: 'transfer', address: 'payee.near', confidential: true }] : [] } } } } : overview;
        const values = { get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup, overview: shownOverview, 'treasury/get': null, held: [], unresolved: [], 'inbox/list': [], 'agreements/list': payables ? [{ id: 'agreement-1', status: agreed ? 'agreed' : 'proposed', origin: 'owner', at, payee: 'payee.near', amount: '1000000', terms: { maxAmount: '1000000', until: '2030-01-01T00:00:00Z' } }] : [], activity: [], 'owner/pending': [], 'owner/actions': [],
          'autopilot/get': { on: true, everyMin: 60, maxUsd: 10 }, 'strategy/get': ready,
          'autopilot/evidence': { ticks: [{ ...context, id: 'tick-2', end: null }, { ...context, end: completed ? { endedAt: end, before: { error: 'unavailable' }, after: { error: 'unavailable' }, plan: null, steps: [], shields: [], rejected: [], refusal: null, outcome: 'awaiting outcome' } : null }] } };
        if (!(method in values)) { writes.push(method); return route.abort(); }
        return route.fulfill({ json: { json: rpcValue(values, method) } });
      }
      if (p.startsWith('/static/')) return route.fulfill({ path: root + p, contentType: p.endsWith('.js') ? 'application/javascript' : p.endsWith('.css') ? 'text/css' : 'font/woff2' });
      return route.fulfill({ path: root + '/index.html', contentType: 'text/html' });
    });
    await page.goto('http://frontend.test/a/treasury/follow/run');
    await page.getByLabel('Run to view').waitFor();
    await page.getByRole('region', { name: 'Run timeline', exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'Run timeline', exact: true }).count(), 1, 'one timeline contains progress, outcome and evidence');
    await page.getByRole('button', { name: 'Refresh outcomes', exact: true }).waitFor();
    const live = page.locator('main');
    await live.getByText('Run started. No end recorded yet.', { exact: true }).waitFor();
    await page.getByLabel('Run to view').focus();
    progressing = true;
    await live.getByText('Last recorded: Planning and quoting swaps · started.', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Run to view').evaluate(e => e === document.activeElement), true);
    const stages = live.getByRole('list', { name: 'Recorded stages and submissions', exact: true });
    await stages.getByText('Checking balances', { exact: true }).waitFor();
    assert.equal(await stages.locator('li').count(), 2, 'start and return share one row; unfinished planning remains separate');
    await stages.getByText('Return recorded', { exact: true }).waitFor();
    await stages.getByText('No return recorded', { exact: true }).waitFor();
    await page.getByLabel('Run to view').focus();
    submitted = true;
    await live.getByText('Last recorded: Swap submitted · outcome not yet established.', { exact: true }).waitFor();
    await live.getByRole('link', { name: 'Inspect submitted swap', exact: true }).waitFor();
    assert.equal(await stages.locator('li').count(), 4, 'provider acceptance retains a separate operation link beside the three recorded stages');
    assert.equal(await live.getByText(/^Run outcome:/).count(), 0, 'submission cannot invent run completion');
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/progress-${width}.png`, fullPage: true });
    completed = true;
    await live.getByText('Following later operation outcomes.', { exact: true }).waitFor();
    const outcome = live.getByText('Run outcome: awaiting outcome', { exact: true });
    await outcome.waitFor();
    assert.ok((await outcome.boundingBox()).y < (await live.getByRole('button', { name: 'Refresh outcomes', exact: true }).boundingBox()).y,
      'the original run outcome leads the view before automatic update controls');
    assert.equal(await live.getByText('The book before', { exact: true }).isVisible(), false,
      'allocation, budget and receipt detail stays tucked away until requested');
    assert.ok((await outcome.boundingBox()).y < (await live.getByRole('heading', { name: 'Start a new run', exact: true }).boundingBox()).y,
      'review the selected outcome before starting another run');
    await live.getByText('Some balance or budget observations are unavailable. Review Run details.', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Run to view').evaluate(e => e === document.activeElement), true, 'refresh must preserve focus');
    await live.getByRole('link', { name: 'Inspect swap 1 in Activity', exact: true }).waitFor();
    assert.match(await page.getByRole('region', { name: 'Run timeline', exact: true }).innerText(), /Swap 1[\s\S]*success/);
    await live.getByText('Some evidence is incomplete. Open Run details to inspect the recording.', { exact: true }).waitFor();
    await live.getByText('Run details', { exact: true }).click();
    await live.getByRole('button', { name: 'Pause updates', exact: true }).click();
    await page.waitForTimeout(100); const pausedReads = reads;
    await page.waitForTimeout(3300); assert.equal(reads, pausedReads, 'paused view must stop polling');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}: overflow`);
    await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(100);
    if (process.env.SCREENSHOT_DIR || process.env.PROTO_BROWSER_ARTIFACTS) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR || '/tmp'}/live-${width}.png`, fullPage: true });
    await assertResponsive(page, "live-run");
    failure = true;
    await live.getByRole('button', { name: 'Resume updates', exact: true }).click();
    await live.getByText(/Run updates unavailable/).waitFor();
    assert.equal(await live.getByRole('link', { name: 'Inspect swap 1 in Activity', exact: true }).count(), 0, 'failed reads hide stale evidence');
    const failedReads = reads; await page.waitForTimeout(3300); assert.equal(reads, failedReads, 'errors do not retry in a loop');
    failure = false; mismatch = true;
    await live.getByRole('button', { name: 'Retry run updates', exact: true }).click();
    await page.waitForTimeout(300);
    await live.getByText(/Run updates unavailable/).waitFor();
    mismatch = false;
    await live.getByRole('button', { name: 'Retry run updates', exact: true }).click();
    await live.getByText('Following later operation outcomes.', { exact: true }).waitFor();
    acceptedOnly = true;
    await live.getByRole('button', { name: 'Refresh outcomes', exact: true }).click();
    const updates = page.getByRole('region', { name: 'Run timeline', exact: true });
    await updates.getByRole('link', { name: 'Inspect operation in Activity', exact: true }).waitFor();
    assert.match(await updates.innerText(), /Operation[\s\S]*success/);
    assert.equal(await updates.getByRole('link', { name: 'Inspect swap 1 in Activity', exact: true }).count(), 0);
    conflict = true;
    await live.getByRole('button', { name: 'Refresh outcomes', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Run timeline"]').textContent.includes('Later operation outcomes'));
    assert.equal(await updates.getByRole('link', { name: 'Inspect operation in Activity', exact: true }).count(), 0, 'conflicting identities cannot attach later settlement');
    assert.match(await updates.innerText(), /Some evidence is incomplete/);
    acceptedOnly = false;
    await page.getByLabel('Run to view').selectOption('tick-2');
    await live.getByText(/Following (this run|later operation outcomes)|Last recorded:/).first().waitFor();
    // Expiry must leave a useful read action, even if polling is paused.
    await live.getByText('Run details', { exact: true }).click();
    await live.getByRole('button', { name: 'Pause updates', exact: true }).click();
    await page.waitForTimeout(100);
    const beforeExpiry = reads;
    await page.clock.fastForward(10 * 60_000);
    await live.getByText('Automatic following ended. Refresh outcomes to read the latest recorded evidence.', { exact: true }).waitFor();
    assert.equal(reads, beforeExpiry, 'expiry does not resume paused reads');
    await live.getByRole('button', { name: 'Refresh outcomes', exact: true }).click();
    await live.getByRole('link', { name: 'Inspect swap 1 in Activity', exact: true }).waitFor();
    assert.equal(reads, beforeExpiry + 1, 'manual refresh reads once after expiry');
    await page.goto('http://frontend.test/a/treasury/');
    await page.getByRole('heading', { name: 'Latest treasury run', exact: true }).waitFor();
    await page.waitForTimeout(100); const closedReads = reads;
    await page.waitForTimeout(3300); assert.equal(reads, closedReads, 'closed view must stop polling');
    await page.goto('http://frontend.test/a/treasury/automations');
    await page.getByText('Needs owner authorization', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Follow treasury runs', exact: true }).count(), 0);
    ready.grantMatches = true; ready.readiness.canEnable = true;
    await page.reload();
    await page.getByRole('link', { name: 'Follow treasury runs', exact: true }).waitFor();
    payables = true;
    await page.goto('http://frontend.test/a/treasury/payees');
    await page.getByText('Next: share the invoice page with the agreed payee.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Open invoice page', exact: true }).getAttribute('href'), 'https://invoices.test');
    policyBlocked = true;
    await page.reload();
    await page.getByText('Agreed, invoice not filed yet', { exact: true }).waitFor();
    assert.equal(await page.getByText('Next: share the invoice page with the agreed payee.', { exact: true }).count(), 0, 'blocked policy must not advance the flow');
    policyBlocked = false; agreed = false;
    await page.reload();
    const recipient = page.getByRole('article', { name: 'Recipient payee.near', exact: true });
    await recipient.getByText('Terms saved; policy approval needed', { exact: true }).waitFor();
    assert.ok(await recipient.getByText('Not listed', { exact: true }).isVisible(), 'recorded terms and the current policy destination remain separate');
    assert.ok(await recipient.getByRole('button', { name: 'Continue policy approval', exact: true }).isVisible());
    assert.equal(await page.getByText('Next: share the invoice page with the agreed payee.', { exact: true }).count(), 0);
    assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, live: 'pass', readOnly: true, reads }));
    await page.close();
  }
}

async function inspectRecording(browser, root) {
  const at = '2026-01-01T00:00:00.000Z', end = '2026-01-01T00:01:00.000Z';
  const context = { id: 'tick-1', agentId: 'fixture', at, trigger: 'schedule', schedule: { on: true, everyMin: 60, maxUsd: 10, lastRun: null },
    build: { deployment: null, source: 'fixture', lockfile: null, packageJson: null }, policy: { revision: 1, digest: 'fixture', status: 'APPLIED' }, strategy: 'fixture', grant: null };
  const metadata = (ref, time) => ({ eventId: ref, source: 'tick', recordRef: ref, recordedAt: time, observedAt: null, timing: time ? 'recorded' : 'unknown' });
  const recording = { schemaVersion: 1, aguiVersion: '1.0.2', agentId: 'fixture', tickId: 'tick-1', exportedAt: end, completion: 'recorded-end', context,
    display: { asOf: end, assets: [] }, gaps: [{ code: 'association_missing' }], events: [
      { type: 'RUN_STARTED', threadId: 'tick:fixture:tick-1', runId: 'tick-1', timestamp: Date.parse(at), metadata: metadata('start', at) },
      { type: 'CUSTOM', name: 'treasury.observation', metadata: metadata('send', null), value: { stage: 'send', index: 0, correlationId: 'op-1', status: 'SENT', failureCode: null, historySource: 'journal', history: [], untimedHistory: [] } },
      { type: 'RUN_FINISHED', threadId: 'tick:fixture:tick-1', runId: 'tick-1', timestamp: Date.parse(end), metadata: metadata('end', end), result: { outcome: 'awaiting outcome', refusal: null, rejected: [] } },
    ], laterObservations: [{ correlationId: 'op-1', source: 'journal', record: { line: 1, recordedAt: '2026-01-01T00:02:00.000Z', idempotencyKey: 'key-1', type: 'status', status: 'SUCCESS' } }] };
  const strategy = { targetBps: { usdc: 10000 }, minLegUsd: 2, maxCostBps: 250, autopilot: { everyMin: 60, maxUsd: 10 } };
  const ready = { strategy, digest: 'fixture', grantSuffix: 'fixture', executor: true, on: true, grantMatches: false, unresolved: 0, grant: null, observedAt: at,
    readiness: { state: 'authorization-required', canEnable: false, reasons: ["The owner must issue a matching grant before this strategy can act on its schedule."] } };
  const setup = { executor: true, agentId: 'fixture', wallet: 'agent.near', owner: { type: 'near', account_id: 'owner.near' }, grant: { id: 'grant', label: 'treasury', expiresAt: '2030-01-01T00:00:00Z' }, dao: null };
  const budget = Object.fromEntries(['daily', 'weekly', 'monthly'].map(p => [p, { limit_usd: '100', remaining_usd: '90', spent_usd: '10' }]));
  const overview = { agentId: 'fixture', digest: 'fixture', grants: [], rebalance: { minLegUsd: 2, maxCostBps: 250 }, notInForce: null, agreed: [], unmanaged: [], target: { usdc: 1 },
    book: [{ asset: 'usdc', symbol: 'USDC', decimals: 6, public: '0', confidential: '10000000', usd: 10, price: 1 }],
    policy: { status: 'APPLIED', revision: 1, policy: { actions: ['swap'], frozen: false, destinations: { mode: 'only', list: [] }, assets: 'any' }, usage: { budget }, cooldowns: {} } };
  {
    const width = 390;
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const calls = [], errors = []; let mismatch = false, unavailable = false;
    let releaseRecording;
    let recordingGate = new Promise(resolve => { releaseRecording = resolve; });
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()), p = url.pathname;
      if (url.hostname !== 'frontend.test') return route.abort();
      if (p === '/gw/me') return route.fulfill({ json: { agents: [{ name: 'treasury', owner: 'owner.near', dao: false }], invoices: null,
        viewer: { account: 'member.near', access: { treasury: { canSign: false, canPropose: false, canVote: false, canExecute: false, canManage: false } } } } });
      if (p.includes('/rpc/')) {
        const method = p.split('/rpc/')[1]; calls.push(method);
        if (method === "autopilot/log") await recordingGate;
        if (method === 'strategy/get' && unavailable) return route.fulfill({ status: 500, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Readiness unavailable' } } });
        const values = { get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup, overview, 'treasury/get': null, held: [], unresolved: [], 'inbox/list': [], 'agreements/list': [], activity: [], 'owner/pending': [], 'owner/actions': [],
          'autopilot/get': { on: true, everyMin: 60, maxUsd: 10 }, 'strategy/get': ready,
          'autopilot/evidence': { ticks: [{ ...context, end: { endedAt: end, before: { error: 'unavailable' }, after: { error: 'unavailable' }, plan: null, steps: [], shields: [], rejected: [], refusal: null, outcome: 'awaiting outcome' } }] },
          'autopilot/log': mismatch ? { ...recording, agentId: 'wrong' } : recording };
        assert.ok(method in values, `Unexpected request: ${method}`);
        return route.fulfill({ json: { json: rpcValue(values, method) } });
      }
      if (p.startsWith('/static/')) return route.fulfill({ path: root + p, contentType: p.endsWith('.js') ? 'application/javascript' : p.endsWith('.css') ? 'text/css' : 'font/woff2' });
      return route.fulfill({ path: root + '/index.html', contentType: 'text/html' });
    });
    await page.goto('http://frontend.test/a/treasury/follow/run');
    await page.getByText('Run details', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Inspect recording', exact: true }).isVisible(), false, 'recording inspection starts under Run details');
    await page.getByText('Run details', { exact: true }).click();
    await page.getByRole('button', { name: 'Inspect recording', exact: true }).waitFor();
    assert.ok(!calls.includes('autopilot/log'), 'recording is fetched only on request');
    assert.equal(await page.getByRole('button', { name: 'Download recording', exact: true }).count(), 0, 'download stays inside disclosure');
    await page.getByRole('button', { name: 'Inspect recording', exact: true }).click();
    await page.getByRole('status').filter({hasText:'Loading recording…'}).waitFor();
    await page.getByRole('button', { name: 'Close recording', exact: true }).click();
    releaseRecording();
    await page.waitForTimeout(300);
    assert.equal(await page.getByRole('button', { name: 'Close recording', exact: true }).count(), 0, 'late response cannot reopen inspector');
    await page.getByRole('button', { name: 'Inspect recording', exact: true }).click();
    await page.getByRole('status').filter({hasText:'Recording loaded.'}).waitFor();
    await page.getByText('Run end recorded. Operation outcomes are shown separately.', { exact: true }).waitFor();
    await assertResponsive(page, "simplicity");
    await page.getByText('This recording has no stage observations.', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Observation', { exact: true }).isVisible(), false, 'raw event controls are secondary to the recording summary');
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download recording', exact: true }).click();
    await downloaded;
    await page.getByRole('status').filter({hasText:/Recording prepared with 1 source gap/}).waitFor();
    await page.getByText('Inspect individual observations', { exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByText('Event timing unknown', { exact: true }).waitFor();
    assert.match(await page.getByRole('status').last().innerText(), /Status at run end: SENT/);
    await page.getByText('Later journal observations (1)', { exact: true }).click();
    await page.getByText(/op-1 · SUCCESS/).waitFor();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByText('This recorded end does not prove that any operation settled.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}: recording overflow`);
    await page.getByRole('button', { name: 'Close recording', exact: true }).click();
    mismatch = true;
    await page.getByRole('button', { name: 'Inspect recording', exact: true }).click();
    await page.getByRole('status').filter({ hasText: /identity mismatch|does not match/i }).waitFor();
    assert.equal(await page.getByText('Historical · read only', { exact: true }).count(), 0, 'invalid snapshot never displays prior recording');
    await page.goto('http://frontend.test/a/treasury/automations');
    await page.getByText('Needs owner authorization', { exact: true }).waitFor();
    assert.equal(await page.getByText('Ready for scheduled runs', { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}: readiness overflow`);
    unavailable = true;
    await page.reload();
    await page.getByText('Readiness unavailable', { exact: true }).waitFor();
    assert.equal(await page.getByText('Needs owner authorization', { exact: true }).count(), 0);
    assert.ok(!calls.some(call => /(?:^|\/)(?:tick|set|save|enable|prepare|recover)$/.test(call)), 'inspection must never mutate');
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: read-only recording, source gaps, unknown timing, later outcomes, identity refusal, readiness and unavailable reads`);
    await page.close();
  }
}

runTask([runProgress, inspectRecording]);
