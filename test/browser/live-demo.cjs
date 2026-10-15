/** Offline live-demo regressions. All browser traffic is intercepted; no executor or wallet starts. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('./fixtures/browser.cjs');
const { rpcValue } = require('./fixtures/rpc.cjs');
const { openWorkspaceNavigation } = require('./fixtures/navigation.cjs');
const { expect } = require('@playwright/test');
const root = path.resolve(process.argv[2] || 'web/dist');
const digest = 'sha256:' + 'a'.repeat(64);
const paymentId = 'demo-payment-fixture';
const planId = 'demo-plan-fixture';
const operationId = 'demo-swap-fixture';
const usdc = { asset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', symbol: 'USDC', decimals: 6 };
const near = { asset: 'near', symbol: 'NEAR', decimals: 24 };
const payment = { recipient: 'payee.near', asset: usdc.asset, amount: '1000000', confidential: true };
const grantLabel = (kind, state) => state.wrongPurpose ? 'approval' : kind === 'treasury' ? 'treasury' : 'payout';
const budget = Object.fromEntries(['daily', 'weekly', 'monthly'].map(period => [period,
  { limit_usd: '100', remaining_usd: '90', spent_usd: '10' },
]));

function overview(kind, state) {
  return { agentId: kind, area: kind, digest, notInForce: state.notInForce ? 'Policy is not in force.' : null,
    agreed: state.noPayees ? [] : ['payee.near'], unmanaged: [],
    grants: state.unverifiedGrant ? [] : [{ grant_id: 'grant-fixture', label: grantLabel(kind, state),
      expires_at: state.expired ? '2020-01-01T00:00:00Z' : '2030-01-01T00:00:00Z', revoked_at: state.revoked ? '2026-10-01T00:00:00Z' : null }],
    rebalance: { minLegUsd: 1, maxCostBps: 100 }, target: { [usdc.asset]: 0.5, near: 0.5 },
    book: [{ ...usdc, public: '0', confidential: state.empty ? '0' : '10000000', usd: state.empty ? 0 : 10, price: 1 }],
    policy: { status: 'APPLIED', revision: 1, policy: { actions: kind === 'treasury' ? ['swap', 'transfer'] : ['transfer'],
      frozen: false, owner_approval: true, destinations: { mode: 'only', list: [{ action: 'transfer', address: 'payee.near', confidential: true }] },
      assets: 'any', budget: {}, limits: {} }, usage: { budget }, cooldowns: {} },
  };
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    async function open(routePath, options = {}) {
      const context = await browser.newContext({ viewport: { width: options.width || 390, height: 900 } });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      if (options.clock) await page.clock.install();
      const calls = [], writes = [], errors = [], requests = [];
      const state = { ...options, submitted: false, settled: false };
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
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
          const setup = { agentId: kind, wallet: kind + '.near', owner: { type: 'near', account_id: 'owner.near' }, executor: !state.approveOnly,
            grant: state.noGrant ? null : { id: 'grant-fixture', label: grantLabel(kind, state), expiresAt: state.expired ? '2020-01-01T00:00:00Z' : '2030-01-01T00:00:00Z' }, dao: null };
          const knownPayment = { correlationId: paymentId, approvalId: 'approval-fixture', at: '2026-10-14T12:00:00Z', request: payment };
          const values = { setup, instance: { agentId: kind, executor: !state.approveOnly }, overview: overview(kind, state),
            'treasury/get': null, unresolved: state.unresolved ? [{ key: 'unresolved-fixture', at: '2026-10-14T12:00:00Z', status: 'PROCESSING' }] : [],
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
            paymentStatus: { status: state.settled ? 'SUCCESS' : 'PENDING_APPROVAL', request: payment, approvalId: 'approval-fixture', expiresAt: '2030-01-01T00:00:00Z' },
            'strategy/get': null, 'autopilot/get': { on: false, everyMin: 60, maxUsd: 10 }, 'autopilot/evidence': { ticks: [] },
          };
          if (method === 'paymentStatus') assert.equal(route.request().postDataJSON().json.correlationId, paymentId, 'follow the selected operation');
          if (method === 'pay') {
            assert.ok(state.allowPay, 'only the explicit payment scenario may submit');
            writes.push({ method, input: route.request().postDataJSON().json });
            if (state.payRefused) return route.fulfill({ json: { json: { outcome: 'refused', code: 'insufficient_balance' } } });
            state.submitted = true;
            return route.fulfill({ json: { json: { outcome: 'sent', correlationId: paymentId, status: 'PENDING_APPROVAL' } } });
          }
          if (method === 'rebalance' || method === 'executePlan') {
            assert.ok(state.allowRebalance, 'only the explicit rebalance scenario may preview or execute');
            writes.push({ method, input: route.request().postData() ? route.request().postDataJSON().json : undefined });
            if (method === 'executePlan') state.executed = true;
            if (method === 'executePlan' && state.interrupted) return route.fulfill({ status: 500, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Execution response interrupted' } } });
            const events = method === 'rebalance' && state.noLegs ? [{ type: 'plan', legs: [], budget: 90 }] : method === 'rebalance' ? [
              { type: 'plan', legs: [{ from: usdc, to: near, amount: '1000000', usd: 1 }], budget: 90 },
              { type: 'quote', leg: 0, amountOut: '1000000000000000000000000', minAmountOut: '990000000000000000000000', costBps: 5, worstCostBps: 100, skipped: false },
              { type: 'saved', plan: { id: planId, expiresAt: '2030-01-01T00:00:00Z' }, steps: [0] },
            ] : state.rejected ? [{ type: 'rejected', problems: ['The reviewed policy changed.'] }] : [{ type: 'action', index: 0, status: 'SUCCESS', correlationId: operationId }];
            return route.fulfill({ contentType: 'text/event-stream', body: events.map(json => `data: ${JSON.stringify({ json })}\n\n`).join('') });
          }
          return route.fulfill({ json: { json: rpcValue(values, method) } });
        }
        if (pathname.startsWith('/static/')) return route.fulfill({ path: root + pathname,
          contentType: pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'font/woff2' });
        return route.fulfill({ path: path.join(root, 'index.html'), contentType: 'text/html' });
      });
      await page.goto('http://frontend.test' + routePath);
      return { page, context, calls, writes, errors, requests, state };
    }

    for (const width of [320, 1280]) {
      const { page, context, writes, errors } = await open('/', { width });
      const entry = page.getByRole('link', { name: 'Run with real funds', exact: true });
      for (const name of ['payables', 'treasury']) {
        const disclosure = page.locator('details').filter({ has: page.locator(`a[href="/a/${name}/demo"]`) });
        await disclosure.locator('summary').waitFor();
        assert.equal(await disclosure.evaluate(element => element.open), false, 'guided walkthrough stays secondary on Home');
        await disclosure.getByText('Guided walkthrough', { exact: true }).click();
      }
      await entry.first().waitFor();
      assert.equal(await entry.count(), 2, 'each area has its own live-demo entry');
      const hrefs = await entry.evaluateAll(links => links.map(link => link.getAttribute('href')).sort());
      assert.deepEqual(hrefs, ['/a/payables/demo', '/a/treasury/demo']);
      await page.locator('a[href="/a/treasury/demo"]').click();
      await page.getByRole('heading', { name: 'Run with real funds', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Check this agent', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Preview and execute a rebalance', exact: true }).waitFor();
      const area = page.getByRole('navigation', { name: 'Area', exact: true });
      assert.deepEqual(await area.getByRole('link').allTextContents(), ['Overview', 'Strategy']);
      assert.equal(await area.locator('[aria-current="page"]').count(), 0);
      const help = page.getByRole('button', { name: 'Help', exact: true });
      assert.equal(await help.getAttribute('aria-expanded'), 'false', 'deep demo route does not cover its content with Help');
      assert.equal(await help.getAttribute('aria-current'), 'page');
      await help.click();
      assert.equal(await page.getByRole('menuitem', { name: 'Guided walkthrough', exact: true }).getAttribute('aria-current'), 'page');
      await page.keyboard.press('Escape');
      await openWorkspaceNavigation(page);
      assert.deepEqual(await page.getByRole('navigation', { name: 'Workspace', exact: true }).locator('[aria-current="page"]').allTextContents(), ['Portfolio']);
      if (width < 1024) await page.keyboard.press('Escape');
      await page.reload();
      await page.getByRole('heading', { name: 'Run with real funds', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(writes, [], 'entry and reload must not preview, execute, send, or approve');
      assert.deepEqual(errors, []);
      if (process.env.PROTO_BROWSER_ARTIFACTS) await page.screenshot({ path: `/tmp/live-demo-treasury-${width}.png`, fullPage: true });
      await context.close();
      console.log(`PASS ${width}px: per-agent Home entry, selected walkthrough navigation, reload and no mutation`);
    }

    {
      const width = 390;
      const { page, context, writes, errors } = await open('/a/treasury/demo', { allowRebalance: true, width });
      const preview = page.getByRole('button', { name: 'Preview', exact: true });
      const execute = page.getByRole('button', { name: 'Execute', exact: true });
      await expect(preview).toBeEnabled();
      assert.deepEqual(writes, []);
      await page.getByText(/No plan selected in this walkthrough/).waitFor();
      await expect(execute).toBeDisabled();
      await preview.click();
      await expect(execute).toBeEnabled();
      assert.deepEqual(writes.map(write => write.method), ['rebalance'], 'preview only saves a plan');
      await expect(page.getByText('Estimated received 1 NEAR · Minimum received 0.99 NEAR', { exact: true })).toBeVisible();
      await expect(page.getByText('Estimated cost 0.05% · Maximum cost 1%', { exact: true })).toBeVisible();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}: rebalance preview fits`);
      if (process.env.PROTO_BROWSER_ARTIFACTS) await page.screenshot({ path: `/tmp/rebalance-preview-${width}.png`, fullPage: true });
      await execute.click();
      const review = page.getByRole('dialog', { name: 'Execute the previewed rebalance on mainnet?', exact: true });
      await review.waitFor();
      await review.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(writes.length, 1, 'cancelling does not execute');
      assert.equal(await page.getByRole('heading', { name: 'This plan’s operations', exact: true }).count(), 0, 'cancelling does not select operation results');
      await execute.click();
      await review.getByRole('button', { name: 'Execute swaps', exact: true }).click();
      const follow = page.getByRole('link', { name: 'Follow this swap', exact: true });
      await follow.waitFor();
      const planRecords = page.locator('section').filter({ has: page.getByRole('heading', { name: 'This plan’s operations', exact: true }) }).last();
      await planRecords.locator(`#operation-${operationId}`).waitFor();
      await planRecords.locator('#operation-demo-shield-fixture').waitFor();
      assert.equal(await planRecords.locator('#operation-unrelated-operation').count(), 0, 'newer unrelated activity never becomes the selected outcome');
      assert.deepEqual(writes.map(write => write.method), ['rebalance', 'executePlan']);
      assert.deepEqual(writes[1].input, { planId }, 'execute exactly the reviewed saved plan');
      assert.equal(await follow.getAttribute('href'), `/a/treasury/activity#operation-${operationId}`);
      await follow.click();
      await page.locator(`#operation-${operationId}`).waitFor();
      await page.reload();
      await page.locator(`#operation-${operationId}`).waitFor();
      assert.equal(writes.length, 2, 'following and reloading must never replay the plan');
      assert.deepEqual(errors, []);
      await context.close();
      console.log('PASS rebalance: preview, cancel, explicit execute, exact plan and operation links, read-only reload');
    }

    {
      const { page, context, writes, errors, state } = await open('/a/payables/demo', { allowPay: true });
      const reviewButton = page.getByRole('button', { name: 'Review payment', exact: true });
      await expect(reviewButton).toBeEnabled();
      await page.getByRole('heading', { name: 'Request a real payment', exact: true }).waitFor();
      if (process.env.PROTO_BROWSER_ARTIFACTS) await page.screenshot({ path: '/tmp/live-demo-payables-390.png', fullPage: true });
      assert.deepEqual(writes, []);
      await page.getByLabel('Recipient’s NEAR account', { exact: true }).fill(payment.recipient);
      await page.getByLabel('Amount', { exact: true }).fill('1');
      await reviewButton.click();
      const review = page.getByRole('dialog', { name: 'Review payment', exact: true });
      await expect(review).toContainText('1 USDC');
      await expect(review).toContainText(payment.recipient);
      await expect(review).toContainText('Required by the reviewed policy.');
      await review.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.deepEqual(writes, [], 'review and cancellation must not send');
      assert.equal(await page.getByRole('heading', { name: 'Your payment', exact: true }).count(), 0);
      await reviewButton.click();
      await review.getByRole('button', { name: 'Send payment', exact: true }).click();
      const follow = page.getByRole('link', { name: 'Follow this payment', exact: true });
      await follow.waitFor();
      await page.getByRole('heading', { name: 'Your payment', exact: true }).waitFor();
      await page.getByRole('link', { name: 'Link to this payment', exact: true }).waitFor();
      assert.ok(page.url().endsWith('/demo'), 'the returned payment is followed inline');
      assert.deepEqual(writes, [{ method: 'pay', input: { ...payment, expectedPolicy: { revision: 1, digest } } }]);
      assert.equal(await follow.getAttribute('href'), `/a/payables/follow/payment?payment=${paymentId}`);
      await follow.click();
      await page.getByRole('link', { name: 'Link to this payment', exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('payment'), paymentId);
      assert.equal(await page.getByText('Paid', { exact: true }).count(), 0, 'held does not establish payment completion');
      state.settled = true;
      await page.reload();
      await page.getByText('Paid', { exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('payment'), paymentId);
      assert.equal(writes.length, 1, 'completion and reload must follow the same payment without resubmission');
      assert.deepEqual(errors, []);
      await context.close();
      console.log('PASS payables: reviewed amount and recipient, no send on cancellation, explicit submit, durable identity and settlement');
    }

    for (const condition of ['interrupted', 'rejected']) {
      const { page, context, writes, errors } = await open('/a/treasury/demo', { allowRebalance: true, [condition]: true });
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Execute', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Execute', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Execute swaps', exact: true }).click();
      const records = page.locator('section').filter({ has: page.getByRole('heading', { name: 'This plan’s operations', exact: true }) }).last();
      await records.waitFor();
      if (condition === 'interrupted') {
        await records.locator('#operation-demo-shield-fixture').waitFor();
        await records.getByText('unsettled', { exact: true }).waitFor();
      } else await records.getByText(/No operations for this plan are recorded here yet/).waitFor();
      assert.equal(await records.locator('#operation-unrelated-operation').count(), 0);
      assert.deepEqual(writes.map(write => write.method), ['rebalance', 'executePlan']);
      await page.reload();
      await page.getByText(/No plan selected in this walkthrough/).waitFor();
      assert.equal(writes.length, 2, 'reload never replays execution or guesses the latest plan');
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('PASS interrupted and rejected execution: exact retained records, no inferred completion and read-only reload');

    {
      const { page, context, writes } = await open('/a/treasury/demo', { allowRebalance: true, noLegs: true });
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      await page.getByText('No swaps are needed at the current targets and minimum swap size.', { exact: true }).waitFor();
      await expect(page.getByRole('button', { name: 'Execute', exact: true })).toBeDisabled();
      assert.equal(await page.getByRole('heading', { name: 'This plan’s operations', exact: true }).count(), 0);
      assert.deepEqual(writes.map(write => write.method), ['rebalance']);
      await context.close();
    }

    {
      const { page, context, writes, errors, state } = await open('/a/payables/demo', { allowPay: true, held: true });
      await page.getByLabel('Recipient’s NEAR account', { exact: true }).fill(payment.recipient);
      await page.getByLabel('Amount', { exact: true }).fill('1');
      await page.getByRole('button', { name: 'Review payment', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Send payment', exact: true }).click();
      await page.getByRole('heading', { name: 'Your payment', exact: true }).waitFor();
      state.payRefused = true;
      await page.getByRole('button', { name: 'Review payment', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Send payment', exact: true }).click();
      await page.getByText(/^Refused ·/).waitFor();
      await page.getByText(/No payment selected in this walkthrough/).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'Your payment', exact: true }).count(), 0, 'a refusal cannot select a previous held payout');
      assert.equal(writes.length, 2);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('PASS no-leg plan and payment refusal do not manufacture an outcome selection');

    for (const [name, options, message] of [
      ['member', { member: true }, 'Your access: Review only'],
      ['approve-only', { approveOnly: true }, 'This instance: Approve-only'],
      ['missing grant', { noGrant: true }, 'Send grant: Review needed'],
      ['expired grant', { expired: true }, 'Send grant: Expired'],
      ['revoked grant', { revoked: true }, 'Send grant: Review needed'],
      ['unverified grant', { unverifiedGrant: true }, 'Send grant: Review needed'],
      ['wrong purpose', { wrongPurpose: true }, 'Send grant: Review needed'],
      ['policy unavailable', { notInForce: true }, 'Policy: Review needed'],
      ['unfunded', { empty: true }, 'Funds: Funding needed'],
      ['unresolved', { unresolved: true }, 'Unresolved operations: 1 unresolved'],
      ['read failure', { error: 'unresolved' }, 'Observations: Unavailable'],
    ]) {
      const { page, context, writes, errors } = await open('/a/treasury/demo', options);
      await page.getByText(message, { exact: true }).waitFor();
      await expect(page.getByRole('button', { name: 'Preview', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Execute', exact: true })).toBeDisabled();
      await page.getByRole('link', { name: 'Review all operations and recovery', exact: true }).waitFor();
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS ${name}: blocks new actions and retains recovery access`);
    }

    for (const options of [{ member: true }, { noGrant: true }, { expired: true }, { unresolved: true }, { error: 'unresolved' }]) {
      const { page, context, writes, errors } = await open('/a/payables/demo', options);
      await page.getByRole('heading', { name: 'Request a real payment', exact: true }).waitFor();
      await expect(page.getByRole('button', { name: 'Review payment', exact: true })).toBeDisabled();
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('PASS payables missing access, grant and current operation evidence cannot submit');

    {
      const { page, context, calls, writes, errors } = await open('/a/payables/demo', { approveOnly: true, noGrant: true, held: true });
      await page.getByRole('heading', { name: 'Find your payment', exact: true }).waitFor();
      const invoice = page.getByRole('link', { name: 'Open invoice page', exact: true });
      assert.equal(await invoice.getAttribute('href'), 'https://invoices.example');
      assert.equal(await page.getByRole('button', { name: 'Review payment', exact: true }).count(), 0);
      const queue = page.getByRole('list', { name: 'Payment records' });
      await queue.getByRole('link').first().waitFor();
      assert.ok(!calls.includes('paymentStatus'), 'queue must not poll or approve each payment');
      await queue.getByRole('link').filter({ hasText: paymentId }).click();
      await page.getByRole('link', { name: 'Link to this payment', exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('payment'), paymentId);
      assert.equal(await page.getByText('Paid', { exact: true }).count(), 0);
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
      await context.close();
      console.log('PASS approve-only payables: configured invoice path and retained held-payout review without a send grant');
    }

    for (const kind of ['treasury', 'payables']) {
      const { page, context, writes, errors, state } = await open(`/a/${kind}/demo`);
      const action = page.getByRole('button', { name: kind === 'treasury' ? 'Preview' : 'Review payment', exact: true });
      await expect(action).toBeEnabled();
      state.error = 'overview';
      await page.getByRole('button', { name: 'Check observations', exact: true }).click();
      await page.getByText('Observations: Unavailable', { exact: true }).waitFor();
      await expect(action).toBeDisabled();
      assert.equal(await page.getByText('Real funds on mainnet', { exact: true }).count(), 1, 'retained demo stays present while fresh observations fail');
      state.error = undefined;
      await page.getByRole('button', { name: 'Check observations', exact: true }).click();
      await expect(action).toBeEnabled();
      assert.deepEqual(writes, [], 'refresh only reads observations');
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('PASS failed refresh: retained observations never authorize a new action, successful refresh restores readiness');

    for (const kind of ['treasury', 'payables']) {
      const { page, context, writes, errors, state } = await open(`/a/${kind}/demo`, { clock: true, allowRebalance: kind === 'treasury' });
      if (kind === 'treasury') {
        const preview = page.getByRole('button', { name: 'Preview', exact: true });
        await expect(preview).toBeEnabled();
        await preview.click();
        const execute = page.getByRole('button', { name: 'Execute', exact: true });
        await expect(execute).toBeEnabled();
        await execute.click();
      } else {
        const reviewButton = page.getByRole('button', { name: 'Review payment', exact: true });
        await expect(reviewButton).toBeEnabled();
        await page.getByLabel('Recipient’s NEAR account', { exact: true }).fill(payment.recipient);
        await page.getByLabel('Amount', { exact: true }).fill('1');
        await reviewButton.click();
      }
      const review = page.getByRole('dialog', { name: kind === 'treasury' ? 'Execute the previewed rebalance on mainnet?' : 'Review payment', exact: true });
      const confirm = review.getByRole('button', { name: kind === 'treasury' ? 'Execute swaps' : 'Send payment', exact: true });
      await expect(confirm).toBeEnabled();
      state.unresolved = true;
      await page.clock.fastForward(5_100);
      await page.clock.runFor(100);
      await expect(confirm).toBeDisabled();
      assert.deepEqual(writes.map(write => write.method), kind === 'treasury' ? ['rebalance'] : [], 'new unresolved evidence invalidates an already open review');
      await review.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('PASS changed observations invalidate open swap and payment confirmations');

  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
