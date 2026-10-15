import { cpSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runChallenges } from './challenge.mjs';
import { offlineEnvironment } from '../../scripts/test-environment.mjs';

const root = resolve(import.meta.dirname, '../..');
const parent = join(root, '.test-artifacts/e2e'); mkdirSync(parent, { recursive: true });
const artifacts = mkdtempSync(join(parent, 'run-')), snapshot = join(artifacts, 'snapshot'); mkdirSync(snapshot);
for (const name of ['src', 'web', 'evidence', 'scripts', 'test/e2e', 'test/offline.env', 'test/fixtures/offline-network.cjs', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json']) {
  const target = join(snapshot, name); mkdirSync(resolve(target, '..'), { recursive: true });
  cpSync(join(root, name), target, { recursive: true, filter: path => !path.endsWith('/node_modules') && !path.endsWith('/dist') });
}
symlinkSync(join(root, 'node_modules'), join(snapshot, 'node_modules'), 'dir');
const env = { ...offlineEnvironment(), NODE_ENV: 'production', PROTO_E2E_ISOLATED: '1', PROTO_E2E_ARTIFACTS: artifacts,
  NODE_OPTIONS: `--require ${JSON.stringify(join(snapshot, 'test/fixtures/offline-network.cjs'))}` };
for (const key of ['BROWSER_EXECUTABLE', 'PLAYWRIGHT_BROWSERS_PATH']) if (process.env[key]) env[key] = process.env[key];
function digest(dir) {
  const hash = createHash('sha256');
  function scan(path, prefix = '') {
    for (const file of readdirSync(path, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = prefix + file.name;
      if (file.isDirectory()) scan(join(path, file.name), name + '/');
      else if (file.isFile()) hash.update(name).update('\0').update(readFileSync(join(path, file.name))).update('\0');
    }
  }
  scan(dir); return hash.digest('hex');
}
const run = (command, args) => spawnSync(command, args, { cwd: snapshot, env, stdio: 'inherit' });
console.log(`Isolated E2E release and evidence: ${artifacts}`);
const build = run(join(root, 'node_modules/.bin/rsbuild'), ['build', '--root', 'web']);
if (build.status !== 0) process.exit(build.status ?? 1);
writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify({ node: process.version, source: digest(join(snapshot, 'src')),
  frontend: digest(join(snapshot, 'web/src')), evidence: digest(join(snapshot, 'evidence')), assets: digest(join(snapshot, 'web/dist')), tests: digest(join(snapshot, 'test/e2e')),
  playwright: JSON.parse(readFileSync(join(root, 'node_modules/@playwright/test/package.json'))).version,
  lockfile: createHash('sha256').update(readFileSync(join(snapshot, 'pnpm-lock.yaml'))).digest('hex'), scope: 'offline application E2E; simulated provider, chain, and wallet' }, null, 2));
const exploring = process.argv[2] === '--explore';
const challenging = process.argv[2] === '--challenge';
if (challenging && process.argv.length !== 3) throw new Error('Challenge runs require the complete baseline; no filters allowed.');
if (challenging) {
  const listed = spawnSync(process.execPath, [join(root, 'node_modules/@playwright/test/cli.js'), 'test', '-c',
    'test/e2e/playwright.config.mjs', '--list', '--reporter=json'], { cwd: snapshot, env, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`Cannot discover the challenge baseline: ${listed.stderr}`);
  // Discovery comes from the same isolated source/configuration, before executing any cases.
  writeFileSync(join(artifacts, 'baseline-list.json'), listed.stdout);
}
const result = run(process.execPath, exploring ? ['test/e2e/explore.mjs', ...process.argv.slice(3)] : [join(root, 'node_modules/@playwright/test/cli.js'), 'test', '-c', 'test/e2e/playwright.config.mjs', ...(challenging ? [] : process.argv.slice(2))]);
process.exitCode = result.status ?? 1;
if (challenging && result.status === 0) process.exitCode = runChallenges({ snapshot, artifacts, env, root }) ? 0 : 1;
