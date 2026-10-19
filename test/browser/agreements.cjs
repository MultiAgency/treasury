/** Offline task journeys. Run through test/browser/run.cjs to retain failure diagnostics. */
const { runTask } = require('./fixtures/task.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { workspaceEvidence, workspaceOpener } = require('./fixtures/workspace.cjs');

async function agreementTerms(browser, root) {
  const { budget, setup, overview } = workspaceEvidence();
  const open = workspaceOpener(root, { budget, proposals: true, values(kind, options, state, run) {
    const values = { get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup: { ...setup, ...(options.noGrant && { grant: null }), ...(options.approveOnly && { executor: false }) }, overview: overview(kind), 'treasury/get': null, held: options.held && kind === 'payables' ? [{ at: new Date().toISOString(), request: { amount: '1000000', asset: 'usdc', recipient: 'payee.near' }, kind: 'payout', correlationId: 'fixture-held-payment', approvalId: 'fixture-approval' }] : [], unresolved: options.unresolved && kind === 'payables' ? [{ kind: 'payout', at: new Date().toISOString(), key: 'fixture-unresolved', request: {}, status: null, sent: false }] : [],
      'inbox/list': [], 'agreements/list': options.agreements || (options.agreed ? [{ id: 'agreement-fixture', payee: 'payee.near', amount: '1000000', status: 'agreed', origin: 'owner', at: '2026-10-01T00:00:00Z', note: '' }] : []), activity: [], invoices: [], reconcileBooks: [], 'owner/pending': [], 'owner/actions': [], paymentHistory: { items: [], complete: true },
      'autopilot/get': { on: true, everyMin: 60, maxUsd: 10, lastRun: null, nextRun: null },
      'autopilot/evidence': { ticks: [run], corrupt: [] } };
    if (options.destinations) {
      values.overview.policy.policy.destinations = { mode: options.destinationMode || 'only', list: options.destinations };
      values.overview.agreed = options.destinationMode === 'except' ? [] : options.destinations.filter(d => d.confidential).map(d => d.address);
    }
    if (options.unmanaged) {
      values.overview.unmanaged = [{ asset: 'unmanaged', symbol: 'OTHER', amount: 1000000n, decimals: 6, usd: null, price: null, priceUpdatedAt: null, priceExpiresAt: null }];
      values.overview.policy.policy.assets = options.excluded ? ['usdc'] : 'any';
    }
    return values;
  } });
  const agreement = (id, status) => ({ id, status, payee: `${id}.near`, amount: '1000000', note: '', origin: 'payee', at: '2026-10-01T00:00:00Z',
    ...(status !== 'requested' && { terms: { maxAmount: '1000000', until: '2030-01-01T00:00:00Z' } }) });
  const agreements = [agreement('established', 'agreed'), agreement('request', 'requested'), agreement('unfinished', 'proposed'), agreement('closed', 'declined'),
    { ...agreement('second-request', 'requested'), payee: 'request.near', amount: '2000000', note: 'Second milestone' }, agreement('filed', 'filed')];
  const destinations = ['established.near', 'policy-only.near', 'public.near'].map(address => ({ action: 'transfer', address, confidential: address !== 'public.near' }));
  {
    const width = 390;
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const { page, calls, errors } = await open(context, '/a/payables/payees', { agreements, destinations });
    const requested = page.getByRole('article', { name: 'Recipient request.near', exact: true });
    await requested.waitFor();
    assert.equal(await requested.getByRole('button', { name: 'Agree to these terms', exact: true }).count(), 2, 'multiple terms for one recipient remain independently reviewable');
    assert.ok(await requested.getByText('Second milestone', { exact: false }).isVisible());
    assert.ok(await requested.getByText('Not listed', { exact: true }).isVisible());
    const established = page.getByRole('article', { name: 'Recipient established.near', exact: true });
    assert.ok(await established.getByText('Agreed, invoice not filed yet', { exact: true }).isVisible());
    assert.ok(await established.getByText('Confidential transfer listed', { exact: true }).isVisible());
    const policyOnly = page.getByRole('article', { name: 'Recipient policy-only.near', exact: true });
    assert.ok(await policyOnly.getByText('No open agreement terms recorded for this recipient.', { exact: true }).isVisible());
    assert.ok(await policyOnly.getByText('Confidential transfer listed', { exact: true }).isVisible());
    assert.ok(await page.getByRole('article', { name: 'Recipient public.near', exact: true }).getByText('Public transfer only', { exact: true }).isVisible());
    const recipients = await page.getByRole('article').evaluateAll(articles => articles.map(article => article.getAttribute('aria-label')));
    assert.deepEqual(recipients, ['Recipient request.near', 'Recipient unfinished.near', 'Recipient established.near', 'Recipient policy-only.near', 'Recipient public.near']);
    assert.ok(await page.getByRole('button', { name: 'Continue policy approval', exact: true }).isVisible());
    assert.ok(!await policyOnly.getByRole('button', { name: 'Remove policy-only.near from policy', exact: true }).isVisible());
    await policyOnly.getByText('Policy-only controls', { exact: true }).click();
    assert.ok(await policyOnly.getByRole('button', { name: 'Remove policy-only.near from policy', exact: true }).isVisible());
    await page.getByText('Filed or declined (2)', { exact: true }).click();
    assert.ok(await page.getByText('closed.near · 1 USDC · Declined', { exact: false }).isVisible());
    assert.ok(await page.getByText('filed.near · 1 USDC · Invoice filed', { exact: false }).isVisible());
    assert.ok(!await page.locator('input[name="offer-payee"]').isVisible(), 'new offer form opens only on demand');
    await page.getByText('Offer terms (a purchase order, a bounty or grant award)', { exact: true }).click();
    await page.locator('input[name="offer-payee"]').fill('draft.near');
    // Background refresh must not close or erase an owner’s draft.
    await page.waitForTimeout(5500);
    assert.equal(await page.locator('input[name="offer-payee"]').inputValue(), 'draft.near');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}: overflow`);
    assert.ok(!calls.some(call => /offer|propose|prepare|decline/.test(call)));
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `/tmp/home-agreements-${width}.png`, fullPage: true });
    await context.close();
    console.log(`PASS recipient terms and independent policy status, draft retention, no mutations at ${width}px`);
  }
  {
    const context = await browser.newContext();
    const { page, calls } = await open(context, '/a/payables/payees', { agreements: [agreement('established', 'agreed')], destinations, destinationMode: 'except' });
    const recipient = page.getByRole('article', { name: 'Recipient established.near', exact: true });
    await recipient.getByText('Blocked by policy', { exact: true }).waitFor();
    assert.ok(await recipient.getByText('Agreed, invoice not filed yet', { exact: true }).isVisible(), 'terms history remains separate from the block-list policy');
    await recipient.getByText('Policy-only controls', { exact: true }).click();
    assert.ok(await recipient.getByRole('button', { name: 'Remove established.near from policy', exact: true }).isDisabled());
    assert.equal(await page.getByText('Add a payee without agreement terms', { exact: true }).count(), 0, 'block-list policies cannot be replaced by direct payee editing');
    assert.ok(!calls.some(call => /offer|propose|prepare|decline/.test(call)));
    await context.close();
    console.log('PASS recorded terms do not override block-list destination status');
  }
  {
    const context = await browser.newContext();
    const { page, calls } = await open(context, '/', { agreements, unresolved: true, dao: true, proposals: [
      { id: 42, what: 'past', status: 'Approved', proposer: 'owner.near', submittedAt: '2026-10-01T00:00:00Z', description: 'Completed fixture proposal' },
      { id: 43, what: 'past', status: 'InProgress', proposer: 'owner.near', submittedAt: '2026-10-01T00:00:00Z', description: 'Open fixture proposal' },
    ] });
    await page.getByText(/1 money action has no proven outcome/).waitFor();
    await page.getByRole('link', { name: 'Review agreement requests' }).first().waitFor();
    assert.equal(await page.getByRole('link', { name: 'Continue agreement setup' }).first().getAttribute('href'), '/a/treasury/payees');
    assert.ok(!await page.getByText('Completed fixture proposal', { exact: true }).isVisible());
    const attention = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Needs attention', exact: true }) });
    const rows = await attention.locator('li').allTextContents();
    assert.ok(rows.findIndex(text => text.includes('no proven outcome')) < rows.findIndex(text => text.includes('agreement request')), 'unresolved operations precede agreement requests');
    const proposal = attention.getByText('Open fixture proposal', { exact: true });
    await proposal.waitFor();
    assert.ok((await proposal.boundingBox()).y < (await page.getByRole('heading', { name: 'Current status', exact: true }).boundingBox()).y, 'voting decisions remain in attention before routine status');
    await page.goto('http://frontend.test/#activity');
    await page.getByText('Recent completed proposals (1)', { exact: true }).click();
    assert.ok(await page.getByText('Completed fixture proposal', { exact: true }).isVisible());
    assert.ok(!calls.some(call => /offer|propose|prepare|decline/.test(call)));
    await context.close();
    console.log('PASS Home prioritizes unresolved operations and voting decisions');
  }
  for (const source of ['agreements/list', 'inbox/list']) {
    const context = await browser.newContext();
    const { page, errors } = await open(context, '/', { error: source, unresolved: true });
    await page.getByText(/checks are incomplete/).first().waitFor();
    await page.getByText(/1 money action has no proven outcome/).waitFor();
    await page.getByText('Policy in force', { exact: true }).first().waitFor();
    await page.getByText('Autopilot to $10', { exact: true }).waitFor();
    assert.equal(await page.getByText('No decisions or exceptions in the records checked.', { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${source} failure retains known attention and independent status`);
  }
}

async function agreementPresentation(browser, root) {
  const { budget, setup, overview } = workspaceEvidence();
  const results = [];
  const filter = process.env.CASE_FILTER;
  async function check(name, work) {
    if (filter && !name.includes(filter)) return;
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' });
    try { await work(context); results.push({ name, pass: true }); }
    catch (error) { results.push({ name, pass: false, error: error.message }); }
    finally { await context.close(); }
  }
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
  const width = 390;
  await check(`agreements keep direct policy setup secondary at ${width}px`, async context => {
    const { page, calls } = await open(context, '/a/payables/payees');
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('heading', { name: 'Agreements', exact: true }).waitFor();
    assert.ok(!await page.locator('input[name="offer-payee"]').isVisible(), 'new offers remain secondary even without waiting requests');
    assert.ok(!await page.locator('input[name="payee"]').isVisible());
    const offer = page.getByText('Offer terms (a purchase order, a bounty or grant award)', { exact: true });
    await offer.focus(); await page.keyboard.press('Enter');
    assert.ok(await page.locator('input[name="offer-payee"]').isVisible());
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `agreements-${width}.png`), fullPage: true });
    const disclosure = page.getByText('Add a payee without agreement terms', { exact: true });
    await disclosure.focus(); await page.keyboard.press('Enter');
    assert.ok(await page.locator('input[name="payee"]').isVisible());
    assert.ok(await page.getByText('This updates the policy only. Offer terms above to record an amount ceiling and deadline.').isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(!calls.some(call => /offer|propose|prepare|execute/.test(call)));
  });
  for (const state of ['configured', 'missing', 'unavailable']) {
    await check(`agreed payee with ${state} invoice link`, async context => {
      const { page, errors } = await open(context, '/a/payables/payees', {
        agreed: true, noInvoiceLink: state === 'missing', invoiceLinkError: state === 'unavailable', clock: state === 'unavailable',
      });
      await page.getByText('Agreed, invoice not filed yet', { exact: true }).waitFor();
      assert.ok(await page.getByRole('article', { name: 'Recipient payee.near', exact: true }).getByText('Not listed', { exact: true }).isVisible(), 'an agreed terms record does not imply the current policy lists the recipient');
      if (state === 'configured') assert.equal(await page.getByRole('link', { name: 'Open invoice page', exact: true }).count(), 1);
      else if (state === 'missing') await page.getByText("This agent's invoice page address is not configured here.", { exact: true }).waitFor();
      else {
        // The link shares the gateway query. Remount it after that observation becomes stale.
        await page.clock.fastForward(61_000);
        await page.getByRole('navigation', { name: 'Area utilities', exact: true }).getByRole('link', { name: 'Balances & funding', exact: true }).click();
        await page.getByRole('heading', { name: 'Balances', exact: true }).waitFor();
        await page.goBack();
        await page.getByText('Invoice link unavailable', { exact: true }).waitFor();
        assert.equal(await page.getByRole('link', { name: 'Open invoice page', exact: true }).count(), 0, 'failed refresh hides the retained intake link');
      }
      assert.equal(await page.getByText(/Share the invoice page above/).count(), 0);
      assert.deepEqual(errors, []);
    });
  }
  console.log(JSON.stringify(results, null, 2));
  if (!results.length || results.some(result => !result.pass)) process.exitCode = 1;
}

runTask([agreementTerms, agreementPresentation]);
