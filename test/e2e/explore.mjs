import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { environment } from './environment.mjs';
import { installWallet } from './wallet.mjs';
import { OWNER, PAYEE, listen } from './provider.mjs';

// Same local services and wallet boundary as the deterministic tests. Agent-browser attaches via CDP.
const directory = join(process.env.PROTO_E2E_ARTIFACTS, 'exploration'); mkdirSync(directory);
const stack = await environment(join(directory, 'environment'), { workspace: process.argv.includes('--workspace') });
const probe = createServer(), port = await listen(probe);
await new Promise(resolve => probe.close(resolve));
let context;
try {
  context = await chromium.launchPersistentContext(join(directory, 'profile'), {
    headless: true, executablePath: process.env.BROWSER_EXECUTABLE, ignoreHTTPSErrors: true, serviceWorkers: 'block',
    args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
  });
  const account = process.argv.includes('--owner') ? OWNER : PAYEE;
  const { unexpected } = await installWallet(context, stack, account);
  const page = context.pages()[0] ?? await context.newPage();
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  await page.goto(account === OWNER ? `${stack.dashboard}/a/payout/` : stack.invoices);
  const details = { cdp: `http://127.0.0.1:${port}`, dashboard: stack.dashboard, invoices: stack.invoices, account,
    commands: { dropNextTransferResponse: 'create drop-response in the exploration directory', stop: 'create stop in the exploration directory' } };
  writeFileSync(join(directory, 'session.json'), JSON.stringify(details, null, 2));
  console.log(`Agent-browser exploration: ${JSON.stringify(details)}`);
  // File controls stay outside the browser and application: no test-control HTTP endpoints.
  const { existsSync, unlinkSync } = await import('node:fs');
  await new Promise(resolve => {
    const timer = setInterval(() => {
      if (existsSync(join(directory, 'drop-response'))) { unlinkSync(join(directory, 'drop-response')); stack.simulated.dropTransferResponse(); }
      if (existsSync(join(directory, 'stop'))) { clearInterval(timer); resolve(); }
    }, 250);
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { clearInterval(timer); resolve(); });
  });
  await page.screenshot({ path: join(directory, 'final.png'), fullPage: true });
  await context.tracing.stop({ path: join(directory, 'trace.zip') });
  writeFileSync(join(directory, 'browser-requests.json'), JSON.stringify(unexpected, null, 2));
  if (unexpected.length || stack.simulated.errors.length) process.exitCode = 1;
} finally { await context?.close(); await stack.close(); }
