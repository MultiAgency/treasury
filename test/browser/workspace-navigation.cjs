/** Offline task journeys. Run through test/browser/run.cjs to retain failure diagnostics. */
const { runTask } = require('./fixtures/task.cjs');
const { openWorkspaceNavigation } = require("./fixtures/navigation.cjs");
const assert = require('node:assert/strict');
const path = require('node:path');
const { workspaceEvidence, workspaceOpener } = require('./fixtures/workspace.cjs');
const { rpcBody } = require('./fixtures/rpc.cjs');

async function selectedTasks(browser, root) {
  const { budget, setup, overview } = workspaceEvidence();
  const open = workspaceOpener(root, { budget, values(kind, options, state, run) {
    const values = { get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup: { ...setup, ...(options.noGrant && { grant: null }), ...(options.approveOnly && { executor: false }) }, overview: overview(kind), 'treasury/get': null, held: options.held && kind === 'payables' && !state.settled ? ['payment-one','payment-two'].map(correlationId => ({ correlationId, kind: 'payout', approvalId: 'approval-' + correlationId, at: new Date().toISOString(), request: { amount: '1000000', asset: 'usdc', recipient: 'payee.near', confidential: true } })) : [], unresolved: options.unresolved && kind === 'payables' ? [{ kind: 'payout', at: new Date().toISOString(), key: 'fixture-unresolved', request: {}, status: null, sent: false }] : [],
      'inbox/list': [], 'agreements/list': options.agreed ? [{ id: 'agreement-fixture', payee: 'payee.near', amount: '1000000', status: 'agreed', origin: 'owner', at: '2026-10-01T00:00:00Z', note: '' }] : [], activity: [], invoices: [], reconcileBooks: [], 'owner/pending': [], 'owner/actions': [], paymentHistory: { items: options.held ? ['payment-one','payment-two'].map(correlationId => ({ correlationId, at: '2026-10-14T00:00:00Z' })) : [], complete: true }, paymentStatus: { status: state.settled ? 'SUCCESS' : 'PENDING_APPROVAL', request: { amount: '1000000', asset: 'usdc', recipient: 'payee.near', confidential: true }, approvalId: 'approval-one', expiresAt: '2030-01-01T00:00:00Z', failureCode: null, createdAt: null, updatedAt: null, detailError: null, evidence: { txHash: null, destinationTxHash: null, refundTxHash: null, refundTo: null, refundedAmount: null } },
      // The server always reports a strategy status: the default strategy, unscheduled, not yet authorized.
      'strategy/get': { strategy: { targetBps: {}, minLegUsd: 1, maxCostBps: 100, autopilot: { everyMin: 60, maxUsd: 0 } }, digest: 'fixture', grantSuffix: 'fixture', executor: true, on: false,
        grantMatches: false, unresolved: 0, grant: setup.grant, readiness: { state: 'authorization-required', reasons: [], canEnable: false }, observedAt: '2026-10-15T12:00:00Z' },
      'autopilot/get': { on: true, everyMin: 60, maxUsd: 10, lastRun: null, nextRun: null },
      'autopilot/evidence': { ticks: [run], corrupt: [] } };
    if (options.unmanaged) {
      values.overview.unmanaged = [{ asset: 'unmanaged', symbol: 'OTHER', amount: 1000000n, decimals: 6, usd: null, price: null, priceUpdatedAt: null, priceExpiresAt: null }];
      values.overview.policy.policy.assets = options.excluded ? ['usdc'] : 'any';
    }
    return values;
  } });
  async function assertSelectedTask(page, label) {
    await page.locator('nav[aria-label="Workspace"]').waitFor({ state: 'attached' });
    const area = page.getByRole('navigation', { name: 'Area', exact: true });
    const utilities = page.getByRole('navigation', { name: 'Area utilities', exact: true });
    const taskNav = label === 'Balances & funding' || label === 'Policy & grants' ? utilities : area;
    await taskNav.getByRole('link', { name: label, exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog', { name: 'Workspace navigation' }).isVisible(), false, 'content tasks do not require the mobile drawer');
    const selected = await page.locator('nav[aria-label="Area"] a[aria-current="page"], nav[aria-label="Area utilities"] a[aria-current="page"]').allTextContents();
    assert.deepEqual(selected, [label], `only ${label} should be highlighted at ${page.url()}`);
    assert.equal(await area.getByRole('link').count(), 2);
    assert.deepEqual(await utilities.getByRole('link').allTextContents(), ['Balances & funding', 'Policy & grants']);
    await openWorkspaceNavigation(page);
    const workspace = page.getByRole('navigation', { name: 'Workspace', exact: true });
    assert.equal(await workspace.getByRole('navigation').count(), 0, 'workspace menu has no nested task navigation');
    if (await page.getByRole('dialog', { name: 'Workspace navigation' }).isVisible()) await page.keyboard.press('Escape');
  }
  for (const width of [320, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    for (const [agent, route, label] of [
      ['treasury', '/', 'Overview'], ['treasury', '/automations', 'Strategy'],
      ['payables', '/payees', 'Agreements'],
      ['payables', '/', 'Payments'],
    ]) {
      const { page, calls, errors } = await open(context, `/a/${agent}${route}`);
      await assertSelectedTask(page, label);
      await page.reload();
      await assertSelectedTask(page, label);
      await page.getByRole('navigation', { name: 'Area utilities', exact: true }).getByRole('link', { name: 'Balances & funding', exact: true }).click();
      await page.getByRole('heading', { name: 'Balances', exact: true }).waitFor();
      await assertSelectedTask(page, 'Balances & funding');
      await page.getByRole('navigation', { name: 'Area', exact: true }).getByRole('link', { name: label, exact: true }).click();
      await page.waitForURL(url => url.pathname.replace(/\/$/, '') === `/a/${agent}${route}`.replace(/\/$/, ''));
      await assertSelectedTask(page, label);
      assert.deepEqual(errors, []);
      assert.ok(!calls.some(call => /(?:tick|save|enable|prepare|submit|recover)$/.test(call)));
      await page.close();
    }
    {
      const { page, calls, errors } = await open(context, '/a/payables/activity');
      await page.getByRole('heading', { name: 'Payables · Operation status', exact: true }).waitFor();
      assert.equal(await page.getByRole('link', { name: 'Back to Activity', exact: true }).getAttribute('href'), '/#activity');
      const area = page.getByRole('navigation', { name: 'Area', exact: true });
      assert.equal(await area.getByRole('link', { name: 'Activity', exact: true }).count(), 0);
      assert.equal(await area.locator('[aria-current="page"]').count(), 0, 'scoped history does not select a task tab');
      const help = page.getByRole('button', { name: 'Help', exact: true });
      const menu = page.getByRole('menu');
      const demo = page.getByRole('menuitem', { name: 'Guided walkthrough', exact: true });
      assert.equal(await menu.count(), 0, 'Help starts closed');
      await help.focus(); await page.keyboard.press('ArrowDown'); await demo.waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem');
      assert.equal(await demo.getAttribute('href'), '/a/payables/demo');
      // The opening scale animation temporarily shrinks the rendered hit target.
      await menu.evaluate(async element => {
        await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
      });
      assert.equal(await menu.evaluate(element => { const r = element.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }), true, 'Help fits the viewport');
      assert.equal(await demo.evaluate(element => element.getBoundingClientRect().height >= 44), true, 'Help action has a 44px target');
      await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
      assert.equal(await help.evaluate(element => element === document.activeElement), true, 'Escape restores Help focus');
      await help.click(); await demo.waitFor();
      await menu.evaluate(async element => {
        await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
      });
      // The open menu can cover the heading on narrow screens; click outside its collision padding.
      await page.mouse.click(4, 4);
      await menu.waitFor({ state: 'hidden' });
      await help.focus(); await page.keyboard.press('ArrowDown'); await demo.waitFor();
      await demo.press('Enter');
      await page.getByRole('heading', { name: 'Run with real funds', exact: true }).waitFor();
      await page.waitForFunction(() => document.activeElement?.id === 'agent-main');
      await menu.waitFor({ state: 'detached' });
      assert.equal(await menu.count(), 0, 'navigation closes Help without stealing main focus');
      assert.equal(await help.getAttribute('aria-current'), 'page');
      await page.goBack();
      await page.getByRole('heading', { name: 'Payables · Operation status', exact: true }).waitFor();
      await openWorkspaceNavigation(page);
      const workspace = page.getByRole('navigation', { name: 'Workspace', exact: true });
      assert.equal(await workspace.getByRole('link', { name: 'Activity', exact: true }).count(), 1);
      assert.equal(await workspace.getByRole('link', { name: 'Activity', exact: true }).getAttribute('aria-current'), 'page');
      assert.deepEqual(await workspace.locator('a[aria-current="page"]').allTextContents(), ['Activity']);
      await workspace.getByRole('link', { name: 'Activity', exact: true }).click();
      await page.getByLabel('Area', { exact: true }).selectOption('payables');
      await page.getByRole('link', { name: 'Review operation status · payables', exact: true }).click();
      await page.getByRole('heading', { name: 'Payables · Operation status', exact: true }).waitFor();
      assert.deepEqual(errors, []);
      assert.ok(!calls.some(call => /(?:tick|save|enable|prepare|submit|recover)$/.test(call)));
      await page.close();
    }
    {
      const { page, calls, errors } = await open(context, '/a/treasury/follow/run');
      const selector = page.getByRole('combobox', { name: /^Run to view/ });
      await selector.waitFor();
      assert.equal(await selector.evaluate(element => { const r = element.getBoundingClientRect(); return r.height >= 44 && r.left >= 0 && r.right <= innerWidth; }), true, 'native run selector remains reachable at each width');
      await selector.selectOption({ index: 1 });
      assert.notEqual(await selector.inputValue(), '', 'a retained run can still be selected');
      await selector.selectOption('');
      assert.equal(await selector.inputValue(), '', 'Latest run remains available');
      assert.deepEqual(errors, []);
      assert.ok(!calls.some(call => /(?:tick|save|enable|prepare|submit|recover)$/.test(call)), 'selecting records is read-only');
      await page.close();
    }
    const { page } = await open(context, '/a/payables/follow/payment?payment=payment-one', { held: true });
    await page.getByRole('link', { name: 'Link to this payment', exact: true }).waitFor();
    await assertSelectedTask(page, 'Payments');
    await page.reload();
    await assertSelectedTask(page, 'Payments');
    await context.close();
    console.log(`PASS ${width}px: exactly one selected task on direct load, reload and navigation; payment detail retains Payments`);
  }
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const { page, calls, state, errors } = await open(context, '/a/payables/', { held: true });
    const queue = page.getByRole('list', { name: 'Payment records' });
    await queue.getByRole('link').first().waitFor();
    assert.equal(await queue.getByRole('link').count(), 2);
    assert.ok(!calls.includes('paymentStatus'), 'queue must not start per-payment polling');
    assert.equal(await page.getByRole('button', { name: 'Sign approval', exact: true }).count(), 0);
    const selected = queue.getByRole('link').filter({ hasText: 'payment-one' });
    await selected.click();
    await page.getByRole('link', { name: 'Link to this payment', exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('payment'), 'payment-one');
    assert.equal(await page.getByRole('link', { name: 'Link to this payment', exact: true }).count(), 1);
    assert.ok(calls.includes('paymentStatus'));
    state.settled = true;
    await page.reload();
    await page.getByText('Paid', { exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('payment'), 'payment-one');
    await page.getByRole('link', { name: 'All payments', exact: true }).click();
    await page.getByRole('list', { name: 'Payment records' }).getByRole('link').first().waitFor();
    assert.ok(!calls.some(call => /(?:tick|save|enable|prepare|submit|recover)$/.test(call)));
    assert.deepEqual(errors, []);
    await page.screenshot({ path: '/tmp/product-payments-queue.png', fullPage: true });
    state.settled = false;
    await openWorkspaceNavigation(page);
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Home', exact: true }).click();
    const review = page.getByRole('link', { name: 'Review payment', exact: true }).first();
    await review.waitFor();
    assert.match(await review.getAttribute('href'), /\/a\/payables\/follow\/payment\?payment=payment-(one|two)$/);

    await context.close();
    console.log('PASS payment queue: no per-record polling, canonical review, retained selection after settlement and reload, no writes');
  }
  for (const width of [320, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const { page, calls, errors } = await open(context, '/a/payables/', { member: true });
    await page.getByRole('heading', { name: 'Payables · Payments', exact: true }).waitFor();
    const area = () => page.getByRole('navigation', { name: 'Area', exact: true });
    await area().getByRole('link', { name: 'Payments', exact: true }).waitFor();
    await openWorkspaceNavigation(page);
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Portfolio', exact: true }).click();
    await page.getByRole('heading', { name: 'Portfolio · Overview', exact: true }).waitFor();
    await area().getByRole('link', { name: 'Strategy', exact: true }).waitFor();
    await page.getByRole('navigation', { name: 'Area utilities', exact: true }).getByRole('link', { name: 'Balances & funding', exact: true }).click();
    await page.getByRole('heading', { name: 'Balances', exact: true }).waitFor();
    const balances = page.getByRole('table', { name: 'Managed assets, public and confidential balances' });
    assert.match(await balances.innerText(), /10 USDC/);
    await page.getByText(/not the amount available for new payments/).waitFor();

    await openWorkspaceNavigation(page);
    await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: 'Activity', exact: true }).click();
    await page.getByLabel('Area', { exact: true }).selectOption('treasury');
    await page.getByText('Run history (1)', { exact: true }).click();
    await page.getByRole('list', { name: 'treasury run history', exact: true }).getByRole('link').click();
    await page.getByRole('heading', { name: 'Portfolio · Runs', exact: true }).waitFor();
    assert.match(page.url(), /follow\/run\?run=fixture-run/);
    await page.reload();
    await page.getByRole('heading', { name: 'Portfolio · Runs', exact: true }).waitFor();
    await openWorkspaceNavigation(page);
    const activity = page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: 'Activity', exact: true });
    assert.equal(await activity.getAttribute('aria-current'), 'page');
    assert.equal(await area().getByRole('link', { name: 'Runs', exact: true }).count(), 0);
    const activeInMenu = await activity.evaluate(link => {
      const item = link.getBoundingClientRect(), menu = link.closest('nav').getBoundingClientRect();
      return item.left >= menu.left && item.right <= menu.right;
    });
    assert.ok(activeInMenu, 'selected task remains visible after direct reload on mobile');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    assert.ok(!calls.some(call => /(?:tick|save|enable|prepare|recover)$/.test(call)));
    await page.screenshot({ path: `/tmp/product-navigation-${width}.png`, fullPage: true });
    await context.close();
    console.log(`PASS ${width}px: task navigation, retained URLs, reload, no writes`);
  }
}

async function taskLinksAndDrafts(browser, root) {
  const { budget, setup, overview } = workspaceEvidence();
  const open = workspaceOpener(root, { budget, values(kind, options, state, run) {
    const values = { get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup: { ...setup, ...(options.noGrant && { grant: null }), ...(options.approveOnly && { executor: false }) }, overview: overview(kind), 'treasury/get': null, held: options.held && kind === 'payables' && !state.settled ? ['payment-one','payment-two'].map(correlationId => ({ correlationId, kind: 'payout', approvalId: 'approval-' + correlationId, at: new Date().toISOString(), request: { amount: '1000000', asset: 'usdc', recipient: 'payee.near', confidential: true } })) : [], unresolved: options.unresolved && kind === 'payables' ? [{ kind: 'payout', at: new Date().toISOString(), key: 'fixture-unresolved', request: {}, status: null, sent: false }] : [],
      'inbox/list': [], 'agreements/list': options.agreed ? [{ id: 'agreement-fixture', payee: 'payee.near', amount: '1000000', status: 'agreed', origin: 'owner', at: '2026-10-01T00:00:00Z', note: '' }] : [], activity: [], invoices: [], reconcileBooks: [], 'owner/pending': [], 'owner/actions': [], paymentHistory: { items: options.held ? ['payment-one','payment-two'].map(correlationId => ({ correlationId, at: '2026-10-14T00:00:00Z' })) : [], complete: true }, paymentStatus: { status: state.settled ? 'SUCCESS' : 'PENDING_APPROVAL', request: { amount: '1000000', asset: 'usdc', recipient: 'payee.near', confidential: true }, approvalId: 'approval-one', expiresAt: '2030-01-01T00:00:00Z', failureCode: null, createdAt: null, updatedAt: null, detailError: null, evidence: { txHash: null, destinationTxHash: null, refundTxHash: null, refundTo: null, refundedAmount: null } },
      'strategy/get': { strategy: { targetBps: { usdc: 10000 }, minLegUsd: 1, maxCostBps: 100, autopilot: { everyMin: 60, maxUsd: 10 } }, digest: 'fixture', on: false, executor: true, grantMatches: false, readiness: { state: 'authorization-required', canEnable: false, reasons: ['Owner authorization required.'] }, observedAt: '2026-10-15T12:00:00Z', grantSuffix: 'fixture', unresolved: 0, grant: null },
      'autopilot/get': { on: true, everyMin: 60, maxUsd: 10, lastRun: null, nextRun: null },
      'autopilot/evidence': { ticks: [run], corrupt: [] } };
    if (options.unmanaged) {
      values.overview.unmanaged = [{ asset: 'unmanaged', symbol: 'OTHER', amount: 1000000n, decimals: 6, usd: null, price: null, priceUpdatedAt: null, priceExpiresAt: null }];
      values.overview.policy.policy.assets = options.excluded ? ['usdc'] : 'any';
    }
    return values;
  } });
  for (const width of [320, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const { page, calls, errors } = await open(context, '/a/payables/', { held: true });
    await page.getByRole('heading', { name: 'Payables · Payments', exact: true }).waitFor();
    await page.getByText('Create payment', { exact: true }).waitFor();
    if (width < 1024) {
      const menu = page.getByRole('button', { name: 'Menu', exact: true });
      await menu.click();
      const drawer = page.getByRole('dialog', { name: 'Workspace navigation' });
      await drawer.waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await menu.evaluate(el => el === document.activeElement), true, 'Escape returns focus to Menu');
      assert.equal(await drawer.isVisible(), false);
    }
    assert.deepEqual(await page.getByRole('navigation', { name: 'Area', exact: true }).getByRole('link').allTextContents(), ['Payments', 'Agreements']);
    assert.equal(await page.getByRole('dialog', { name: 'Workspace navigation' }).isVisible(), false, 'task tabs remain in the page on mobile');
    await page.getByRole('navigation', { name: 'Area', exact: true }).getByRole('link', { name: 'Agreements', exact: true }).click();
    await page.getByRole('heading', { name: 'Payables · Agreements', exact: true }).waitFor();
    assert.equal(await page.getByText('Create payment', { exact: true }).count(), 0, 'agreements no longer mounts payment creation');
    await page.getByRole('link', { name: 'Create a payment in Payments', exact: true }).click();
    await page.locator('#manual-payment').waitFor();
    assert.equal(new URL(page.url()).hash, '#manual-payment');
    assert.ok(await page.getByLabel('Recipient’s NEAR account', { exact: true }).isVisible(), 'legacy creation link opens the form');
    await page.getByLabel('Recipient’s NEAR account', { exact: true }).fill('payee.near');
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('navigation', { name: 'Area', exact: true }).getByRole('link', { name: 'Agreements', exact: true }).click();
    assert.equal(new URL(page.url()).pathname, '/a/payables/', 'cancelled draft navigation stays on Payments');
    page.once('dialog', dialog => dialog.accept());
    await openWorkspaceNavigation(page);
    await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: 'Activity', exact: true }).click();
    await page.getByLabel('Area', { exact: true }).selectOption('payables');
    await page.getByRole('link', { name: 'Review operation status · payables', exact: true }).click();
    await page.getByRole('link', { name: 'Review invoices in Payments', exact: true }).click();
    await page.locator('#invoices').waitFor();
    assert.equal(new URL(page.url()).hash, '#invoices');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    assert.ok(!calls.some(call => /(?:tick|save|enable|prepare|submit|recover|pay)$/.test(call)));
    await page.screenshot({ path: `/tmp/workspace-tasks-${width}.png`, fullPage: true });
    await context.close();
    console.log(`PASS ${width}px: drawer focus, task placement, retained anchors, draft protection and no writes`);
  }
  {
    const context = await browser.newContext();
    const { page, calls, errors } = await open(context, '/a/treasury/automations');
    await page.getByRole('heading', { name: 'Manual actions', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Sweep', exact: true }).count(), 0);
    await page.getByRole('link', { name: 'Shield public funds in Balances & funding', exact: true }).click();
    await page.getByRole('heading', { name: 'Sweep', exact: true }).waitFor();
    assert.match(page.url(), /funding#sweep$/);
    await page.goBack();
    await page.getByRole('heading', { name: 'Manual actions', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    assert.ok(!calls.some(call => /(?:sweep|tick|save|enable|prepare|submit)$/.test(call)));
    await context.close();
    console.log('PASS sweep destination, retained back navigation and no writes');
  }
}

async function configuredArea(browser, root) {
  for (const area of ['treasury', 'payables']) {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors = [], calls = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('net::ERR_FAILED')) errors.push(message.text()); });
    await page.route('**/*', async route => {
      const { hostname, pathname } = new URL(route.request().url());
      if (hostname !== 'frontend.test') return route.abort();
      if (pathname === '/gw/me') return route.fulfill({ json: {
        agents: [{ name: 'custom-agent', area, owner: 'owner.near', dao: false }], invoices: null,
        viewer: { account: 'owner.near', access: { 'custom-agent': { canSign: false, canPropose: false, canVote: false, canExecute: false, canManage: false } } },
      } });
      if (pathname.includes('/rpc/')) {
        const method = pathname.split('/rpc/')[1]; calls.push(method);
        const values = {
          instance: { agentId: 'fixture', executor: false },
          setup: { agentId: 'fixture', executor: false, wallet: 'agent.near', owner: { type: 'near', account_id: 'owner.near', public_key: 'ed25519:fixture' }, grant: null, dao: null },
          overview: { area, agentId: 'fixture', digest: 'fixture', notInForce: null, agreed: [], unmanaged: [], book: [], target: {},
            rebalance: { minLegUsd: 1, maxCostBps: 100 }, policy: { policy: { actions: ['transfer'], frozen: false, assets: 'any', destinations: { mode: 'only', list: [] }, confidential: false, owner_approval: false, limits: {}, max_actions_per_hour: 10, budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, timelock_ms: 0 }, usage: { budget: { daily: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, weekly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, monthly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null } }, timelock: { delay_ms: 0, scheduled_count: 0 } }, cooldowns: { policy_change_available_at: null, unfreeze_available_at: null }, wallet_id: 'agent.near', revision: null, status: 'APPLIED', provider_policy_synced: true }, grants: [] },
          'treasury/get': null, held: [], unresolved: [], 'inbox/list': [], 'agreements/list': [], activity: [], invoices: [],
          'owner/actions': [], 'owner/pending': [], paymentHistory: { items: [], complete: true },
          'autopilot/get': { on: false, everyMin: 60, maxUsd: 0, lastRun: null, nextRun: null }, 'autopilot/evidence': { ticks: [], corrupt: [] },
        };
        assert.ok(method in values, `Unexpected RPC: ${method}`);
        return route.fulfill({ json: rpcBody(values, method) });
      }
      if (pathname.startsWith('/static/')) return route.fulfill({ path: root + pathname,
        contentType: pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'font/woff2' });
      return route.fulfill({ path: path.join(root, 'index.html'), contentType: 'text/html' });
    });
    await page.goto('http://frontend.test/a/custom-agent/');
    const label = area === 'treasury' ? 'Portfolio' : 'Payables';
    await page.getByRole('heading', { name: `${label} · ${area === 'treasury' ? 'Overview' : 'Payments'}`, exact: true }).waitFor().catch(async error => {
      console.error('Page errors:', errors, 'Page:', await page.locator('body').innerText(), 'Reads:', calls); throw error;
    });
    assert.deepEqual(await page.getByRole('navigation', { name: 'Area', exact: true }).getByRole('link').allTextContents(), area === 'treasury' ? ['Overview', 'Strategy'] : ['Payments', 'Agreements']);
    await openWorkspaceNavigation(page);
    await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: label, exact: true }).waitFor();
    if (area === 'treasury') {
      await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: 'Activity', exact: true }).click();
      await page.getByRole('heading', { name: 'Activity', exact: true }).waitFor();
      await page.getByText('No history records returned for these areas.', { exact: true }).waitFor();
      // The saved per-agent run route remains available after Runs leaves the task navigation.
      await page.goto('http://frontend.test/a/custom-agent/follow/run');
      await page.getByRole('heading', { name: 'Portfolio · Runs', exact: true }).waitFor();
      await page.reload();
      await page.getByRole('heading', { name: 'Portfolio · Runs', exact: true }).waitFor();
      await openWorkspaceNavigation(page);
      assert.deepEqual(await page.getByRole('navigation', { name: 'Workspace', exact: true }).locator('[aria-current="page"]').allTextContents(), ['Activity']);
    }
    assert.deepEqual(errors, []);
    assert.ok(!calls.some(call => /(?:tick|save|enable|prepare|submit|recover)$/.test(call)));
    await page.close();
    console.log(`PASS configured ${area}: stable navigation without swap permission, no writes`);
  }
}

async function walletHeader(browser, root) {
  for (const { width, fontSize, account } of [
    { width: 320, fontSize: 32, account: 'owner.near' },
    { width: 320, fontSize: 32, account: 'a'.repeat(59) + '.near' },
    { width: 1280, fontSize: 16, account: 'a'.repeat(59) + '.near' },
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(8000);
    const calls = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(accountId => {
      localStorage.setItem('selected-wallet:mainnet', 'fixture-wallet');
      let accounts = [{ accountId, publicKey: 'ed25519:fixture' }];
      window.fixtureSignOuts = 0;
      const wallet = { manifest: { id: 'fixture-wallet', name: 'Offline wallet', features: { signMessage: true, signDelegateActions: true }, permissions: {} },
        getAccounts: async () => accounts, signIn: async () => accounts,
        signOut: async () => { accounts = []; window.fixtureSignOuts++; } };
      window.addEventListener('near-selector-ready', () => window.dispatchEvent(new CustomEvent('near-wallet-injected', { detail: wallet })));
    }, account);
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'frontend.test') return route.abort();
      if (url.pathname === '/gw/me') return route.fulfill({ json: { agents: [{ name: 'payables', owner: account, dao: false }], invoices: null,
        viewer: { account, access: { payables: { canSign: true, canPropose: true, canVote: true, canExecute: true, canManage: true } } } } });
      if (url.pathname.includes('/rpc/')) {
        const method = url.pathname.split('/rpc/')[1]; calls.push(method);
        const values = {
          instance: { agentId: 'wallet-header-fixture', executor: true },
          setup: { agentId: 'wallet-header-fixture', executor: true, wallet: 'agent.near', owner: { type: 'near', account_id: account, public_key: 'ed25519:fixture' }, grant: null, dao: null },
          overview: { agentId: 'wallet-header-fixture', digest: 'fixture', notInForce: null, agreed: [], unmanaged: [], target: { usdc: 1 },
            book: [{ asset: 'usdc', symbol: 'USDC', decimals: 6, public: 0n, confidential: 10000000n, usd: 10, price: 1, priceUpdatedAt: null, priceExpiresAt: null }],
            policy: { policy: { actions: ['transfer'], frozen: false, assets: 'any', owner_approval: true, destinations: { mode: 'only', list: [] }, confidential: false, limits: {}, max_actions_per_hour: 10, budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, timelock_ms: 0 }, usage: { budget: { daily: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, weekly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, monthly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null } }, timelock: { delay_ms: 0, scheduled_count: 0 } }, cooldowns: { policy_change_available_at: null, unfreeze_available_at: null }, wallet_id: 'agent.near', revision: null, status: 'APPLIED', provider_policy_synced: true }, grants: [], rebalance: { minLegUsd: 1, maxCostBps: 100 } },
          'treasury/get': null, 'agreements/list': [], 'owner/pending': [], 'owner/actions': [],
        };
        assert.ok(method in values, `Unexpected RPC: ${method}`);
        return route.fulfill({ json: rpcBody(values, method) });
      }
      if (url.pathname.startsWith('/static/')) return route.fulfill({ path: root + url.pathname,
        contentType: url.pathname.endsWith('.js') ? 'application/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'font/woff2' });
      return route.fulfill({ path: path.join(root, 'index.html'), contentType: 'text/html' });
    });
    await page.goto('http://frontend.test/a/payables/payees');
    const header = page.locator('#agent-main > header');
    const disconnect = header.getByRole('button', { name: 'Disconnect', exact: true });
    await disconnect.waitFor();
    await page.evaluate(async size => { document.documentElement.style.fontSize = `${size}px`; await document.fonts.ready; }, fontSize);
    async function fits() {
      const overflow = await header.evaluate(element => [...element.querySelectorAll('button, [data-slot="badge"]')].flatMap(control => {
        const rect = control.getBoundingClientRect();
        return rect.left < 0 || rect.right > innerWidth + 1 || control.scrollWidth > control.clientWidth + 1
          ? [{ text: control.textContent.trim(), left: rect.left, right: rect.right, width: control.clientWidth, scroll: control.scrollWidth }] : [];
      }));
      assert.deepEqual(overflow, [], `${width}px viewport / ${fontSize}px root font: header controls must fit`);
    }
    await fits();
    const refresh = header.getByRole('button', { name: 'Refresh', exact: true });
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/rpc/overview'));
    await refresh.focus();
    await page.keyboard.press('Enter');
    await refreshed;
    assert.equal(await refresh.evaluate(element => document.activeElement === element), true, 'refresh retains keyboard focus');
    await disconnect.focus();
    await page.keyboard.press('Enter');
    await header.getByRole('button', { name: 'Connect wallet', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.fixtureSignOuts), 1, 'Disconnect still signs out exactly once');
    await fits();
    assert.ok(!calls.some(method => /owner\/(prepare|submit)|^(pay|recover)$/.test(method)), 'layout and wallet disconnection never prepare or send money actions');
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS wallet header at ${width}px / ${fontSize}px root font (${account.length}-character account)`);
  }
}

runTask([selectedTasks, taskLinksAndDrafts, configuredArea, walletHeader]);
