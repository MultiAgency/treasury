/** Offline guided-run regressions for the shared build: Home entries and the payout agent's run. The Treasury run is tested on the Treasury build (treasury-run.cjs). */
const assert = require('node:assert/strict');
const { runSuite } = require('./fixtures/task.cjs');
const path = require('node:path');
const { chromium } = require('./fixtures/browser.cjs');
const { openRun, digest, paymentId, payment } = require('./fixtures/guided-run.cjs');
const { openWorkspaceNavigation } = require('./fixtures/navigation.cjs');
const { expect } = require('@playwright/test');
const root = path.resolve(process.argv[2] || 'web/dist');

runSuite(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    const open = (routePath, options) => openRun(browser, root, routePath, options);

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
      await page.getByRole('heading', { name: 'Run it with your treasury', exact: true }).waitFor();
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
      await page.getByRole('heading', { name: 'Run it with your treasury', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(writes, [], 'entry and reload must not preview, execute, send, or approve');
      assert.deepEqual(errors, []);
      if (process.env.PROTO_BROWSER_ARTIFACTS) await page.screenshot({ path: `/tmp/live-demo-treasury-${width}.png`, fullPage: true });
      await context.close();
      console.log(`PASS ${width}px: per-agent Home entry, selected walkthrough navigation, reload and no mutation`);
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
    console.log('PASS payment refusal does not manufacture an outcome selection');

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

    {
      const { page, context, writes, errors, state } = await open('/a/payables/demo');
      const action = page.getByRole('button', { name: 'Review payment', exact: true });
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

    {
      const { page, context, writes, errors, state } = await open('/a/payables/demo', { clock: true });
      const reviewButton = page.getByRole('button', { name: 'Review payment', exact: true });
      await expect(reviewButton).toBeEnabled();
      await page.getByLabel('Recipient’s NEAR account', { exact: true }).fill(payment.recipient);
      await page.getByLabel('Amount', { exact: true }).fill('1');
      await reviewButton.click();
      const review = page.getByRole('dialog', { name: 'Review payment', exact: true });
      const confirm = review.getByRole('button', { name: 'Send payment', exact: true });
      await expect(confirm).toBeEnabled();
      state.unresolved = true;
      await page.clock.fastForward(5_100);
      await page.clock.runFor(100);
      await expect(confirm).toBeDisabled();
      assert.deepEqual(writes, [], 'new unresolved evidence invalidates an already open review');
      await review.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('PASS changed observations invalidate an open payment confirmation');

  } finally { await browser.close(); }
});
