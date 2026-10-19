/** Offline task journeys. Run through test/browser/run.cjs to retain failure diagnostics. */
const { runTask } = require('./fixtures/task.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { rpcAnswer, rpcBody, UNAVAILABLE } = require('./fixtures/rpc.cjs');
const { makeTick, recordingFor } = require('./fixtures/run.cjs');
const { openWorkspaceNavigation } = require('./fixtures/navigation.cjs');
const { openOwnerStatus } = require('./fixtures/owner-status.cjs');
const fs = require('node:fs');
const { assertResponsive } = require('./fixtures/layout.cjs');

async function paymentQueue(browser, root) {
  const request = recipient => ({ recipient, amount: '1000000', asset: 'usdc', confidential: true });
  const at = '2026-10-14T12:00:00Z';
  const invoice = { id: 'a'.repeat(32), payee: 'changed.near', submission: 'fixture-submission', amount: '1000000', note: '', at, reservation: '0', revision: 2, review: true,
    revisions: [{ revision: 1, amount: '1000000', note: '', review: 0 }, { revision: 2, amount: '2000000', note: '', review: 1 }],
    operation: { idempotencyKey: 'invoice:local-key', kind: 'invoices', correlationId: 'changed-payment', at, status: 'SUCCESS', submissionState: 'OBSERVED', request: request('changed.near') } };
  {
    const width = 390;
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const calls = [], errors = [];
    const state = { failed: false, empty: false };
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'frontend.test') return route.abort();
      if (url.pathname === '/gw/me') return route.fulfill({ json: { agents: [{ name: 'payables', owner: 'owner.near', dao: false }], invoices: null,
        viewer: { account: 'owner.near', access: { payables: { canSign: true, canPropose: true, canVote: true, canExecute: true, canManage: true } } } } });
      if (url.pathname.includes('/rpc/')) {
        const method = url.pathname.split('/rpc/')[1]; calls.push(method);
        if (state.failed && method === 'invoices') return route.fulfill({ status: 503, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Invoice fixture unavailable' } } });
        const values = {
          instance: { agentId: 'queue-fixture', executor: true },
          setup: { agentId: 'queue-fixture', executor: true, wallet: 'agent.near', owner: { type: 'near', account_id: 'owner.near', public_key: 'ed25519:fixture' }, grant: { id: 'grant-fixture', label: 'payout', expiresAt: '2030-01-01T00:00:00Z' }, dao: null },
          overview: { agentId: 'queue-fixture', digest: 'fixture', notInForce: null, agreed: [], unmanaged: [], target: { usdc: 1 },
            book: [{ asset: 'usdc', symbol: 'USDC', decimals: 6, public: 0n, confidential: 10000000n, usd: 10, price: 1, priceUpdatedAt: null, priceExpiresAt: null }],
            policy: { policy: { actions: ['transfer'], frozen: false, assets: 'any', owner_approval: true, destinations: { mode: 'only', list: [] }, confidential: false, limits: {}, max_actions_per_hour: 10, budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, timelock_ms: 0 }, usage: { budget: { daily: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, weekly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, monthly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null } }, timelock: { delay_ms: 0, scheduled_count: 0 } }, cooldowns: { policy_change_available_at: null, unfreeze_available_at: null }, wallet_id: 'agent.near', revision: null, status: 'APPLIED', provider_policy_synced: true }, grants: [], rebalance: { minLegUsd: 1, maxCostBps: 100 } },
          'treasury/get': null, 'inbox/list': [], 'agreements/list': [], 'owner/actions': [],
          'owner/pending': state.empty ? [] : ['done', 'expired'].map(state => ({ correlationId: `pending-${state}`, type: 'approval_vote', hash: `hash-${state}`, intent: { standard: 'nep413', payload: { message: '{}', recipient: 'fixture', nonce: 'fixture' } }, delegate: null, state, expiresAt: '2030-01-01T00:00:00Z', payment: { correlationId: 'settled-payment', verdict: 'approve' } })),
          held: state.empty ? [] : [{ correlationId: 'older-held', approvalId: 'approval-old', at: '2026-10-01T00:00:00Z', request: request('older.near'), kind: 'payout' }],
          unresolved: [], invoices: state.empty ? [] : [invoice],
          activity: state.empty ? [] : [{ correlationId: 'settled-payment', idempotencyKey: 'settled-key', kind: 'payout', at, status: 'SUCCESS', request: request('settled.near') }],
          paymentHistory: { items: state.empty ? [] : [{ correlationId: 'settled-payment', at }, { correlationId: 'unknown-payment', at }], complete: !state.failed },
        };
        return route.fulfill({ json: rpcBody(values, method) });
      }
      if (url.pathname.startsWith('/static/')) return route.fulfill({ path: root + url.pathname,
        contentType: url.pathname.endsWith('.js') ? 'application/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'font/woff2' });
      return route.fulfill({ path: path.join(root, 'index.html'), contentType: 'text/html' });
    });
    await page.goto('http://frontend.test/a/payables/');
    const filter = page.getByLabel('Show payments', { exact: true });
    const search = page.getByLabel('Search recipient or reference', { exact: true });
    const queue = page.getByRole('list', { name: 'Payment records' });
    await filter.waitFor();
    await queue.getByText('1 USDC to older.near', { exact: true }).waitFor();
    const needsReview = filter.getByRole('radio', { name: /^Needs review/ });
    const allRecords = filter.getByRole('radio', { name: /^All records/ });
    assert.equal(await needsReview.getAttribute('aria-checked'), 'true');
    assert.equal(await queue.locator('li').count(), 3);
    assert.match(await queue.locator('li').first().innerText(), /older.near/);
    assert.equal(await queue.getByText('1 USDC to settled.near', { exact: true }).count(), 0);
    await queue.getByText('Invoice changes need review', { exact: true }).waitFor();
    await needsReview.focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.activeElement?.textContent?.startsWith('All records'));
    await page.keyboard.press('Space');
    await queue.getByText('1 USDC to settled.near', { exact: true }).waitFor();
    assert.equal(await allRecords.getAttribute('aria-checked'), 'true', 'keyboard selects the visible alternative');
    await allRecords.click();
    assert.equal(await allRecords.getAttribute('aria-checked'), 'true', 'a required filter cannot become unselected');
    await queue.getByText('1 USDC to settled.near', { exact: true }).waitFor();
    assert.equal(await queue.locator('li').count(), 4);
    await search.fill('  SETTLED.NEAR  ');
    assert.equal(await queue.locator('li').count(), 1);
    await search.fill('invoice:local-key');
    await queue.getByText('1 USDC to changed.near', { exact: true }).waitFor();
    assert.equal(await queue.locator('li').count(), 1);
    await search.fill(invoice.id);
    assert.equal(await queue.locator('li').count(), 1);
    await search.fill('unknown-payment');
    assert.equal(await queue.locator('li').count(), 1);
    await search.fill('no-match');
    await page.getByText('No matching records.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    assert.equal(await search.inputValue(), '');
    assert.equal(await queue.locator('li').count(), 4);
    assert.equal(await page.getByLabel('Recipient’s NEAR account', { exact: true }).isVisible(), false);
    const create = page.getByText('Create payment', { exact: true });
    const recipient = page.getByLabel('Recipient’s NEAR account', { exact: true });
    await create.focus();
    await page.keyboard.press('Enter');
    await recipient.fill('draft.near');
    await create.click();
    assert.equal(await recipient.isVisible(), false);
    await create.click();
    assert.equal(await recipient.inputValue(), 'draft.near', 'collapsing creation preserves the draft');
    await assertResponsive(page, "payment-queue");
    await recipient.fill('');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
    assert.ok(await create.evaluate(element => element.closest('summary').getBoundingClientRect().right <= innerWidth), 'creation entry fits at twice the base text size');
    assert.ok(await page.getByRole('button', { name: 'Review payment', exact: true }).evaluate(element => element.getBoundingClientRect().right <= innerWidth), 'review action fits at twice the base text size');
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    assert.ok(!calls.includes('paymentStatus'), 'filtering/search never mounts per-row provider reads');
    assert.ok(!calls.some(method => /^(pay|cancelPreparedInvoice)$|owner\/(prepare|submit)/.test(method)), 'discovery and creation entry submit nothing');
    state.failed = true;
    await page.reload();
    await page.getByText(/Recent payment history is incomplete/).waitFor();
    await page.getByText(/Invoice records could not be loaded/).waitFor();
    await search.fill('no-match');
    await page.getByText(/Recent payment history is incomplete/).waitFor();
    await page.getByText(/Invoice records could not be loaded/).waitFor();
    assert.equal(await page.getByText('No records need review.', { exact: true }).count(), 0);
    state.empty = true; state.failed = false;
    await page.reload();
    await page.getByText('No payment records found in the sources checked.', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS queue priority, search, creation, incomplete reads and empty state at ${width}px`);
  }
}

async function paymentDetail(browser, root) {
  const budget = Object.fromEntries(['daily', 'weekly', 'monthly'].map(period => [period,
    { limit_usd: '100', remaining_usd: '90', spent_usd: '10', resets_at: null },
  ]));
  const setup = { agentId: 'fixture', executor: true, wallet: 'agent.near', owner: { type: 'near', account_id: 'owner.near', public_key: 'ed25519:fixture' },
    grant: { id: 'grant-fixture', label: 'treasury', expiresAt: '2030-01-01T00:00:00Z' }, dao: null };
  const overview = kind => ({ agentId: 'fixture', digest: 'fixture', notInForce: null, agreed: [], unmanaged: [],
    rebalance: { minLegUsd: 1, maxCostBps: 100 }, target: { usdc: 1 },
    book: [{ asset: 'usdc', symbol: 'USDC', decimals: 6, public: 0n, confidential: 10000000n, usd: 10, price: 1, priceUpdatedAt: null, priceExpiresAt: null }],
    policy: { policy: { actions: kind === 'treasury' ? ['swap', 'transfer'] : ['transfer'], frozen: false,
      destinations: { mode: 'only', list: [] }, assets: 'any', confidential: false, owner_approval: false, limits: {}, max_actions_per_hour: 10, budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, timelock_ms: 0 }, usage: { budget, timelock: { delay_ms: 0, scheduled_count: 0 } }, cooldowns: { policy_change_available_at: null, unfreeze_available_at: null }, wallet_id: 'agent.near', revision: null, status: 'APPLIED', provider_policy_synced: true },
grants: [] });
  const invoiceRecord = ({ letter = 'a', correlationId, submissionState = 'PREPARED', review = false, refused } = {}) => ({
    id: letter.repeat(32), payee: 'invoice-payee.near', submission: 'fixture-submission', at: '2026-10-14T12:00:00Z',
    amount: '1000000', note: 'Original invoice terms', reservation: '1000000', revision: 1, review,
    revisions: [{ revision: 1, amount: '1000000', note: 'Original invoice terms', review: 0 },
      ...(review ? [{ revision: 2, amount: '2000000', note: 'Revised terms need review', review: 1 }] : [])],
    operation: { idempotencyKey: `invoices:local-key-${letter}`, at: '2026-10-14T12:00:00Z', kind: 'invoices', submissionState,
      status: submissionState === 'PREPARED' ? 'PREPARED' : refused ? 'UNKNOWN' : 'PROCESSING', correlationId, refused,
      request: { amount: '1000000', asset: 'usdc', recipient: 'invoice-payee.near', confidential: true } },
  });
  async function open(context, routePath, options = {}) {
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const calls = [];
    const requests = [];
    const errors = [];
    const state = { error: options.error, delay: options.delay, invoices: options.invoices || [], errorStatus: 500 };
    const paymentReferences = [];
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
      const url = new URL(route.request().url());
      if (url.hostname !== 'frontend.test') return route.abort();
      const pathname = url.pathname;
      if (pathname === '/gw/me') {
        if (++gatewayReads > 1 && options.invoiceLinkError) return route.fulfill({ status: 503, json: { error: 'Invoice link unavailable' } });
        return route.fulfill({ json: {
        agents: (options.onlyPayables ? ['payables'] : ['treasury', 'payables']).map(name => ({ name, owner: 'owner.near', dao: false })),
        invoices: options.noInvoiceLink ? null : 'https://invoices.example', viewer: options.public ? null : { account: 'owner.near',
          access: Object.fromEntries((options.onlyPayables ? ['payables'] : ['treasury', 'payables']).map(name => [name, { canSign: !(options.member && name === 'payables'), canPropose: !(options.member && name === 'payables'), canVote: !(options.member && name === 'payables'), canExecute: !(options.member && name === 'payables'), canManage: !(options.member && name === 'payables') }])) },
      } });
      }
      if (pathname.includes('/rpc/')) {
        const method = pathname.split('/rpc/')[1];
        calls.push(method);
        requests.push(pathname);
        if (method === 'paymentStatus') paymentReferences.push(route.request().postDataJSON().json.correlationId);
        if (method === state.delay && (!options.onlyTreasury || pathname.includes('/treasury/'))) await new Promise(resolve => setTimeout(resolve, 2500));
        if (page.isClosed()) return;
        if (method === state.error && (!options.onlyTreasury || pathname.includes('/treasury/'))) {
          return route.fulfill({ status: state.errorStatus, json: { json: { defined: false, code: state.errorStatus === 403 ? 'FORBIDDEN' : 'INTERNAL_SERVER_ERROR', message: 'Fixture read unavailable' } } });
        }
        const kind = pathname.includes('/payables/') ? 'payables' : 'treasury';
        const values = { get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup: { ...setup, ...(options.noGrant && { grant: null }), ...(options.approveOnly && { executor: false }) }, overview: overview(kind), 'treasury/get': null, held: options.held && kind === 'payables' && !state.settled ? ['payment-one','payment-two'].map(correlationId => ({ correlationId, kind: 'payout', approvalId: 'approval-' + correlationId, at: new Date().toISOString(), request: { amount: '1000000', asset: 'usdc', recipient: 'payee.near', confidential: true } })) : [], unresolved: options.unresolved && kind === 'payables' ? [{ kind: 'payout', at: new Date().toISOString(), key: 'fixture-unresolved', request: {}, status: null, sent: false }] : [],
          'inbox/list': [], 'agreements/list': options.agreed ? [{ id: 'agreement-fixture', payee: 'payee.near', amount: '1000000', status: 'agreed', origin: 'owner', at: '2026-10-01T00:00:00Z', note: '' }] : [], activity: [], invoices: [], reconcileBooks: [], 'owner/pending': [], 'owner/actions': [{ correlationId: 'owner-fixture', type: 'approval_vote', stage: 'settled', ownerSucceeded: true, payment: { correlationId: 'payment-one', verdict: 'approve' }, status: null, failureCode: null, expiresAt: '2030-01-01T00:00:00Z', signer: 'wallet' }], paymentHistory: { items: options.held ? ['payment-one','payment-two'].map(correlationId => ({ correlationId, at: '2026-10-14T00:00:00Z' })) : [], complete: true }, paymentStatus: { status: state.settled ? 'SUCCESS' : 'PROCESSING', request: { amount: '1000000', asset: 'usdc', recipient: 'payee.near', confidential: true }, approvalId: 'approval-one', expiresAt: '2030-01-01T00:00:00Z', failureCode: null, createdAt: null, updatedAt: null, detailError: null, evidence: { txHash: null, destinationTxHash: null, refundTxHash: null, refundTo: null, refundedAmount: null } },
          'autopilot/get': { on: true, everyMin: 60, maxUsd: 10, lastRun: null, nextRun: null },
          'autopilot/evidence': { ticks: [run], corrupt: [] } };
        values.invoices = state.invoices;
        if (options.noOwnerActions) values['owner/actions'] = [];
        if (method === 'cancelPreparedInvoice') {
          const { id } = route.request().postDataJSON().json;
          const invoice = state.invoices.find(invoice => invoice.id === id);
          assert.equal(invoice.operation.submissionState, 'PREPARED');
          assert.ok(!options.approveOnly && !options.member);
          invoice.operation.submissionState = 'RESOLVED';
          invoice.operation.refused = 'invoice_cancelled_before_submission';
          invoice.reservation = '0';
          return route.fulfill({ json: rpcAnswer(method, invoice) });
        }
        if (options.unmanaged) {
          values.overview.unmanaged = [{ asset: 'unmanaged', symbol: 'OTHER', amount: 1000000n, decimals: 6, usd: null, price: null, priceUpdatedAt: null, priceExpiresAt: null }];
          values.overview.policy.policy.assets = options.excluded ? ['usdc'] : 'any';
        }
        if (method === 'autopilot/log') {
          assert.equal(route.request().postDataJSON().json.tickId, run.id, 'recording read must select the displayed run');
          assert.ok(!options.approveOnly, 'approve-only views must not read recordings');
          return route.fulfill({ json: rpcAnswer(method, recordingFor(run)) });
        }
        if (options.oldRun && method === 'autopilot/evidence') {
          const input = route.request().postData() || url.search;
          values[method] = { ticks: input.includes('since') ? [] : [run], corrupt: [] };
        }
        assert.ok(method in values, `Unexpected RPC: ${method}`);
        return route.fulfill({ json: rpcBody(values, method) });
      }
      if (pathname.startsWith('/static/')) return route.fulfill({ path: root + pathname,
        contentType: pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'font/woff2' });
      return route.fulfill({ path: path.join(root, 'index.html'), contentType: 'text/html' });
    });
    await page.goto('http://frontend.test' + routePath);
    return { page, calls, errors, state, requests, paymentReferences };
  }
  {
    const width = 390;
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const { page, state, calls, errors } = await open(context, '/a/payables/follow/payment?payment=payment-one', { held: true });
    await page.getByText('Owner decision', { exact: true }).waitFor();
    await page.getByText('Approval recorded', { exact: true }).waitFor();
    await page.getByText('Payment processing', { exact: true }).waitFor();
    assert.equal(await page.getByText('Paid', { exact: true }).count(), 0);
    await page.getByText('1 USDC to payee.near', { exact: true }).first().waitFor();
    assert.ok(!await page.getByRole('region', { name: 'Provider-reported payment evidence' }).isVisible());
    await page.getByText('Provider evidence', { exact: true }).click();
    await page.getByRole('region', { name: 'Provider-reported payment evidence' }).waitFor();
    state.settled = true;
    await page.reload();
    await page.getByText('Paid', { exact: true }).waitFor();
    await page.getByText('Approval recorded', { exact: true }).waitFor();
    await page.getByText('Current agreement terms', { exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('payment'), 'payment-one');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.ok(!calls.some(call => /owner\/(prepare|submit)|^pay$/.test(call)));
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `/tmp/payment-detail-${width}.png`, fullPage: true });
    await assertResponsive(page, "payment-detail");
    await context.close();
    console.log(`PASS separate owner decision and payment outcome, retained terms and evidence at ${width}px`);
  }
  {
    const context = await browser.newContext({ viewport: { width: 320, height: 900 } });
    const prepared = invoiceRecord({ letter: 'b' });
    const submitted = invoiceRecord({ correlationId: 'payment-one', submissionState: 'OBSERVED', review: true });
    const { page, calls, errors, paymentReferences } = await open(context, '/a/payables/', {
      held: true, noOwnerActions: true, invoices: [submitted, prepared],
    });
    const queue = page.getByRole('list', { name: 'Payment records' });
    await queue.locator('li').nth(2).waitFor();
    assert.equal(await queue.locator('li').count(), 3, 'submitted invoice joins its payment instead of duplicating it');
    await queue.getByText('Invoice changes need review', { exact: true }).waitFor();
    assert.equal(await page.getByText('Original invoice terms', { exact: true }).count(), 0, 'queue does not mount every invoice detail');
    assert.deepEqual(paymentReferences, [], 'queue must not read provider status for every row');
    await queue.locator(`a[href*="invoice=${prepared.id}"]`).click();
    await page.getByRole('heading', { name: 'Invoice details', exact: true }).waitFor();
    await page.getByText('This invoice is prepared; nothing has been submitted.', { exact: true }).waitFor();
    assert.deepEqual(paymentReferences, [], 'local invoice ID and operation key are not provider correlation IDs');
    assert.equal(await page.getByRole('button', { name: 'Cancel unsubmitted invoice', exact: true }).isVisible(), true, 'cancellation is discoverable with identifiers closed');
    assert.equal(await page.getByText(`Operation key ${prepared.operation.idempotencyKey}`, { exact: true }).isVisible(), false);
    await page.getByRole('button', { name: 'Cancel unsubmitted invoice', exact: true }).click();
    assert.ok(!calls.includes('cancelPreparedInvoice'), 'opening confirmation cannot cancel');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel invoice', exact: true }).click();
    await page.getByText('Reserved: 0 USDC', { exact: false }).waitFor();
    assert.equal(calls.filter(call => call === 'cancelPreparedInvoice').length, 1);
    assert.equal(await page.getByRole('button', { name: 'Cancel unsubmitted invoice', exact: true }).count(), 0);
    assert.deepEqual(paymentReferences, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS one payment/invoice queue, review attention, prepared identity and confirmed cancellation');
  }
  for (const scenario of ['submitted', 'mismatch', 'refused', 'unknown', 'approve-only', 'member', 'missing', 'setup-error']) {
    const context = await browser.newContext();
    const invoice = invoiceRecord({ correlationId: ['submitted', 'mismatch'].includes(scenario) ? 'payment-one' : undefined,
      submissionState: ['submitted', 'mismatch'].includes(scenario) ? 'OBSERVED' : ['refused', 'unknown'].includes(scenario) ? 'UNKNOWN' : 'PREPARED',
      refused: scenario === 'refused' ? 'invoice_cancelled_before_submission' : undefined,
      review: scenario === 'submitted' });
    const search = scenario === 'submitted' ? 'payment=payment-one' : `invoice=${invoice.id}${scenario === 'mismatch' ? '&payment=other-payment' : ''}`;
    const { page, calls, errors, paymentReferences } = await open(context, `/a/payables/follow/payment?${search}`, {
      invoices: scenario === 'missing' ? [] : [invoice], noOwnerActions: true,
      approveOnly: scenario === 'approve-only', member: scenario === 'member', error: scenario === 'setup-error' ? 'setup' : undefined,
    });
    if (scenario === 'submitted') {
      await page.getByText('Payment processing', { exact: true }).waitFor();
      await page.getByText('Invoice changes need review; the original payment is unchanged.', { exact: true }).waitFor();
      await page.getByText(/Revision 2: 2 USDC/).waitFor();
      assert.ok(paymentReferences.length > 0 && paymentReferences.every(id => id === 'payment-one'));
    } else if (scenario === 'mismatch') {
      await page.getByRole('alert').filter({ hasText: 'The invoice and payment references do not match.' }).waitFor();
    } else if (scenario === 'member') {
      await page.getByRole('heading', { name: 'Invoice details', exact: true }).waitFor();
      assert.ok(calls.includes('invoices'), 'admitted members can inspect invoice evidence');
      assert.equal(await page.getByRole('button', { name: 'Cancel unsubmitted invoice', exact: true }).isDisabled(), true, 'read access cannot cancel an invoice');
    } else if (scenario === 'missing') {
      await page.getByText(/This invoice is not recorded on this instance/).waitFor();
      await page.getByText(/Held payouts may originate on another executor/).waitFor();
    } else if (scenario === 'setup-error') {
      await page.getByText(/An invoice identity is not a provider payment reference/).waitFor();
    } else {
      await page.getByRole('heading', { name: 'Invoice details', exact: true }).waitFor();
      if (scenario === 'unknown') await page.getByText(/The operation outcome is unresolved/).waitFor();
      if (scenario === 'approve-only') {
        assert.ok(await page.getByRole('button', { name: 'Cancel unsubmitted invoice', exact: true }).isVisible());
        assert.ok(await page.getByRole('button', { name: 'Cancel unsubmitted invoice', exact: true }).isDisabled());
      } else assert.equal(await page.getByRole('button', { name: 'Cancel unsubmitted invoice', exact: true }).count(), 0);
    }
    if (scenario !== 'submitted') assert.deepEqual(paymentReferences, [], 'only a recorded provider correlation ID permits payment status reads');
    assert.ok(!calls.some(call => /owner\/(prepare|submit)|^pay$|cancelPreparedInvoice/.test(call)));
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS invoice detail ${scenario}`);
  }
  for (const source of ['invoices', 'activity']) {
    const context = await browser.newContext();
    const invoice = invoiceRecord();
    const { page, calls, state, errors } = await open(context, `/a/payables/follow/payment?invoice=${invoice.id}`, {
      invoices: [invoice], noOwnerActions: true,
    });
    await page.getByRole('heading', { name: 'Invoice details', exact: true }).waitFor();
    const cancel = page.getByRole('button', { name: 'Cancel unsubmitted invoice', exact: true });
    assert.ok(await cancel.isEnabled());
    if (source === 'invoices') {
      state.error = 'invoices';
      await context.setOffline(true); await context.setOffline(false);
      await page.getByText(/Invoice records could not be refreshed/).waitFor();
      assert.ok(await cancel.isDisabled(), 'retained records cannot authorize cancellation after a failed refresh');
      assert.ok(await page.getByText('Original invoice terms', { exact: true }).first().isVisible());
    }
    state.error = source;
    state.errorStatus = 403;
    await context.setOffline(true); await context.setOffline(false);
    await page.getByRole('heading', { name: 'Invoice details', exact: true }).waitFor({ state: 'hidden' });
    assert.ok(!(await page.locator('body').textContent()).includes('Original invoice terms'), 'denied records must leave the DOM, including closed disclosures');
    assert.equal(await cancel.count(), 0);
    assert.ok(!calls.includes('cancelPreparedInvoice'));
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS cached invoice privacy after ${source} denial`);
  }
}

async function paymentRecovery(browser, root) {
  const results = [];
  for (const scenario of ['local-history','latest-terms','wallet-submitted','owner-read-error','receipt','history-error','unverified-history','status-error','rejection','grantless','focused-card','held-error','history-incomplete']) {
    if (process.env.SCENARIO && process.env.SCENARIO !== scenario) continue;
    const page = await browser.newPage({viewport:{width:390,height:900}});
    page.setDefaultTimeout(5000);
    const at = new Date(Date.now()-3600000).toISOString();
    const expiresAt = new Date(Date.now()+3600000).toISOString();
    const request = {asset:'usdc',amount:'123456789',recipient:'payee.near',confidential:true};
    const writes=[];
    let statusReads=0;
    let reloaded=false;
    await page.route('**/*', async route => {
      const u=new URL(route.request().url()), p=u.pathname;
      if(u.hostname!=='frontend.test') return route.abort();
      if(p==='/gw/me') return route.fulfill({json:{agents:[{name:'payables',owner:'owner.near',dao:false}],invoices:null,viewer:{account:'owner.near',access:{payables:{canSign:true,canPropose:true,canVote:true,canExecute:true,canManage:true}}}}});
      if(p.includes('/rpc/')) {
        const method=p.split('/rpc/')[1];
        if(method==='paymentStatus') statusReads++;
        if(['owner/prepare','owner/submit','pay'].includes(method)) writes.push(method);
        if((scenario==='held-error' && method==='held') || (scenario==='owner-read-error' && method==='owner/actions') || (scenario==='history-error' && method==='paymentHistory') || (scenario==='status-error' && method==='paymentStatus')) return route.fulfill({status:500,json:{json:{defined:false,code:'INTERNAL_SERVER_ERROR',message:'Fixture read unavailable'}}});
        const settled=scenario==='rejection'||scenario==='unverified-history'||(scenario==='receipt'&&reloaded);
        const held=['latest-terms','wallet-submitted','owner-read-error','status-error','rejection','focused-card'].includes(scenario)||(scenario==='receipt'&&!reloaded);
        const values={
          get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup:{executor:false,agentId:'fixture',wallet:'agent.near',owner:{type:'near',account_id:'owner.near',public_key:'ed25519:fixture'},grant:scenario==='grantless'?null:{id:'grant-fixture',label:'payout',expiresAt},dao:null},
          overview:{agentId:'fixture',digest:'fixture',notInForce:null,agreed:[],unmanaged:[],target:{usdc:1},rebalance:{minLegUsd:1,maxCostBps:100},book:[{asset:'usdc',symbol:'USDC',decimals:6,public:0n,confidential:10000000n,usd:10,price:1,priceUpdatedAt:null,priceExpiresAt:null}],policy:{policy:{actions:['transfer'],frozen:false,destinations:{mode:'only',list:[]},assets:'any',budget:{daily_usd:null,weekly_usd:null,monthly_usd:null},limits:{},confidential:false,owner_approval:false,max_actions_per_hour:10,timelock_ms:0},usage:{budget:{daily:{limit_usd:null,spent_usd:'0',remaining_usd:null,resets_at:null},weekly:{limit_usd:null,spent_usd:'0',remaining_usd:null,resets_at:null},monthly:{limit_usd:null,spent_usd:'0',remaining_usd:null,resets_at:null}},timelock:{delay_ms:0,scheduled_count:0}},cooldowns:{policy_change_available_at:null,unfreeze_available_at:null},wallet_id:'agent.near',revision:null,status:'APPLIED',provider_policy_synced:true},grants:[]},
          'treasury/get':null,held:scenario==='focused-card' ? [...(!reloaded?[{at,kind:'remote',request,correlationId:'payment',approvalId:'approval'}]:[]),{at,kind:'remote',request:{...request,amount:'2000000'},correlationId:'second-payment',approvalId:'second-approval'}] : held?[{at,kind:'remote',request,correlationId:'payment',approvalId:'approval'}]:[],unresolved:[],activity:[],'inbox/list':[],'agreements/list':scenario==='latest-terms' ? [
            {id:'declined',at,origin:'owner',amount:'1',payee:'payee.near',status:'declined',terms:{maxAmount:'1',until:'2030-01-01T00:00:00Z'},note:''},
            {id:'other',at,origin:'owner',amount:'2',payee:'other.near',status:'agreed',terms:{maxAmount:'2',until:'2030-01-01T00:00:00Z'},note:''},
            {id:'new',at,origin:'owner',amount:'200000000',payee:'payee.near',status:'agreed',terms:{maxAmount:'200000000',until:'2030-01-01T00:00:00Z'},note:''},
            {id:'old',at,origin:'owner',amount:'100000000',payee:'payee.near',status:'agreed',terms:{maxAmount:'100000000',until:'2020-01-01T00:00:00Z'},note:''}
          ] : [],'owner/pending':[],
          'owner/actions':['wallet-submitted','rejection'].includes(scenario)?[{correlationId:'wallet-action',type:'approval_vote',signer:'wallet',stage:scenario==='rejection'?'settled':'submitted',expiresAt:'2020-01-01T00:00:00Z',ownerSucceeded:scenario==='rejection',status:scenario==='rejection'?'FAILED':null,payment:{correlationId:'payment',verdict:scenario==='rejection'?'reject':'approve'},failureCode:null}]:[],
          paymentHistory:{items:scenario==='receipt'&&reloaded?[{correlationId:'payment',at}]:[],complete:scenario!=='history-incomplete'},
          paymentStatus:{status:scenario==='rejection'?'FAILED':settled?'SUCCESS':'PENDING_APPROVAL',failureCode:null,createdAt:at,updatedAt:at,request,approvalId:scenario==='unverified-history'?null:'approval',expiresAt,detailError:null, evidence: { txHash: null, destinationTxHash: null, refundTxHash: null, refundTo: null, refundedAmount: null } },
          'autopilot/get':{on:false,everyMin:60,maxUsd:10,lastRun:null,nextRun:null},'autopilot/evidence':{ticks:[],corrupt:[]},'strategy/get':{},invoices:[],ledger:[],reconcileBooks:[],
        };
        if (scenario === 'local-history') {
          values.activity = [{ at, kind: 'invoices', request, correlationId: 'retained-payment', status: 'SUCCESS' }];
          values.paymentHistory = { items: [], complete: false };
        }
        return route.fulfill({json: rpcBody(values, method)});
      }
      if(p.startsWith('/static/')) return route.fulfill({path:root+p,contentType:p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':'font/woff2'});
      return route.fulfill({path:root+'/index.html',contentType:'text/html'});
    });
    try {
      await page.goto('http://frontend.test/a/payables/'+(scenario==='grantless'?'activity':['local-history','history-error','held-error','history-incomplete'].includes(scenario)?'':'follow/payment?payment=payment'));
      await page.waitForTimeout(1800);
      if (scenario === 'local-history') {
        await page.getByRole('radio', { name: /^All records/ }).click();
        const record = page.getByRole('list', { name: 'Payment records' }).getByRole('link').filter({ hasText: 'retained-payment' });
        await record.waitFor();
        assert.match(await record.innerText(), /123\.456789 USDC to payee\.near/);
        assert.equal(statusReads, 0, 'retained summaries must not poll individual payments');
        await page.reload();
        await page.getByRole('radio', { name: /^All records/ }).click();
        await record.waitFor();
        assert.match(await record.innerText(), /123\.456789 USDC to payee\.near/);
      }
      if(scenario==='latest-terms') { await page.getByText(/Each invoice up to 200 USDC/).waitFor(); await page.getByText('Within recorded terms',{exact:true}).waitFor(); assert.equal(await page.getByText('Outside agreed terms',{exact:true}).count(),0); }
      if(scenario==='receipt') { reloaded=true; await page.reload(); await page.getByText('Paid',{exact:true}).waitFor(); assert.match(await page.locator('body').innerText(),/123\.456789 USDC/); }
      if(scenario==='wallet-submitted') { await page.getByText(/Submission attempted.*checking/i).first().waitFor(); assert.equal(await page.getByRole('button',{name:'Sign approval',exact:true}).count(),0); assert.equal(await page.getByRole('button',{name:'Sign rejection',exact:true}).count(),0); await page.reload(); await page.getByText(/Submission attempted.*checking/i).first().waitFor(); assert.equal(await page.getByRole('button',{name:'Sign approval',exact:true}).count(),0); }
      if(scenario==='wallet-submitted') { await page.getByRole('link',{name:'Review the existing owner action',exact:true}).click(); await page.locator('#owner-wallet-action').waitFor(); await page.getByRole('link',{name:'Follow the payment outcome',exact:true}).waitFor(); }
      if(scenario==='owner-read-error') { await page.locator('section',{has:page.getByRole('heading',{name:'Follow this payment',exact:true})}).getByText(UNAVAILABLE,{exact:true}).first().waitFor(); assert.equal(await page.getByRole('button',{name:'Sign approval',exact:true}).count(),0); }
      if(scenario==='held-error') { await page.locator('section',{has:page.getByRole('heading',{name:'Needs attention',exact:true})}).getByText(UNAVAILABLE,{exact:true}).waitFor({timeout:12000}); assert.doesNotMatch(await page.locator('body').innerText(),/Checking payments and owner actions/); }
      if(scenario==='history-error') { await page.locator('section',{has:page.getByRole('heading',{name:'Payments',exact:true})}).getByText(UNAVAILABLE,{exact:true}).first().waitFor(); assert.doesNotMatch(await page.locator('body').innerText(),/Nothing waits for a vote/); }
      if(scenario==='status-error') {
        await page.locator('section',{has:page.getByRole('heading',{name:'Follow this payment',exact:true})}).getByText(UNAVAILABLE,{exact:true}).first().waitFor();
        const reads=statusReads;
        await page.waitForTimeout(1600);
        assert.equal(statusReads,reads,'A failed status read must stop automatic polling until explicit retry');
        await page.getByRole('button',{name:'Check again',exact:true}).first().click();
        await page.waitForTimeout(300);
        assert.ok(statusReads>reads,'Explicit retry must remain available');
      }
      if(scenario==='history-incomplete') { assert.match(await page.locator('body').innerText(),/history is incomplete/); assert.doesNotMatch(await page.locator('body').innerText(),/Nothing waits for a vote/); }
      if(scenario==='unverified-history') { await page.getByText('Paid',{exact:true}).waitFor(); assert.match(await page.locator('body').innerText(),/Approval history is unverified/); assert.doesNotMatch(await page.locator('body').innerText(),/invoice stays with the invoice host|Each payment is held until/); }
      if(scenario==='rejection') { const text=await page.locator('body').innerText(); assert.match(text,/Rejection submitted/); assert.doesNotMatch(text,/Not paid|nothing is paid/); }
      if(scenario==='grantless') { await openWorkspaceNavigation(page); await page.getByRole('navigation',{name:'Workspace',exact:true}).getByRole('link',{name:'Activity',exact:true}).waitFor(); }
      if(scenario==='focused-card') {
        const receiptLink=page.getByRole('link',{name:'Link to this payment',exact:true}).first();
        await receiptLink.focus();
        const href=await receiptLink.getAttribute('href');
        reloaded=true;
        await page.waitForTimeout(16500);
        assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('href')),href, 'Reviewed card must not move into collapsed history after polling');
      }
      if(scenario==='wallet-submitted') {
        for(const width of [320,1280]) {
          await page.setViewportSize({width,height:900});
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        }
      }
      assert.deepEqual(writes,[], 'Recovery must never prepare, sign or submit a new action');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      if(process.env.ARTIFACT_DIR) { require("node:fs").mkdirSync(process.env.ARTIFACT_DIR,{recursive:true}); await page.screenshot({path:require("node:path").join(process.env.ARTIFACT_DIR,scenario+".png"),fullPage:true}); }
      results.push({scenario,pass:true});
    } catch(e) {results.push({scenario,pass:false,error:e.message});}
    await page.close();
  }
  console.log(JSON.stringify(results,null,2));
  assert.ok(results.length > 0 && results.every(r=>r.pass), "All scenarios must pass");
}

async function ownerDecisionEvidence(browser, root) {
  const results = [];
  const width = 390;
  for (const scenario of ['approved','rejected','unknown','dao']) {
      if (process.env.SCENARIO && process.env.SCENARIO !== scenario) continue;
      const { page, errors, writes, treasury, dao, name } = await openOwnerStatus(browser, root, scenario, width);
      try {
        await page.goto(`http://frontend.test/a/${name}/${treasury?'':'follow/payment?payment=payment'}`);
        for (let visit=0;visit<2;visit++) {
          if (visit) await page.reload();
          
            await page.getByText(scenario==='rejected'?'Provider reported failed':'Paid',{exact:true}).first().waitFor();
            await page.getByText('Payment history and public visibility', { exact: true }).click();
            const title = scenario==='approved'?"Approved by the owner's wallet":scenario==='rejected'?"Rejected by the owner's wallet":scenario==='unknown'?'Owner wallet decision · unverified':'Proposal filed and voted';
            const stage = page.getByRole('heading',{name:new RegExp(`^${title.replaceAll("'", "['’]")}$`)}).locator('..');
            await stage.waitFor();
            if (['approved','rejected'].includes(scenario)) assert.doesNotMatch(await stage.innerText(),/No .*evidence|unverified/);
            if (scenario==='unknown') assert.match(await stage.innerText(),/No .*evidence/);
            if (dao) assert.match(await stage.innerText(),/Proposal #42: approved, 1 vote/);
            const completed = await stage.locator('..').locator('span.relative.bg-brand').count();
            assert.equal(completed,scenario==='unknown'?0:1,'Stage marker must agree with its evidence');
          
        }
        assert.deepEqual(errors,[]);
        assert.deepEqual(writes,[], 'Read-only review must never invoke an action');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        if (process.env.ARTIFACT_DIR) {
          fs.mkdirSync(process.env.ARTIFACT_DIR,{recursive:true});
          await page.screenshot({path:path.join(process.env.ARTIFACT_DIR,`${scenario}-${width}.png`),fullPage:true});
        }
        results.push({scenario,width,pass:true});
      } catch(e) { results.push({scenario,width,pass:false,error:e.message}); }
      await page.close();
    }
  console.log(JSON.stringify(results,null,2));
  assert.ok(results.length > 0 && results.every(r=>r.pass), "All scenarios must pass");
}

runTask([paymentQueue, paymentDetail, paymentRecovery, ownerDecisionEvidence]);
