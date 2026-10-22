// Loads the embed build (`pnpm build:embed`) into a host page from another origin and checks that it
// mounts inside the host's container, leaves the host's document alone and unmounts cleanly.
// Offline: the host's gateway is down, so Treasury shows its "unavailable" page.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginModuleFederation } from '@module-federation/rsbuild-plugin';
import { createRsbuild } from '@rsbuild/core';
import { chromium } from '@playwright/test';

const dist = fileURLToPath(new URL('../web/dist-embed/', import.meta.url));
if (!existsSync(join(dist, 'remoteEntry.js'))) throw new Error('web/dist-embed is missing: run pnpm build:embed first');

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.html': 'text/html', '.woff2': 'font/woff2' };
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

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
writeFileSync(join(work, 'host.js'), `window.hostReady = import('treasury/mount').then(({ mount }) => { window.embedded = mount(document.getElementById('slot')); });`);
const builder = await createRsbuild({ cwd: work, config: {
  plugins: [pluginModuleFederation({ name: 'host', dts: false, remotes: { treasury: `treasury@http://127.0.0.1:${remotePort}/remoteEntry.js` } })],
  source: { entry: { index: join(work, 'host.js') } },
  html: { template: join(work, 'index.html') },
  output: { distPath: { root: join(work, 'dist') } },
  performance: { printFileSize: false },
} });
await builder.build();
const hostDist = join(work, 'dist');
// Its gateway is down, so Treasury shows its "unavailable" page.
const host = createServer((request, response) => {
  const path = new URL(request.url, 'http://x').pathname;
  const file = join(hostDist, path === '/' ? 'index.html' : normalize(path));
  if (path.startsWith('/gw/') || !file.startsWith(hostDist) || !existsSync(file)) { response.writeHead(503, { 'content-type': 'application/json' }).end('{}'); return; }
  response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
const hostPort = await listen(host);

const executablePath = process.env.BROWSER_EXECUTABLE
  ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const browser = await chromium.launch({ headless: true, executablePath });
let failed = true;
try {
  const context = await browser.newContext();
  const tab = await context.newPage();
  const errors = [];
  tab.on('pageerror', error => errors.push(error.message));
  await tab.goto(`http://127.0.0.1:${hostPort}/`);
  await tab.evaluate(() => window.hostReady);

  const slot = tab.locator('#slot');
  await slot.getByRole('heading', { name: 'Dashboard unavailable' }).waitFor({ timeout: 15_000 });
  assert.equal(await tab.locator('#host-header').innerText(), 'Host app', 'the host keeps its own header');
  assert.equal(await tab.evaluate(() => document.documentElement.className), '', 'the embed does not change the host document theme');
  assert.deepEqual(errors, [], 'no uncaught errors in the host');
  console.log('PASS Treasury mounts inside a host from another origin and leaves the host document alone');

  await tab.evaluate(() => window.embedded.unmount());
  assert.equal(await slot.innerHTML(), '', 'unmount empties the container');
  console.log('PASS unmount empties the host container');
  failed = false;
} finally {
  await browser.close();
  remote.close();
  host.close();
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
