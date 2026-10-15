/** Offline task journeys. Run through test/browser/run.cjs to retain failure diagnostics. */
const { runTask } = require('./fixtures/task.cjs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { html, script } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  'import { invoicePage, invoiceBrowser } from "./src/invoice-page.ts"; console.log(JSON.stringify({html:invoicePage("Invoice fixture"),script:invoiceBrowser}));'], { encoding: 'utf8' }));
const { assertResponsive } = require('./fixtures/layout.cjs');

async function fileInvoice(browser, root) {
  {
    const width = 390;
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(8000);
    let agreements = [], invoices = [], agreed = false, unavailable = false;
    const writes = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()), p = url.pathname;
      if (url.hostname === 'cdn.jsdelivr.net') return route.fulfill({ contentType: 'text/javascript', body: `export class NearConnector {
        async connect() {} async disconnect() {} async getConnectedWallet() { return { wallet: { signMessage: async () => ({ accountId: 'synthetic-payee.near', publicKey: 'fixture', signature: 'fixture' }) } }; }
      }` });
      if (url.hostname !== 'invoice.test') return route.abort();
      if (p === '/') return route.fulfill({ contentType: 'text/html', body: html });
      if (p === '/invoice-browser.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (p === '/api/session') return route.fulfill({ json: { account: null, agreed: false } });
      if (route.request().method() === 'POST') writes.push({ path: p, body: route.request().postDataJSON() });
      if (p === '/api/signin/challenge') return route.fulfill({ json: { nonce: 'AAAA', message: 'Offline sign-in', recipient: 'invoice.test' } });
      if (p === '/api/signin') return route.fulfill({ json: { account: 'synthetic-payee.near', agreed } });
      if (p === '/api/invoices' && route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        if (!agreed) {
          agreements = [{ id: 'agreement', origin: 'payee', status: 'requested', amount: '1250000', note: body.note, submission: body.submission, at: new Date().toISOString() }];
          return route.fulfill({ json: { status: 'requested' } });
        }
        invoices = [{ id: 'invoice', status: 'waiting', amount: '1250000', note: body.note, filedAt: new Date().toISOString() }];
        agreements = [];
        return route.fulfill({ json: { status: 'waiting' } });
      }
      if (p === '/api/invoices') return route.fulfill(unavailable ? { status: 503, json: {} } : { json: { agreements, invoices, agreed } });
      throw new Error('Unexpected fixture request: ' + p);
    });
    await page.goto('https://invoice.test/');
    await page.getByRole('button', { name: 'Sign in with NEAR' }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Send request', exact: true }).waitFor();
    await page.getByLabel('Amount (USDC)').fill('1.25');
    await page.getByLabel("What's it for? (optional)").fill('Synthetic work');
    await page.getByRole('button', { name: 'Send request', exact: true }).click();
    await page.getByText(/Waiting for the DAO to agree/).waitFor();
    const original = writes.find(w => w.path === '/api/invoices').body.submission;
    const refresh = () => page.getByRole('button', { name: 'Check invoice status again' }).click();
    agreements[0].status = 'proposed'; await refresh();
    await page.getByText(/DAO still needs to approve the policy/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'File this invoice' }).count(), 0);
    agreements[0].status = 'agreed'; agreed = true; await refresh();
    await page.getByRole('button', { name: 'File this invoice' }).click();
    await page.getByText(/Waiting for approval/).waitFor();
    assert.equal(writes.filter(w => w.path === '/api/invoices')[1].body.submission, original);
    for (const [status, text] of [['paying', /Settlement is not yet confirmed/], ['unknown', /do not create a replacement invoice/], ['refused', /nothing was sent for this invoice/], ['paid', /^Paid\.$/]]) {
      invoices[0].status = status; await refresh(); await page.getByText(text).waitFor();
    }
    unavailable = true; await refresh(); await page.getByText(/Invoice status could not be checked/).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await assertResponsive(page, "invoice-journey");
    assert.deepEqual(errors, []);
    assert.deepEqual(writes.map(w => w.path), ['/api/signin/challenge', '/api/signin', '/api/invoices', '/api/invoices']);
    console.log(`PASS payee journey ${width}: synthetic sign-in, request, owner decision observations, stable invoice identity, held payout, processing, unresolved, refusal, paid, unavailable read`);
    await page.close();
  }
}

async function invoiceDraftsAndRefresh(browser, root) {
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  await page.clock.install();
  const errors = [], submissions = [];
  page.on('pageerror', error => errors.push(error.message));
  let records = [{ id: 'fixture', status: 'unknown', amount: '1000000', filedAt: '2026-01-01T00:00:00Z' }];
  let agreements = [], agreed = false, unavailable = false, defer = false;
  const queued = [];
  const response = (status = 'paid') => ({ invoices: [{ ...records[0], id: 'fixture', status, amount: '1000000', filedAt: '2026-01-01T00:00:00Z' }], agreements: [], agreed: true });
  let sessionReads = 0;
  let pendingSubmission, holdSubmission = false;
  await page.addInitScript(() => localStorage.setItem('invoice-draft:payee.near', JSON.stringify({ amount: '7.50', note: 'Saved work', submission: 'original-id' })));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'cdn.jsdelivr.net') return route.fulfill({ contentType: 'text/javascript', body: 'export class NearConnector { async disconnect() {} async connect() {} async getConnectedWallet() { return {wallet:{signMessage:async()=>({accountId:"bob.near",publicKey:"mock",signature:"mock"})}}; }}' });
    if (url.hostname !== 'invoice.test') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/invoice-browser.js') return route.fulfill({ contentType: 'text/javascript', body: script });
    if (url.pathname === '/api/signout') return route.fulfill({ json: {} });
    if (url.pathname === '/api/signin/challenge') return route.fulfill({ json: { message: 'mock', recipient: 'mock', nonce: Buffer.alloc(32).toString('base64') } });
    if (url.pathname === '/api/signin') return route.fulfill({ json: { account: 'bob.near', agreed: true } });
    if (url.pathname === '/api/session') { sessionReads++; return route.fulfill({ json: { account: 'payee.near', agreed } }); }
    if (url.pathname === '/api/invoices' && route.request().method() === 'POST') {
      submissions.push(route.request().postDataJSON());
      if (holdSubmission) { pendingSubmission = route; return; }
      return route.fulfill({ json: { status: 'failed' } });
    }
    if (url.pathname === '/api/invoices') {
      if (defer) { queued.push(route); return; }
      if (unavailable) return route.fulfill({ status: 503, json: {} });
      return route.fulfill({ json: { invoices: records, agreements, agreed } });
    }
    throw new Error('Unexpected invoice request: ' + url.pathname);
  });
  await page.goto('https://invoice.test/');
  const refresh = () => page.evaluate(() => document.getElementById('refresh').onclick());
  await page.getByText(/Last checked/).waitFor();
  await page.getByRole('button', { name: 'Send request', exact: true }).waitFor();
  agreed = true;
  await refresh();
  await page.getByRole('button', { name: 'Submit invoice', exact: true }).waitFor();
  assert.equal(await page.locator('#amount').inputValue(), '7.50');
  assert.equal(await page.locator('#note').inputValue(), 'Saved work');
  assert.equal(sessionReads, 1);
  await page.locator('#submit').click();
  await page.getByText(/This alone does not establish/).waitFor();
  await page.waitForFunction(() => !document.getElementById('submit').disabled);
  await page.locator('#submit').click();
  await page.waitForFunction(() => !document.getElementById('submit').disabled);
  assert.equal(submissions.length, 2);
  assert.deepEqual(submissions.map(item => item.submission), ['original-id', 'original-id']);
  assert.equal(await page.locator('#amount').inputValue(), '7.50');
  const copy = page.getByRole('button', { name: 'Copy review reference' });
  await copy.focus();
  await page.evaluate(() => { window.focused = document.activeElement; });
  await refresh();
  assert.equal(await page.evaluate(() => focused === document.activeElement), true);
  records[0] = { ...records[0], status: 'needs_review', note: 'Updated evidence' };
  await refresh();
  assert.equal(await page.evaluate(() => focused === document.activeElement), true);
  assert.match(await page.locator('#invoices').innerText(), /Updated evidence/);
  records[0].status = 'paid';
  await refresh();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'refresh');
  assert.equal(await copy.count(), 0);
  records = [];
  await refresh();
  assert.equal(await page.locator('#invoices li').count(), 0);
  agreements = [{ id: 'agreement', status: 'agreed', origin: 'owner', amount: '1000000', terms: { maxAmount: '2000000', until: '2030-01-01T00:00:00Z' }, note: 'First', at: '2026-01-01T00:00:00Z' }];
  await refresh();
  await page.getByRole('button', { name: 'Use these terms' }).focus();
  await page.evaluate(() => { window.agreementButton = document.activeElement; });
  agreements[0].note = 'Updated';
  await refresh();
  assert.equal(await page.evaluate(() => agreementButton === document.activeElement), true);
  await page.getByRole('button', { name: 'Use these terms' }).click();
  assert.equal(await page.locator('#note').inputValue(), 'Updated');
  assert.equal(await page.locator('#amount').inputValue(), '2');
  unavailable = true;
  await refresh();
  assert.match(await page.locator('#refresh-error').innerText(), /could not be checked/);
  assert.equal(await page.locator('#amount').inputValue(), '2');
  unavailable = false;
  const retried = page.waitForResponse(r => new URL(r.url()).pathname === '/api/invoices');
  await page.clock.fastForward(15000);
  await retried;
  await page.waitForFunction(() => document.getElementById('refresh-error').textContent === '');
  defer = true;
  async function begin(slot) {
    const requested = page.waitForRequest(r => new URL(r.url()).pathname === '/api/invoices');
    await page.evaluate(slot => { window[slot] = document.getElementById('refresh').onclick(); }, slot);
    await requested;
    while (!queued.length) await new Promise(resolve => setImmediate(resolve));
    return queued.shift();
  }
  for (const olderFails of [false, true]) {
    const old = await begin('oldRead'), latest = await begin('newRead');
    await latest.fulfill({ json: response() }); await page.evaluate(() => newRead);
    await old.fulfill(olderFails ? { status: 503, json: {} } : { json: response('prepared') }); await page.evaluate(() => oldRead);
    assert.match(await page.locator('#invoices').innerText(), /Paid/);
    assert.equal(await page.getByRole('button', { name: 'Continue this prepared invoice' }).count(), 0);
    assert.equal(await page.locator('#refresh-error').innerText(), '');
  }
  const old = await begin('oldRead'), latest = await begin('newRead');
  await latest.fulfill({ status: 503, json: {} });
  await page.evaluate(() => newRead);
  await old.fulfill({ json: response('prepared') });
  await page.evaluate(() => oldRead);
  assert.match(await page.locator('#invoices').innerText(), /Paid/);
  assert.match(await page.locator('#refresh-error').innerText(), /could not be checked/);
  holdSubmission = true;
  await page.locator('#amount').fill('3');
  await page.evaluate(() => { window.oldSubmit = document.getElementById('submit').onclick(); });
  while (!pendingSubmission) await new Promise(resolve => setImmediate(resolve));
  const oldSessionRead = await begin('oldSessionRead');
  await page.locator('#signout').click();
  await page.locator('#signin').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'signin', 'sign-out restores a visible keyboard target');
  assert.equal(await page.locator('#agreements-card').isVisible(), false);
  assert.equal(await page.locator('#agreements li').count(), 0);
  assert.equal(await page.locator('#invoices li').count(), 0);
  await oldSessionRead.fulfill({ json: response('unknown') });
  await page.evaluate(() => oldSessionRead);
  const readsBefore = queued.length;
  await page.clock.fastForward(30000);
  assert.equal(queued.length, readsBefore, 'signed-out polling must stop');
  await page.evaluate(() => localStorage.setItem('invoice-draft:bob.near', JSON.stringify({ amount: '9', note: 'Bob draft', submission: 'bob-id' })));
  await page.locator('#signin').click();
  await page.waitForFunction(() => document.getElementById('account').textContent === 'bob.near');
  assert.equal(await page.locator('#invoices li').count(), 0);
  assert.equal(await page.locator('#agreements li').count(), 0);
  await pendingSubmission.fulfill({ json: { status: 'paid' } });
  await page.evaluate(() => oldSubmit);
  assert.equal(await page.locator('#amount').inputValue(), '9');
  assert.equal(await page.locator('#note').inputValue(), 'Bob draft');
  assert.equal(await page.locator('#refresh-status').innerText(), '');
  assert.equal(await page.locator('#error').isVisible(), false);
  while (!queued.length) await new Promise(resolve => setImmediate(resolve));
  await queued.shift().fulfill({ json: { invoices: [], agreements: [], agreed: true } });
  await page.getByText(/Last checked/).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS invoice page: module loading, eligibility, drafts, focus, failure recovery, submission identity, overlapping refreshes, session isolation');
}

async function invoiceSessionExpiry(browser, root) {
  for (const status of [401, 403]) for (const method of ['GET', 'POST']) {
    const page = await browser.newPage(); page.setDefaultTimeout(5000); await page.clock.install();
    let expired = false;
    let nextAccount = 'payee.near', holdSubmission = false, pendingSubmission;
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('invoice-draft:payee.near', JSON.stringify({ amount: '7.50', note: 'Private draft', submission: 'original-id' })));
    await page.route('**/*', async route => {
      const { hostname, pathname: p } = new URL(route.request().url());
      if (hostname === 'cdn.jsdelivr.net') return route.fulfill({ contentType: 'text/javascript', body:
        'export class NearConnector { async disconnect() {} async connect() {} async getConnectedWallet() { return {wallet:{signMessage:async()=>({accountId:"payee.near",publicKey:"mock",signature:"mock"})}}; }}' });
      if (hostname !== 'invoice.test') return route.abort();
      if (p === '/') return route.fulfill({ contentType: 'text/html', body: html });
      if (p === '/invoice-browser.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (p === '/api/session') return route.fulfill({ json: { account: 'payee.near', agreed: true } });
      if (route.request().method() === 'POST') writes.push(p);
      if (p === '/api/invoices' && route.request().method() === 'POST' && holdSubmission) { pendingSubmission = route; return; }
      if (p === '/api/signout') return route.fulfill({ json: {} });
      if (p === '/api/signin/challenge') return route.fulfill({ json: { message: 'mock', recipient: 'mock', nonce: Buffer.alloc(32).toString('base64') } });
      if (p === '/api/signin') { expired = false; return route.fulfill({ json: { account: nextAccount, agreed: true } }); }
      if (p === '/api/invoices') return route.fulfill(expired ? { status, contentType: 'text/html', body: 'Sign in again' } : {
        json: { invoices: [{ id: 'private-invoice', status: 'unknown', amount: '1000000', note: 'Private invoice', filedAt: '2026-01-01T00:00:00Z' }], agreements: [], agreed: true } });
      throw new Error('Unexpected invoice request: ' + p);
    });
    await page.goto('https://invoice.test/');
    await page.getByText(/Private invoice/).waitFor();
    expired = true;
    await page.getByRole('button', { name: method === 'GET' ? 'Check invoice status again' : 'Submit invoice', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in with NEAR' }).waitFor();
    assert.equal(await page.getByText(/Private invoice/).count(), 0);
    assert.equal(await page.locator('#amount').isVisible(), false);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('invoice-draft:payee.near')).submission), 'original-id');
    await page.getByRole('button', { name: 'Sign in with NEAR' }).click();
    await page.getByRole('button', { name: 'Submit invoice', exact: true }).waitFor();
    assert.equal(await page.locator('#amount').inputValue(), '7.50');
    assert.equal(await page.locator('#note').inputValue(), 'Private draft');
    await page.getByText(/This form retains a previous submission/).waitFor();
    assert.deepEqual(writes, [...(method === 'POST' ? ['/api/invoices'] : []), '/api/signin/challenge', '/api/signin']);
    if (method === 'POST') {
      holdSubmission = true;
      const started = page.waitForRequest(request => new URL(request.url()).pathname === '/api/invoices' && request.method() === 'POST');
      await page.getByRole('button', { name: 'Submit invoice', exact: true }).click(); await started;
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      nextAccount = 'other.near';
      await page.getByRole('button', { name: 'Sign in with NEAR' }).click();
      await page.getByText('other.near', { exact: true }).waitFor();
      await page.locator('#amount').fill('2.00'); await page.locator('#note').fill('Other private draft');
      const late = page.waitForResponse(response => new URL(response.url()).pathname === '/api/invoices' && response.request().method() === 'POST');
      await pendingSubmission.fulfill({ status, contentType: 'text/html', body: 'Old session denied' }); await late;
      await page.clock.runFor(100);
      assert.equal(await page.getByText('other.near', { exact: true }).isVisible(), true, 'a late denial cannot expire a newer account session');
      assert.equal(await page.locator('#amount').inputValue(), '2.00');
      assert.equal(await page.locator('#note').inputValue(), 'Other private draft');
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('invoice-draft:payee.near')).submission), 'original-id');
    }
    assert.deepEqual(errors, []);
    await page.close(); console.log(`PASS ${method} HTTP${status} removes invoice presentation and reauthentication preserves submission identity`);
  }
}

runTask([fileInvoice, invoiceDraftsAndRefresh, invoiceSessionExpiry]);
