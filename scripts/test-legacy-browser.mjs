import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { offlineEnvironment } from './test-environment.mjs';

// Retained shared-workspace regressions use an explicit historical build, never the product default.
const root = fileURLToPath(new URL('../', import.meta.url));
const treasury = new Set(['treasury-prototype.cjs', 'treasury-creation.cjs', 'treasury-scope.cjs', 'treasury-demo.cjs']);
const available = readdirSync(new URL('../test/browser/', import.meta.url)).filter(name => name.endsWith('.cjs') && name !== 'run.cjs' && !treasury.has(name)).sort();
const requested = process.argv.slice(2);
for (const name of requested) if (!available.includes(name)) throw new Error(`Unknown legacy browser suite: ${name}`);
const suites = requested.length ? requested : available;
const env = { ...offlineEnvironment(), NODE_ENV: 'production', PUBLIC_TREASURY_ONLY: 'false' };
for (const key of ['BROWSER_EXECUTABLE', 'PLAYWRIGHT_BROWSERS_PATH']) if (process.env[key]) env[key] = process.env[key];
const run = (command, args, environment = env) => spawnSync(command, args, { cwd: root, env: environment, stdio: 'inherit' });
const build = run('pnpm', ['build:web']);
let status = build.status ?? 1;
if (status === 0) status = run(process.execPath, ['test/browser/run.cjs', ...suites]).status ?? 1;
// Leave ordinary assets in Treasury mode even when a compatibility regression fails.
const restore = run('pnpm', ['build:web'], { ...env, PUBLIC_TREASURY_ONLY: 'true' });
process.exitCode = status || (restore.status ?? 1);
