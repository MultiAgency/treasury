const { assertResponsive } = require('./fixtures/layout.cjs');
/** Workspace history stays complete, isolated by agent and read-only across mixed roles. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('./fixtures/browser.cjs');
const { rpcAnswer, rpcBody, UNAVAILABLE } = require('./fixtures/rpc.cjs');
const { workspaceEvidence } = require('./fixtures/workspace.cjs');
const { makeTick } = require('./fixtures/run.cjs');
const root = path.resolve(process.argv[2] || 'web/dist');
const at = '2026-10-15T12:00:00Z';

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    {
      const width = 390;
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const calls = [], errors = [];
      let denied = false, booksFail = false, ledgerFail = false, holdLedger = false, captureLedger, runsFail = false, runsDenied = false;
      const runs = Array.from({ length: 15 }, (_, i) => ({
        ...makeTick(i === 14 ? 'unknown' : i === 13 ? 'refused' : 'quiet', {}),
        id: `treasury-private-run-${i}`, agentId: 'treasury',
      }));
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url()), p = url.pathname;
        if (url.hostname !== 'frontend.test') return route.abort();
        if (p === '/gw/me') return route.fulfill({ json: { agents: [
          { name: 'payables', area: 'payables', owner: 'owner.near', dao: false },
          { name: 'treasury', area: 'treasury', owner: 'owner.near', dao: false },
        ], invoices: null, viewer: { account: 'owner.near', access: {
          payables: { canSign: false, canPropose: false, canVote: false, canExecute: false, canManage: false },
          treasury: { canSign: true, canPropose: true, canVote: true, canExecute: true, canManage: true },
        } } } });
        if (p.includes('/rpc/')) {
          const [, agent, method] = p.match(/^\/a\/(payables|treasury)\/rpc\/(.+)$/) || [];
          assert.ok(agent, 'Every workspace read must select an agent');
          calls.push(`${agent}/${method}`);
          if (denied && agent === 'payables') return route.fulfill({ status: 403, json: { error: 'Fixture agent access denied', access: 'agent' } });
          if (method === 'autopilot/evidence') {
            assert.equal(agent, 'treasury', 'Payables must not read treasury run records');
            if (runsDenied) return route.fulfill({ status: 403, json: { error: 'Fixture run access denied', access: 'agent' } });
            if (runsFail) return route.fulfill({ status: 503, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Fixture run history unavailable' } } });
          }
          if (method === 'ledgerCsv' && holdLedger) { captureLedger(route); return; }
          if (method === 'ledgerCsv' && ledgerFail) return route.fulfill({ status: 503, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Fixture ledger unavailable' } } });
          if (booksFail && method === 'reconcileBooks') return route.fulfill({ status: 503, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Fixture books unavailable' } } });
          const values = {
            overview: { agentId: agent, book: [{ asset: 'usdc', symbol: agent === 'payables' ? 'PAY' : 'TRE', decimals: agent === 'payables' ? 6 : 3, price: null, usd: null, priceUpdatedAt: null, priceExpiresAt: null, public: 0n, confidential: 0n }], digest: null, grants: [], rebalance: { minLegUsd: 1, maxCostBps: 100 }, unmanaged: [], target: {}, notInForce: null, agreed: [],
              policy: workspaceEvidence().overview(agent === 'payables' ? 'payables' : 'treasury').policy },
            activity: [
              ...Array.from({ length: 12 }, (_, i) => ({ at, kind: 'payout', request: { asset: 'usdc', amount: '1000000', recipient: `${agent}-private.near` }, correlationId: `${agent}-operation-${i}`, status: 'SUCCESS' })),
              { at, kind: 'probe', request: {}, correlationId: `${agent}-retired-probe`, refused: 'spend_budget_exceeded' },
            ],
            'owner/actions': Array.from({ length: 7 }, (_, i) => ({ correlationId: `${agent}-owner-${i}`, type: 'approval_vote', signer: 'wallet', stage: i ? 'settled' : 'submitted', ownerSucceeded: Boolean(i), status: i ? 'SUCCESS' : null, expiresAt: '2030-01-01T00:00:00Z', failureCode: null, payment: { correlationId: `${agent}-operation-${i}`, verdict: 'approve' } })),
            unresolved: [{ key: `${agent}-unresolved`, kind: 'payout', at, status: 'PROCESSING', sent: true, request: {} }],
            reconcileBooks: [{ asset: 'usdc', symbol: agent === 'payables' ? 'PAY' : 'TRE', public: { api: '1000000', chain: '1000000', drift: '0' }, confidential: { api: '1000000', recorded: '1000000', unattributed: '0' } }],
            ledgerCsv: 'agent,amount\n' + agent + ',1000000\n',
            'autopilot/evidence': { ticks: runs, corrupt: [16] },
          };
          return route.fulfill({ json: rpcBody(values, method) });
        }
        if (p.startsWith('/static/')) return route.fulfill({ path: root + p, contentType: p.endsWith('.js') ? 'application/javascript' : p.endsWith('.css') ? 'text/css' : 'font/woff2' });
        return route.fulfill({ path: path.join(root, 'index.html'), contentType: 'text/html' });
      });
      await page.goto('http://frontend.test/#activity');
      await page.locator('#payables-operation-payables-operation-11').waitFor();
      await page.locator('#treasury-owner-treasury-owner-6').waitFor();
      assert.equal(await page.locator('[id^="payables-operation-"]').count(), 13, 'includes every retained action and retired probe');
      assert.equal(await page.locator('[id^="payables-owner-"]').count(), 7, 'owner history is not truncated');
      await page.getByText('Run history (15)', { exact: true }).waitFor();
      assert.equal(await page.getByRole('list', { name: 'treasury run history' }).isVisible(), false, 'run summaries start collapsed');
      await page.getByText(/1 run has no recorded end/).waitFor();
      await page.getByText(/1 unreadable run record; this history is incomplete/).waitFor();
      await page.getByText('Run history (15)', { exact: true }).click();
      const runList = page.getByRole('list', { name: 'treasury run history' });
      assert.equal(await runList.locator('li').count(), 15, 'full returned run history remains reviewable');
      assert.equal(await runList.getByRole('link').first().getAttribute('href'), '/a/treasury/follow/run?run=treasury-private-run-14');
      await page.locator('#treasury-run-treasury-private-run-0').waitFor();
      assert.equal(await page.locator('[id^="treasury-operation-"]').count(), 13, 'runs do not duplicate operation history');
      assert.ok(!calls.includes('payables/autopilot/evidence'));
      const historyEndpoints = [...new Set(calls)].sort();
      const filters = page.getByRole('region', { name: 'History filters', exact: true });
      const checks = page.getByRole('heading', { name: 'Recovery and checks', exact: true }).locator('xpath=ancestor::section[1]');
      const search = page.getByLabel('Search history', { exact: true });
      const historyRows = page.locator('[id^="payables-operation-"], [id^="treasury-operation-"], [id^="payables-owner-"], [id^="treasury-owner-"], [id^="treasury-run-"]');
      await assertResponsive(page, "workspace-activity");
      assert.equal(await historyRows.count(), 55, 'all returned records are present before filtering');
      await search.fill('treasury-operation-11');
      await page.locator('#payables-operation-payables-operation-11').waitFor({ state: 'hidden' });
      assert.equal(await historyRows.count(), 1, 'a specific correlation reference selects its single history record');
      assert.equal(await page.locator('#treasury-operation-treasury-operation-11').count(), 1);
      await search.fill('no-such-history-reference');
      await page.locator('#treasury-operation-treasury-operation-11').waitFor({ state: 'hidden' });
      assert.equal(await historyRows.count(), 0);
      assert.ok(await filters.getByText('No records match these filters.', { exact: true }).isVisible());
      await page.getByLabel('Area', { exact: true }).selectOption('payables');
      assert.equal(await checks.getByText('Unresolved operations have no proven outcome. The agent sends nothing new until each is resolved.', { exact: true }).count(), 2, 'area and search filters preserve both agents’ unresolved warnings');
      assert.ok(await checks.getByText(/1 run has no recorded end/).isVisible(), 'a hidden area’s unknown run outcome stays visible');
      assert.ok(await checks.getByText(/1 unreadable run record; this history is incomplete/).isVisible());
      assert.ok(await checks.evaluate(element => Boolean(element.compareDocumentPosition(document.querySelector('[aria-label="History filters"]')) & Node.DOCUMENT_POSITION_FOLLOWING)), 'recovery warnings precede the filters');
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      await page.locator('#treasury-owner-treasury-owner-6').waitFor();
      assert.equal(await historyRows.count(), 55, 'clearing search and area restores every returned record');
      await filters.getByText('More filters', { exact: true }).click();
      await page.getByLabel('Record type', { exact: true }).selectOption('owner');
      await page.getByLabel('Recorded status', { exact: true }).selectOption('owner:submitted');
      await page.locator('#treasury-owner-treasury-owner-6').waitFor({ state: 'hidden' });
      assert.equal(await historyRows.count(), 2, 'submitted owner actions remain separate from money and run statuses');
      const submittedOwner = page.locator('#payables-owner-payables-owner-0');
      assert.match(await submittedOwner.innerText(), /Submission attempted.*Do not sign again/);
      assert.doesNotMatch(await submittedOwner.innerText(), /Owner action succeeded|settled|Paid/);
      assert.equal(await submittedOwner.getByRole('link', { name: 'Follow the payment outcome', exact: true }).getAttribute('href'), '/a/payables/follow/payment?payment=payables-operation-0');
      assert.ok(await filters.getByText('Owner actions, run endings and proposal votes do not establish payment settlement.', { exact: true }).isVisible());
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      await page.getByLabel('From date', { exact: true }).fill('2099-01-01');
      await page.getByLabel('Through date', { exact: true }).fill('2099-01-31');
      await page.locator('#treasury-operation-treasury-operation-11').waitFor({ state: 'hidden' });
      assert.equal(await historyRows.count(), 14, 'a future date range excludes dated operations and runs but retains every undated owner record');
      assert.equal(await page.locator('[id^="treasury-run-"]').count(), 0);
      assert.ok(await filters.getByText(/Undated records, including owner actions, remain included/).isVisible());
      await page.getByLabel('Area', { exact: true }).selectOption('payables');
      await search.fill('payables-owner-0');
      await page.getByLabel('Record type', { exact: true }).selectOption('owner');
      await page.getByLabel('Recorded status', { exact: true }).selectOption('owner:submitted');
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      await page.locator('#treasury-owner-treasury-owner-6').waitFor();
      for (const label of ['Search history', 'Area', 'Record type', 'Recorded status', 'From date', 'Through date'])
        assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), '', `Clear filters resets ${label}`);
      assert.equal(await historyRows.count(), 55, 'Clear filters restores all histories after combining every filter');
      assert.deepEqual([...new Set(calls)].sort(), historyEndpoints, 'history filters introduce no additional RPC endpoints');
      await page.getByText('Run history (15)', { exact: true }).click();
      runsFail = true;
      await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
      await page.getByText(/Run history could not be refreshed/).waitFor();
      assert.equal(await runList.locator('li').count(), 15, 'failed refresh retains run history with an explicit warning');
      await search.fill('no-such-history-reference');
      await page.getByLabel('Area', { exact: true }).selectOption('payables');
      assert.equal(await historyRows.count(), 0);
      assert.ok(await checks.getByText(/Run history could not be refreshed/).isVisible(), 'a failed read remains above the filters even when its area and records are excluded');
      assert.ok(await checks.getByText(/1 run has no recorded end/).isVisible());
      assert.ok(await checks.getByText(/1 unreadable run record; this history is incomplete/).isVisible());
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      await page.locator('#treasury-owner-treasury-owner-6').waitFor();
      await page.getByText('Run history (15)', { exact: true }).click();
      assert.equal(await runList.locator('li').count(), 15, 'clearing filters restores retained runs during read failure');
      runsFail = false;
      await page.getByRole('button', { name: 'Check again', exact: true }).click();
      await page.getByText(/Run history could not be refreshed/).waitFor({ state: 'hidden' });
      await page.getByText(/1 run has no recorded end/).waitFor();
      assert.ok(!calls.some(call => call.endsWith('/reconcileBooks')), 'books stay lazy');
      assert.equal(await page.getByRole('button', { name: /Check operation outcomes|Sign approval|Run now/ }).count(), 0, 'sibling execution access never adds recovery controls to the read-only area');
      assert.match(await page.locator('body').innerText(), /Submission attempted.*Do not sign again/);
      await page.getByLabel('Area', { exact: true }).selectOption('payables');
      assert.equal(await page.getByRole('heading', { name: 'Portfolio', exact: true }).count(), 0);
      await page.getByText('Compare balances with records', { exact: true }).click();
      await page.getByText('Public 1 PAY', { exact: true }).waitFor();
      assert.ok(calls.includes('payables/reconcileBooks'));
      assert.ok(!calls.includes('treasury/reconcileBooks'), 'books never borrow the sibling client');
      await page.getByText('Export', { exact: true }).click();
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Ledger CSV', exact: true }).click();
      assert.match((await download).suggestedFilename(), /^ledger-payables-/);
      assert.ok(calls.includes('payables/ledgerCsv'));
      ledgerFail = true;
      const exportFailure = page.locator('details', { has: page.getByText('Compare balances with records', { exact: true }) }).getByRole('alert').filter({ hasText: UNAVAILABLE });
      await page.getByRole('button', { name: 'Ledger CSV', exact: true }).click();
      await exportFailure.waitFor();
      assert.equal(await page.getByText(/^Books could not be/).count(), 0, 'the failure is the export, not the books read');
      ledgerFail = false;
      const retriedDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Ledger CSV', exact: true }).click();
      assert.match((await retriedDownload).suggestedFilename(), /^ledger-payables-/);
      assert.equal(await exportFailure.count(), 0, 'a retry clears the previous export failure');
      await page.getByText('Owner action reference', { exact: true }).first().click();
      assert.match(await page.getByRole('link', { name: 'Open this owner action', exact: true }).first().getAttribute('href'), /^\/a\/payables\/activity#owner-payables-owner-/);
      assert.match(await page.getByRole('link', { name: 'Follow the payment outcome', exact: true }).first().getAttribute('href'), /^\/a\/payables\/follow\/payment\?payment=/);
      booksFail = true;
      await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
      await page.getByText(/^Books could not be refreshed\./).waitFor();
      await page.locator('details', { has: page.getByText('Compare balances with records', { exact: true }) }).getByRole('alert').filter({ hasText: UNAVAILABLE }).first().waitFor();
      assert.equal(await page.getByText('Public 1 PAY', { exact: true }).count(), 0, 'failed books read does not display cached comparison as current');
      booksFail = false;
      await page.getByRole('button', { name: 'Check again', exact: true }).click();
      await page.getByText('Public 1 PAY', { exact: true }).waitFor();
      await page.getByText('Export', { exact: true }).click();
      holdLedger = true;
      const exportRequested = new Promise(resolve => { captureLedger = resolve; });
      await page.getByRole('button', { name: 'Ledger CSV', exact: true }).click();
      const pendingLedger = await exportRequested;
      denied = true;
      await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
      await page.getByText('Access to an agent changed. Its private records are hidden while permissions refresh.', { exact: true }).waitFor();
      assert.doesNotMatch(await page.locator('body').textContent(), /payables-(?:operation|owner|retired-probe|unresolved|private)/, 'denial removes private content even inside closed disclosures');
      const lateDownload = page.waitForEvent('download', { timeout: 750 }).then(download => download, () => null);
      await pendingLedger.fulfill({ json: rpcAnswer('ledgerCsv', 'agent,amount\npayables,1000000\n') });
      assert.equal(await lateDownload, null, 'a ledger response released after access denial must not download');
      await page.getByLabel('Area', { exact: true }).selectOption('treasury');
      await page.locator('#treasury-operation-treasury-operation-11').waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      runsDenied = true;
      await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
      await page.locator('#treasury-operation-treasury-operation-11').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('[id^="treasury-run-"]').count(), 0, 'denial removes private run records from closed disclosures');
      assert.equal(await page.locator('[id^="treasury-owner-"]').count(), 0, 'run access denial also hides the agent’s other private history');
      assert.deepEqual(errors, []);
      await page.close();
      console.log(`PASS ${width}px: complete filtered history, persistent recovery warnings, scoped links, retained run failures, mixed-role recovery, export retry and access revocation`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
