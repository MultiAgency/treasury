import { createServer as httpServer, request } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { offlineEnvironment } from '../../scripts/test-environment.mjs';
import { provider, listen, OWNER, PAYEE } from './provider.mjs';

const root = resolve(import.meta.dirname, '../..');
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
async function freePort(host = '127.0.0.1') {
  const server = httpServer();
  await new Promise(resolve => server.listen(0, host, resolve));
  const port = server.address().port; await close(server); return port;
}
export async function environment(directory, { workspace = false, portfolioOwner = PAYEE } = {}) {
  mkdirSync(directory, { recursive: true });
  const services = [], proxies = [];
  const simulated = await provider(directory);
  const portfolioDir = join(directory, 'portfolio');
  let portfolio;
  if (workspace) { mkdirSync(portfolioDir); portfolio = await provider(portfolioDir, { treasury: true, account: portfolioOwner }); }
  let executor, reviewer;
  const executorDir = join(directory, 'executor'), reviewerDir = join(directory, 'reviewer'), gatewayDir = join(directory, 'gateway');
  for (const dir of [executorDir, reviewerDir, gatewayDir]) mkdirSync(dir);
  const [executorPort, reviewerPort, gatewayPort, invoicePort] = await Promise.all([freePort(), freePort(), freePort(), freePort('::1')]);
  const key = join(directory, 'localhost.key'), cert = join(directory, 'localhost.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  async function proxy(port, host) {
    const server = httpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      const upstream = request({ host, port, method: req.method, path: req.url, headers: req.headers }, answer => {
        res.writeHead(answer.statusCode, answer.headers); answer.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    proxies.push(server); return listen(server);
  }
  const dashboard = `https://127.0.0.1:${await proxy(gatewayPort, '127.0.0.1')}`;
  const invoices = `https://localhost:${await proxy(invoicePort, '::1')}`;
  const common = { ...offlineEnvironment(), NODE_OPTIONS: `--require ${JSON.stringify(join(root, 'test/fixtures/offline-network.cjs'))}`, AGENT_ID: simulated.id, AGENT_GRANT_TOKEN: simulated.token,
    NEAR_INTENTS_AGENT_API_URL: simulated.url, NEAR_RPC_URL: `${simulated.url}/chain`, AUTOPILOT: 'off',
    SESSION_SECRET: 'local-only-session-secret-with-more-than-32-characters', DASHBOARD_AREA: 'payables' };
  async function start(name, cwd, entry, env, ready) {
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, entry)], { cwd, env: { ...common, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    services.push(child);
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      output += chunk; appendFileSync(join(directory, `${name}.log`), chunk);
    });
    const deadline = Date.now() + 20_000;
    while (!output.includes(ready)) {
      if (child.exitCode !== null || child.signalCode) throw new Error(`${name} exited: ${output}`);
      if (Date.now() > deadline) throw new Error(`${name} startup timed out: ${output}`);
      await delay(50);
    }
    return child;
  }
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode) return;
    const ended = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await ended; } finally { clearTimeout(timer); }
  }
  const startExecutor = async () => executor = await start('executor', executorDir, 'src/server.ts', {
    PORT: String(executorPort), EXECUTOR: 'on', INVOICES_PORT: String(invoicePort), INVOICES_HOST: '::1',
    INVOICES_PUBLIC_HOST: new URL(invoices).host, INVOICES_SESSION_SECRET: 'local-only-invoice-secret-kept-across-restarts',
    AGREEMENTS_SECRET: 'local-agreements',
  }, 'Treasury dashboard on');
  // A valid test grant makes executor enforcement observable independently of missing credentials.
  const startReviewer = async () => reviewer = await start('reviewer', reviewerDir, 'src/server.ts', { PORT: String(reviewerPort), EXECUTOR: 'off', AGENT_GRANT_TOKEN: simulated.token,
      AGREEMENTS_URL: `http://[::1]:${invoicePort}`, AGREEMENTS_SECRET: 'local-agreements' }, 'Treasury dashboard on');
  async function dispose() {
    await Promise.all(services.map(stop));
    await Promise.all(proxies.map(close));
    await simulated.close();
    if (portfolio) await portfolio.close();
  }
  try {
    await startExecutor();
    await startReviewer();
    const agents = [{ name: 'payout', owner: OWNER, area: 'payables', port: reviewerPort, executor: false }];
    if (portfolio) {
      const port = await freePort();
      await start('portfolio', portfolioDir, 'src/server.ts', { PORT: String(port), EXECUTOR: 'on',
        AGENT_ID: portfolio.id, AGENT_GRANT_TOKEN: portfolio.token, NEAR_INTENTS_AGENT_API_URL: portfolio.url,
        DASHBOARD_AREA: 'treasury' }, 'Treasury dashboard on');
      // An obsolete operator list is ignored; only the actual owner can access this wallet's agent.
      agents.push({ name: 'portfolio', owner: portfolioOwner, operators: [OWNER], area: 'treasury', port, executor: true });
    }
    writeFileSync(join(gatewayDir, 'dashboard.json'), JSON.stringify({ host: new URL(dashboard).host, invoices,
      agents }));
    await start('gateway', gatewayDir, 'src/gateway/server.ts', { PORT: String(gatewayPort), AGENT_GRANT_TOKEN: '',
      DASHBOARD_FILE: join(gatewayDir, 'dashboard.json') }, 'on port');
  } catch (error) { await dispose(); throw error; }
  function records() {
    if (!existsSync(join(executorDir, '.invoices', `${simulated.id}.sqlite`))) return { invoices: [], revisions: [], payments: [], reservations: [] };
    const db = new DatabaseSync(join(executorDir, '.invoices', `${simulated.id}.sqlite`), { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 5000; BEGIN');
      return Object.fromEntries(['invoices', 'revisions', 'payments', 'reservations'].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
    } finally { db.close(); }
  }
  return { dashboard, invoices, simulated, portfolio, directory, records,
    portfolioState() {
      const read = path => existsSync(path) ? readFileSync(path, 'utf8') : null;
      return { strategy: JSON.parse(read(join(portfolioDir, '.strategy/.env.json')) ?? 'null'),
        settings: read(join(portfolioDir, '.env')), owner: JSON.parse(read(join(portfolioDir, '.owner-intents/.env.json')) ?? '{}') };
    },
    ownerRecords() { const path = join(reviewerDir, '.owner-intents', '.env.json'); return existsSync(path) ? JSON.parse(readFileSync(path)) : {}; },
    async restartExecutor() { await stop(executor); await startExecutor(); },
    async restartReviewer() { await stop(reviewer); await startReviewer(); },
    async close() { await dispose(); writeFileSync(join(directory, 'observations.json'), JSON.stringify({ requests: simulated.requests, errors: simulated.errors, records: records(), owner: this.ownerRecords(), portfolio: portfolio ? { requests: portfolio.requests, errors: portfolio.errors, grants: portfolio.grants, state: this.portfolioState() } : null, browser: this.browserVersion ?? null }, null, 2)); },
  };
}
