const { openWorkspaceNavigation } = require("./fixtures/navigation.cjs");
/**
 * Offline shared workspace and activity regressions. Build first with pnpm build:web.
 * PLAYWRIGHT_MODULE=/path/to/playwright-core BROWSER_EXECUTABLE=/path/to/chrome \
 *   node test/browser/workspace.cjs [build-directory]
 * All requests are intercepted. No server, wallet, or executor is started.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('./fixtures/browser.cjs');
const root = path.resolve(process.argv[2] || 'web/dist');
const { workspaceEvidence, workspaceOpener } = require('./fixtures/workspace.cjs');
const { budget, setup, overview } = workspaceEvidence();

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
  const open = workspaceOpener(root, { budget, values(kind, options, state, run) {
    const values = { instance: { agentId: 'fixture', executor: !options.approveOnly }, setup: { ...setup, ...(options.noGrant && { grant: null }), ...(options.approveOnly && { executor: false }) }, overview: overview(kind), 'treasury/get': null, held: options.held && kind === 'payables' ? [{ at: new Date().toISOString(), request: { amount: '1000000', asset: 'usdc', recipient: 'payee.near' }, kind: 'payout', correlationId: 'fixture-held-payment', approvalId: 'fixture-approval' }] : [], unresolved: options.unresolved && kind === 'payables' ? [{ kind: 'payout', at: new Date().toISOString(), key: 'fixture-unresolved', request: {}, status: null, sent: false }] : [],
      'inbox/list': [], 'agreements/list': options.agreed ? [{ id: 'agreement-fixture', payee: 'payee.near', amount: '1000000', status: 'agreed', origin: 'owner', at: '2026-10-01T00:00:00Z', note: '' }] : [], activity: [], invoices: [], reconcileBooks: [], 'owner/pending': [], 'owner/actions': [], paymentHistory: { items: [], complete: true },
      'autopilot/get': { on: true, everyMin: 60, maxUsd: 10, lastRun: null, nextRun: null },
      'autopilot/evidence': { ticks: [run], corrupt: [] } };
    if (options.unmanaged) {
      values.overview.unmanaged = [{ asset: 'unmanaged', symbol: 'OTHER', amount: 1000000n, decimals: 6, usd: null, price: null, priceUpdatedAt: null, priceExpiresAt: null }];
      values.overview.policy.policy.assets = options.excluded ? ['usdc'] : 'any';
    }
    return values;
  } });
    {
      const context = await browser.newContext();
      const { page, requests, errors } = await open(context, '/a/payables/', { onlyPayables: true, member: true });
      await page.getByRole('heading', { name: 'Payables · Payments', exact: true }).waitFor();
      await page.getByText('Signed in', { exact: true }).waitFor();
      await openWorkspaceNavigation(page);
      assert.equal(await page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Portfolio', exact: true }).count(), 0);
      assert.ok(requests.every(path => path.startsWith('/a/payables/rpc/')), 'only accessible agents are read');
      assert.deepEqual(errors, []);
      await context.close();
      console.log('PASS accessible-agent navigation and member context');
    }
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
      const { page, calls, errors, state } = await open(context, '/#activity', { unresolved: true });
      const area = page.getByLabel('Area', { exact: true });
      await page.getByRole('heading', { name: 'Activity', exact: true }).waitFor();
      await page.getByText('Run history (1)', { exact: true }).waitFor();
      await area.selectOption('payables');
      await page.getByRole('heading', { name: 'Payables', exact: true }).waitFor();
      await page.locator('main').getByText('fixture-unresolved', { exact: true }).waitFor({ state: 'attached' });
      assert.equal(await area.inputValue(), 'payables');
      assert.equal(await page.getByRole('heading', { name: 'Portfolio', exact: true }).count(), 0);

      state.agents = ['treasury'];
      state.deniedAgent = 'payables';
      const permissionsRefreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/gw/me');
      await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
      assert.deepEqual((await (await permissionsRefreshed).json()).agents.map(agent => agent.name), ['treasury'], 'the refreshed gateway removes the selected agent and retains its sibling');
      await area.locator('option[value="payables"]').waitFor({ state: 'detached' });
      await page.getByRole('heading', { name: 'Portfolio', exact: true }).waitFor();
      assert.equal(await area.inputValue(), '', 'an inaccessible area resets the filter to All areas');
      await page.getByText('Run history (1)', { exact: true }).click();
      await page.getByRole('list', { name: 'treasury run history' }).getByRole('link').waitFor();
      assert.equal(await page.getByRole('link', { name: 'Review operation status · treasury', exact: true }).getAttribute('href'), '/a/treasury/activity');
      assert.equal(await page.getByRole('heading', { name: 'Payables', exact: true }).count(), 0);
      assert.doesNotMatch(await page.locator('main').textContent(), /fixture-unresolved/, 'removed-agent references disappear even inside closed disclosures');
      assert.ok(!calls.some(call => /(?:tick|set|save|enable|prepare|recover)$/.test(call)), 'refreshing permissions never mutates');
      assert.deepEqual(errors, []);
      await context.close();
      console.log('PASS removed Activity area clears the filter, hides its records and retains accessible sibling history');
    }
    for (const width of [320, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const { page, calls, errors } = await open(context, '/', { unresolved: true, onlyTreasury: true, error: 'setup' });
      const nav = () => page.getByRole('navigation', { name: 'Workspace', exact: true });
      await page.getByRole('heading', { name: 'Current status', exact: true }).waitFor();
      await page.getByText(/1 money action has no proven outcome/).waitFor();
      assert.equal(await page.getByRole('link', { name: /^Open (Portfolio|Payables)$/ }).count(), 0);
      await openWorkspaceNavigation(page);
      assert.equal(await nav().getByRole('link', { name: 'Home', exact: true }).getAttribute('aria-current'), 'page');
      assert.deepEqual(await nav().getByRole('link').allTextContents(), ['Home', 'Payables', 'Portfolio', 'Activity']);
      await openWorkspaceNavigation(page);
      await nav().getByRole('link', { name: 'Payables', exact: true }).click();
      await page.getByRole('heading', { name: 'Payables · Payments', exact: true }).waitFor();
      const area = page.getByRole('navigation', { name: 'Area', exact: true });
      assert.deepEqual(await area.getByRole('link').allTextContents(), ['Payments', 'Agreements']);
      assert.equal(await page.getByRole('dialog', { name: 'Workspace navigation' }).isVisible(), false);
      await page.getByRole('navigation', { name: 'Area utilities', exact: true }).getByRole('link', { name: 'Policy & grants', exact: true }).waitFor();
      await openWorkspaceNavigation(page);
      assert.equal(await nav().getByRole('link', { name: 'Payables', exact: true }).getAttribute('aria-current'), 'page');
      await openWorkspaceNavigation(page);
      await nav().getByRole('link', { name: 'Portfolio', exact: true }).click();
      await page.getByRole('heading', { name: 'Available records', exact: true }).waitFor();
      assert.deepEqual(await page.getByRole('navigation', { name: 'Area', exact: true }).getByRole('link').allTextContents(), ['Overview', 'Strategy'], 'tabs survive unavailable agent observations');
      await page.getByRole('navigation', { name: 'Area utilities', exact: true }).getByRole('link', { name: 'Balances & funding', exact: true }).waitFor();
      await openWorkspaceNavigation(page);
      assert.ok(await nav().getByRole('link', { name: 'Payables', exact: true }).isVisible(), 'navigation survives area failure');
      await openWorkspaceNavigation(page);
      await nav().locator('a[href="/#activity"]').click();
      await page.getByRole('heading', { name: 'Activity', exact: true }).waitFor();
      await page.getByLabel('Area', { exact: true }).selectOption('payables');
      assert.equal(await page.getByRole('heading', { name: 'Portfolio', exact: true }).count(), 0);
      await page.getByRole('heading', { name: 'Payables', exact: true }).waitFor();
      assert.ok(await page.getByRole('link', { name: 'Review operation status · payables', exact: true }).getAttribute('href') === '/a/payables/activity');
      await openWorkspaceNavigation(page);
      await nav().getByRole('link', { name: 'Home', exact: true }).click();
      await page.getByRole('heading', { name: 'Home', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}: overflow`);
      assert.ok(!calls.some(call => /(?:tick|set|save|enable|prepare|recover)$/.test(call)), 'workspace navigation never mutates');
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `/tmp/workspace-${width}.png`, fullPage: true });
      await context.close();
      console.log(`PASS ${width}px: shared navigation, area failure, activity filter, direct task links, no mutations`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
