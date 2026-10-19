const assert = require('node:assert/strict');
const { join } = require('node:path');
const { mkdirSync } = require('node:fs');
const { runTask } = require('./fixtures/task.cjs');
const { workspaceEvidence, workspaceOpener } = require('./fixtures/workspace.cjs');
const { assertAccessible } = require('./fixtures/accessibility.cjs');

async function treasuryAccessibility(browser, root) {
  const failures = [];
  const { budget, setup, overview } = workspaceEvidence();
  const book = overview('treasury');
  book.book[0].priceUpdatedAt = new Date().toISOString();
  book.book[0].priceExpiresAt = new Date(Date.now() + 600_000).toISOString();
  book.policy.policy.budget = { daily_usd: '100', weekly_usd: '100', monthly_usd: '100' };
  const strategy = { targetBps: { usdc: 10000 }, minLegUsd: 1, maxCostBps: 100, autopilot: { everyMin: 60, maxUsd: 10 } };
  for (const state of ['public', 'overview', 'unresolved', 'unavailable', 'strategy', 'draft']) {
    const open = workspaceOpener(root, { budget, values: () => ({
      setup: { ...setup, executor: true }, instance: { agentId: 'fixture', executor: true }, overview: book, treasury: null,
      unresolved: state === 'unresolved' ? [{ key: 'fixture-unresolved', kind: 'swap', sent: true, at: new Date().toISOString(), request: {}, status: null }] : [],
      'owner/actions': [], 'autopilot/get': { on: true, everyMin: 60, maxUsd: 10, lastRun: null, nextRun: null },
      'strategy/get': { strategy, digest: 'fixture', grantSuffix: 'fixture', executor: true, on: true, grantMatches: true, unresolved: 0,
        grant: setup.grant, readiness: { state: 'ready', canEnable: true, reasons: [] }, observedAt: '2026-10-15T12:00:00Z' },
    }) });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    try {
      const { page, calls, errors } = await open(context, ['strategy', 'draft'].includes(state) ? '/a/treasury/automations' : '/a/treasury/',
        state === 'public' ? { public: true } : state === 'unavailable' ? { error: 'autopilot/get' } : {});
      await page.getByRole('heading', { name: state === 'public' ? /Your treasury/ : ['strategy', 'draft'].includes(state) ? 'Targets and schedule' : 'Treasury overview', exact: state !== 'public' }).waitFor();
      if (state === 'unavailable') await page.getByText('Schedule: unavailable', { exact: true }).waitFor();
      if (state === 'draft') await page.getByRole('button', { name: 'Edit strategy', exact: true }).click();
      for (const theme of ['dark', 'light']) {
        await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
        for (const width of [390, 1280]) {
          await page.setViewportSize({ width, height: 844 });
          const label = `${state}-${theme}-${width}`;
          try { await assertAccessible(page, label); }
          catch (error) { failures.push({ label, error: error.message }); }
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: horizontal overflow`);
          const small = await page.locator('button, input:not([type=hidden]), select, textarea, summary').evaluateAll(nodes => nodes
            .filter(n => n.checkVisibility() && n.getBoundingClientRect().height < 44).map(n => n.outerHTML));
          assert.deepEqual(small, [], `${label}: controls must be at least 44px tall`);
          if (process.env.PROTO_BROWSER_ARTIFACTS) {
            mkdirSync(process.env.PROTO_BROWSER_ARTIFACTS, { recursive: true });
            await page.screenshot({ path: join(process.env.PROTO_BROWSER_ARTIFACTS, `${label}.png`), fullPage: true });
          }
        }
      }
      assert.deepEqual(errors, []);
      assert(!calls.some(method => ['executePlan', 'sweep', 'rebalance', 'strategy/save', 'autopilot/enable', 'autopilot/stop', 'owner/prepare'].includes(method)), 'accessibility review never submits actions');
      if (state === 'public') assert.deepEqual(calls, [], 'public review reads no private records');
    } finally { await context.close(); }
  }
  assert.deepEqual(failures, [], 'automated accessibility failures across reviewed states');
}
runTask([treasuryAccessibility]);
