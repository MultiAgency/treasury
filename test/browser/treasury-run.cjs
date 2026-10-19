/** The guided Treasury run on the default Treasury build. All traffic is intercepted; no executor or wallet starts. */
const assert = require('node:assert/strict');
const { runTask } = require('./fixtures/task.cjs');
const { openRun, planId, operationId } = require('./fixtures/guided-run.cjs');
const { expect } = require('@playwright/test');
/** Methods that save, sign or send. Entry, chapters and reload may call none of them. */
const SENDS = ['rebalance', 'executePlan', 'pay', 'sweep', 'owner/prepare', 'owner/submit', 'strategy/save', 'autopilot/enable', 'autopilot/set', 'autopilot/stop', 'recover'];
const planRecords = page => page.locator('section').filter({ has: page.getByRole('heading', { name: 'This plan’s operations', exact: true }) }).last();

async function entry(browser, root) {
  const open = (routePath, options) => openRun(browser, root, routePath, options);
  for (const width of [320, 1280]) {
    const { page, context, calls, writes, errors } = await open('/a/treasury/demo', { width });
    await page.getByRole('heading', { name: 'Run it with your treasury', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/a/treasury/demo', 'the Treasury build serves the run instead of redirecting');
    for (const step of ['Check this agent', 'Preview and execute a rebalance', 'Check the outcome'])
      await page.getByRole('heading', { name: step, exact: true }).waitFor();
    await page.getByText(/No plan selected\. Confirming execution selects/).waitFor();
    const reviews = page.getByRole('navigation', { name: 'Owner reviews' });
    assert.deepEqual(await reviews.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('href'))),
      ['/a/treasury/automations', '/a/treasury/policy', '/a/treasury/activity#owner-actions']);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}: the run fits`);
    await page.reload();
    await page.getByRole('heading', { name: 'Run it with your treasury', exact: true }).waitFor();
    assert.deepEqual(writes, [], 'entry, chapters and reload never preview, execute or sign');
    assert.ok(!calls.some(method => SENDS.includes(method)), `no send was called: ${calls.join(', ')}`);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${width}px: Treasury build serves /demo with its steps and owner-review links, without a send`);
  }
}

async function deepLinks(browser, root) {
  const open = (routePath, options) => openRun(browser, root, routePath, options);
  // Stable deep links for other apps (Proto's walkthrough chapters): each lands on its real control, in view, without a send.
  for (const [link, target] of [
    ['/a/treasury/demo#check', page => page.locator('#check')],
    ['/a/treasury/demo#preview', page => page.locator('#preview')],
    ['/a/treasury/demo#outcome', page => page.locator('#outcome')],
    [`/a/treasury/demo?plan=${planId}#outcome`, page => page.getByRole('region', { name: 'Confirmed plan outcome' })],
    ['/a/treasury/#rebalance', page => page.locator('#rebalance')],
    ['/a/treasury/automations', page => page.getByRole('heading', { name: 'Strategy', exact: true })],
    ['/a/treasury/policy#grants', page => page.locator('#grants')],
    ['/a/treasury/activity#owner-actions', page => page.locator('#owner-actions')],
  ]) {
    const { page, context, calls, writes, errors } = await open(link, { width: 1280 });
    const element = target(page);
    await element.waitFor();
    await expect(element).toBeInViewport();
    assert.deepEqual(writes, [], `${link} sends nothing`);
    assert.ok(!calls.some(method => SENDS.includes(method)), `${link} calls no send: ${calls.join(', ')}`);
    assert.deepEqual(errors, [], link);
    await context.close();
    console.log(`PASS deep link ${link}`);
  }
}

async function homeReopens(browser, root) {
  const open = (routePath, options) => openRun(browser, root, routePath, options);
  // Home also reopens a plan from its address; the run's `?plan=<id>#outcome` is the link that lands on it.
  const { page, context, writes, errors } = await open(`/a/treasury/?plan=${planId}`, { width: 1280 });
  await page.getByRole('region', { name: 'Confirmed plan outcome' }).waitFor();
  await page.getByText(/Following the exact plan named in this page’s address/).waitFor();
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS Home reopens a plan from its address without a send');
}

async function rebalance(browser, root) {
  const open = (routePath, options) => openRun(browser, root, routePath, options);
  const { page, context, writes, errors } = await open('/a/treasury/demo', { allowRebalance: true });
  const preview = page.getByRole('button', { name: 'Preview', exact: true });
  const execute = page.getByRole('button', { name: 'Execute', exact: true });
  await expect(preview).toBeEnabled();
  await expect(execute).toBeDisabled();
  await preview.click();
  await expect(execute).toBeEnabled();
  assert.deepEqual(writes.map(write => write.method), ['rebalance'], 'preview only saves a plan');
  await expect(page.getByText('Estimated received 1 NEAR · Minimum received 0.99 NEAR', { exact: true })).toBeVisible();
  await execute.click();
  const review = page.getByRole('dialog', { name: 'Execute the previewed rebalance on mainnet?', exact: true });
  await review.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(writes.length, 1, 'cancelling does not execute');
  assert.equal(await page.getByRole('heading', { name: 'This plan’s operations', exact: true }).count(), 0, 'cancelling selects no plan');
  await execute.click();
  await review.getByRole('button', { name: 'Execute swaps', exact: true }).click();
  await planRecords(page).locator(`#operation-${operationId}`).waitFor();
  await planRecords(page).locator('#operation-demo-shield-fixture').waitFor();
  assert.equal(await planRecords(page).locator('#operation-unrelated-operation').count(), 0, 'newer unrelated activity never becomes the selected outcome');
  assert.deepEqual(writes.map(write => write.method), ['rebalance', 'executePlan']);
  assert.deepEqual(writes[1].input, { planId }, 'execute exactly the reviewed saved plan');
  assert.equal(new URL(page.url()).searchParams.get('plan'), planId, 'the page address keeps the confirmed plan');
  await page.reload();
  await page.getByText(/Following the exact plan named in this page’s address/).waitFor();
  await planRecords(page).locator(`#operation-${operationId}`).waitFor();
  assert.equal(writes.length, 2, 'reopening the plan never replays it');
  await page.getByRole('button', { name: 'Stop following this plan', exact: true }).click();
  await page.getByText(/No plan selected\. Confirming execution selects/).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('plan'), null);
  assert.equal(writes.length, 2, 'stopping cancels and sends nothing');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS rebalance: preview, cancel, explicit execute of the exact plan, reopened from the address without replay');
}

async function interruptedAndRejected(browser, root) {
  const open = (routePath, options) => openRun(browser, root, routePath, options);
  for (const condition of ['interrupted', 'rejected']) {
    const { page, context, writes, errors } = await open('/a/treasury/demo', { allowRebalance: true, [condition]: true });
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Execute', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Execute', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Execute swaps', exact: true }).click();
    const records = planRecords(page);
    await records.waitFor();
    if (condition === 'interrupted') {
      await records.locator('#operation-demo-shield-fixture').waitFor();
      await records.getByText('unsettled', { exact: true }).waitFor();
    } else await records.getByText(/No operations for this plan are recorded here yet/).waitFor();
    assert.equal(await records.locator('#operation-unrelated-operation').count(), 0);
    assert.deepEqual(writes.map(write => write.method), ['rebalance', 'executePlan']);
    await page.reload();
    await page.getByText(/Following the exact plan named in this page’s address/).waitFor();
    assert.equal(writes.length, 2, 'reload reopens the same plan and never replays execution or guesses the latest plan');
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('PASS interrupted and rejected execution: exact retained records, no inferred completion, read-only reopen');
}

async function noLegs(browser, root) {
  const open = (routePath, options) => openRun(browser, root, routePath, options);
  const { page, context, writes } = await open('/a/treasury/demo', { allowRebalance: true, noLegs: true });
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByText('No swaps are needed at the current targets and minimum swap size.', { exact: true }).waitFor();
  await expect(page.getByRole('button', { name: 'Execute', exact: true })).toBeDisabled();
  assert.equal(await page.getByRole('heading', { name: 'This plan’s operations', exact: true }).count(), 0);
  assert.deepEqual(writes.map(write => write.method), ['rebalance']);
  await context.close();
  console.log('PASS no-leg plan selects no outcome');
}

async function blockers(browser, root) {
  const open = (routePath, options) => openRun(browser, root, routePath, options);
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
}

async function failedRefresh(browser, root) {
  const open = (routePath, options) => openRun(browser, root, routePath, options);
  const { page, context, writes, errors, state } = await open('/a/treasury/demo');
  const preview = page.getByRole('button', { name: 'Preview', exact: true });
  await expect(preview).toBeEnabled();
  state.error = 'overview';
  await page.getByRole('button', { name: 'Check observations', exact: true }).click();
  await page.getByText('Observations: Unavailable', { exact: true }).waitFor();
  await expect(preview).toBeDisabled();
  state.error = undefined;
  await page.getByRole('button', { name: 'Check observations', exact: true }).click();
  await expect(preview).toBeEnabled();
  assert.deepEqual(writes, [], 'refresh only reads observations');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS failed refresh never authorizes a new action; a successful refresh restores readiness');
}

async function confirmationInvalidated(browser, root) {
  const open = (routePath, options) => openRun(browser, root, routePath, options);
  const { page, context, writes, errors, state } = await open('/a/treasury/demo', { clock: true, allowRebalance: true });
  const preview = page.getByRole('button', { name: 'Preview', exact: true });
  await expect(preview).toBeEnabled();
  await preview.click();
  const execute = page.getByRole('button', { name: 'Execute', exact: true });
  await expect(execute).toBeEnabled();
  await execute.click();
  const review = page.getByRole('dialog', { name: 'Execute the previewed rebalance on mainnet?', exact: true });
  const confirm = review.getByRole('button', { name: 'Execute swaps', exact: true });
  await expect(confirm).toBeEnabled();
  state.unresolved = true;
  await page.clock.fastForward(5_100);
  await page.clock.runFor(100);
  await expect(confirm).toBeDisabled();
  assert.deepEqual(writes.map(write => write.method), ['rebalance'], 'new unresolved evidence invalidates an already open review');
  await review.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS changed observations invalidate an open swap confirmation');
}

runTask([entry, deepLinks, homeReopens, rebalance, interruptedAndRejected, noLegs, blockers, failedRefresh, confirmationInvalidated]);
