import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { offlineEnvironment } from './test-environment.mjs';

// Build and inspect one captured source tree. Never rebuild the shared checkout during a review.
const root = resolve(import.meta.dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const files = () => [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))]
  .filter(file => existsSync(join(root, file))).sort();
const hashes = (base, names) => Object.fromEntries(names.map(file => [file,
  createHash('sha256').update(readFileSync(join(base, file))).digest('hex')]));
const names = files(), before = hashes(root, names);
const parent = join(root, '.test-artifacts/reviews'); mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(join(parent, 'treasury-')), snapshot = join(directory, 'source');
for (const file of names) {
  const destination = join(snapshot, file); mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(root, file), destination);
}
if (JSON.stringify(before) !== JSON.stringify(hashes(snapshot, names)) || JSON.stringify(before) !== JSON.stringify(hashes(root, files())))
  throw new Error('Working files changed during review capture; coordinate edits and retry.');
symlinkSync(join(root, 'node_modules'), join(snapshot, 'node_modules'), 'dir');
writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ capturedAt: new Date().toISOString(), files: before,
  sourceHash: createHash('sha256').update(JSON.stringify(before)).digest('hex'),
  scope: 'offline Treasury UI fixtures; not deployment evidence', dependencies: 'Existing node_modules shared; do not change dependencies during review' }, null, 2));
console.log(`Treasury review source and artifacts: ${directory}`);
const env = { ...offlineEnvironment(), NODE_ENV: 'production', PUBLIC_TREASURY_ONLY: 'true',
  NODE_OPTIONS: `--require ${JSON.stringify(join(snapshot, 'test/fixtures/offline-network.cjs'))}` };
for (const key of ['BROWSER_EXECUTABLE', 'PLAYWRIGHT_BROWSERS_PATH']) if (process.env[key]) env[key] = process.env[key];
const run = (command, args) => spawnSync(command, args, { cwd: snapshot, env, stdio: 'inherit' });
const build = run('pnpm', ['build:web']);
const result = build.status === 0 ? run(process.execPath, ['test/browser/run.cjs', '--keep-artifacts',
  'treasury-prototype.cjs', 'treasury-demo.cjs', 'treasury-accessibility.cjs']) : build;
const summary = { finishedAt: new Date().toISOString(), exitCode: result.status, signal: result.signal,
  error: result.error?.message, workingTreeStillMatches: JSON.stringify(before) === JSON.stringify(hashes(root, files())) };
writeFileSync(join(directory, 'result.json'), JSON.stringify(summary, null, 2));
process.exitCode = result.status ?? 1;
