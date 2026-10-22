// Loads the embed build (`pnpm build:embed`) into a host app on another origin and checks embedded mode:
// Treasury mounts in the host's container with the agent and account the host names, shows no standalone
// header, footer or sign-in, keeps navigation inside itself, never moves the host page, trusts the gateway
// over the host's claim about the account, and starts no money action by itself.
// Offline: the host serves a fixture gateway and fixture agent answers (checked against the published owner contract).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginModuleFederation } from '@module-federation/rsbuild-plugin';
import { chromium } from '@playwright/test';
import { createRsbuild } from '@rsbuild/core';

const require = createRequire(import.meta.url);

const dist = fileURLToPath(new URL('../web/dist-embed/', import.meta.url));
if (!existsSync(join(dist, 'remoteEntry.js'))) throw new Error('web/dist-embed is missing: run pnpm build:embed first');

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.html': 'text/html', '.woff2': 'font/woff2' };
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const OWNER = 'owner.near';

// The remote: static files, served cross-origin.
const remote = createServer((request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(dist, path);
  if (!file.startsWith(dist) || !existsSync(file) || path.endsWith('/')) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'access-control-allow-origin': '*' });
  response.end(readFileSync(file));
});
const remotePort = await listen(remote);

// The host: a Module Federation app built the way a real one is, loading `treasury/mount`.
const work = mkdtempSync(join(tmpdir(), 'treasury-embed-host-'));
writeFileSync(join(work, 'index.html'), '<!doctype html><html lang="en"><head><title>Host</title></head><body><header id="host-header">Host app</header><div id="slot"></div></body></html>');
writeFileSync(join(work, 'host.js'), `
const query = new URLSearchParams(location.search);
window.hostReady = import('treasury/mount')
  .then(({ mount }) => mount(document.getElementById('slot'), { agent: query.get('agent'), account: query.get('account') }))
  .then(embedded => { window.embedded = embedded; })
  .catch(error => { window.mountError = error.message; });
`);
const builder = await createRsbuild({ cwd: work, config: {
  plugins: [pluginModuleFederation({ name: 'host', dts: false, remotes: { treasury: `treasury@http://127.0.0.1:${remotePort}/remoteEntry.js` } })],
  source: { entry: { index: join(work, 'host.js') } },
  html: { template: join(work, 'index.html') },
  output: { distPath: { root: join(work, 'dist') } },
  performance: { printFileSize: false },
} });
await builder.build();
const hostDist = join(work, 'dist');

// Loaded after the host is built: the host's own bundle must not depend on what the test loads.
const { mayCall, ownerCapabilities } = await import('@multiagency/sdk');
const { rpcBody } = require('../test/browser/fixtures/rpc.cjs');
const { workspaceEvidence } = require('../test/browser/fixtures/workspace.cjs');
/** Every owner procedure an account without any authority may not call: what sends, saves or signs. */
const NO_AUTHORITY = { canSign: false, canPropose: false, canVote: false, canExecute: false, canManage: false };
const SENDS = new Set(Object.values(ownerCapabilities).flatMap(capability => capability.procedures).filter(procedure => !mayCall(NO_AUTHORITY, procedure)));

// The fixture agent: what the treasury desk reads, as in test/browser/treasury-scope.cjs.
const { budget, setup, overview } = workspaceEvidence();
const book = overview('treasury');
book.book[0].priceUpdatedAt = new Date().toISOString();
const values = { setup: { ...setup, executor: true }, instance: { agentId: setup.agentId, executor: true }, overview: book, 'treasury/get': null,
  unresolved: [], held: [], activity: [], 'owner/actions': [], 'autopilot/get': { on: false, everyMin: 60, maxUsd: 10, lastRun: null, nextRun: null } };
void budget;


// The host also serves the gateway and the agent, as a same-origin deployment would.
const gateway = { down: false, viewer: null, calls: [], unexpected: [] };
const signedIn = account => ({ account, access: { treasury: { canSign: true, canPropose: true, canVote: true, canExecute: true, canManage: true } } });
const host = createServer((request, response) => {
  const { pathname } = new URL(request.url, 'http://x');
  const json = (status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (pathname === '/gw/me') return gateway.down ? json(503, { error: 'Gateway down' }) : json(200, { agents: [{ name: 'treasury', owner: OWNER, dao: false }], invoices: null, selfServiceTreasury: true, viewer: gateway.viewer });
  if (pathname.startsWith('/a/treasury/rpc/')) {
    const method = pathname.split('/rpc/')[1];
    gateway.calls.push(method);
    try { return json(200, rpcBody(values, method)); } catch (error) { gateway.unexpected.push(error.message); return json(500, { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Fixture' } }); }
  }
  const file = join(hostDist, pathname === '/' ? 'index.html' : normalize(pathname));
  if (pathname.startsWith('/gw/') || pathname.startsWith('/a/') || !file.startsWith(hostDist) || !existsSync(file)) return json(404, {});
  response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
const hostPort = await listen(host);

const executablePath = process.env.BROWSER_EXECUTABLE
  ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const browser = await chromium.launch({ headless: true, executablePath });
let failed = true;

/** A fresh host page; `viewer` is who the gateway says is signed in, `account` who the host says. */
async function open({ viewer, account = OWNER, agent = 'treasury', down = false }) {
  Object.assign(gateway, { viewer, down, calls: [], unexpected: [] });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const address = `http://127.0.0.1:${hostPort}/?agent=${agent}&account=${account}`;
  await page.goto(address);
  await page.evaluate(() => window.hostReady);
  return { context, page, errors, address, slot: page.locator('#slot') };
}
const hostUntouched = async ({ page, address }) => {
  assert.equal(page.url(), address, 'the host page address never changes');
  assert.equal(await page.title(), 'Host', 'the host keeps its page title');
  assert.equal(await page.locator('#host-header').innerText(), 'Host app', 'the host keeps its own header');
  assert.equal(await page.evaluate(() => document.documentElement.className), '', 'the embed does not change the host document theme');
};

try {
  // 1. The host's account is the gateway's: Treasury shows its desk without its own header, footer or sign-in.
  {
    const view = await open({ viewer: signedIn(OWNER) });
    const { slot, page } = view;
    await slot.getByRole('heading', { name: 'Signed limits', exact: true }).waitFor();
    assert.equal(await slot.getByText('Agentic Treasury', { exact: true }).count(), 0, 'no standalone brand header');
    assert.equal(await slot.getByRole('link', { name: 'Your treasuries' }).count(), 0, 'no standalone footer link');
    assert.equal(await slot.getByRole('button', { name: /connect wallet/i }).count() <= 1, true);
    assert.equal(await slot.getByLabel('Treasury owner').count(), 1, 'the owner stays visible');
    assert.equal(await slot.getByRole('heading', { name: 'Members' }).count(), 0, 'no sign-in card');

    // Navigation stays inside Treasury: the host address is untouched when a Treasury link is followed.
    await slot.getByRole('link', { name: 'Balances and funding' }).click();
    await slot.getByRole('heading', { name: 'Balances', exact: true }).waitFor();
    await hostUntouched(view);

    // A plain anchor that would leave Treasury does nothing to the host.
    await page.evaluate(() => { const a = document.createElement('a'); a.href = '/'; a.id = 'escape'; a.textContent = 'escape'; document.querySelector('#slot > div').append(a); });
    await page.locator('#escape').click();
    await hostUntouched(view);

    assert.deepEqual(gateway.calls.filter(method => SENDS.has(method)), [], 'mounting and navigating start no send, save or signing');
    assert.deepEqual(gateway.unexpected, [], 'every agent read was a declared fixture read');
    assert.deepEqual(view.errors, [], 'no uncaught errors in the host');
    console.log('PASS embedded Treasury shows the desk without standalone chrome, keeps navigation inside itself and starts no money action');

    await page.evaluate(() => window.embedded.unmount());
    assert.equal(await slot.innerHTML(), '', 'unmount empties the container');
    console.log('PASS unmount empties the host container');
    await view.context.close();
  }

  // 2. The host claims an account the gateway does not have signed in: nothing private is read or shown.
  {
    const view = await open({ viewer: signedIn(OWNER), account: 'someone-else.near' });
    await view.slot.getByRole('heading', { name: 'Account mismatch' }).waitFor();
    assert.equal(await view.slot.getByRole('heading', { name: 'Signed limits' }).count(), 0);
    assert.deepEqual(gateway.calls, [], 'a mismatched account reads no agent records');
    await hostUntouched(view);
    console.log('PASS a different account from the host shows nothing private');
    await view.context.close();
  }

  // 3. Nobody is signed in: Treasury asks the host, not its own sign-in.
  {
    const view = await open({ viewer: null });
    await view.slot.getByText('Sign in to the host app to use this treasury.').waitFor();
    assert.equal(await view.slot.getByRole('button', { name: /connect wallet/i }).count(), 0, 'no Treasury sign-in');
    assert.deepEqual(gateway.calls, [], 'signed out reads no agent records');
    await hostUntouched(view);
    console.log('PASS signed out shows a host sign-in notice, not Treasury sign-in');
    await view.context.close();
  }

  // 4. The gateway is down: the usual unavailable page, inside the container.
  {
    const view = await open({ viewer: null, down: true });
    await view.slot.getByRole('heading', { name: 'Dashboard unavailable' }).waitFor();
    await hostUntouched(view);
    console.log('PASS gateway unavailable is reported inside the container');
    await view.context.close();
  }

  // 5. The host must name the agent and the account.
  {
    const view = await open({ viewer: signedIn(OWNER), account: '' });
    assert.match(await view.page.evaluate(() => window.mountError), /account/);
    console.log('PASS mount refuses a missing account');
    await view.context.close();
  }
  failed = false;
} finally {
  await browser.close();
  remote.close();
  host.close();
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
