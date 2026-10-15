/** Run the offline browser regressions against the freshly built app. No server or executor starts. */
const { readdirSync, mkdtempSync, cpSync, rmSync, symlinkSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

const suites = readdirSync(__dirname).filter(name => name.endsWith('.cjs') && name !== 'run.cjs').sort();
if (!suites.length) throw new Error('No browser suites found');
const requested = process.argv.slice(2);
for (const name of requested) {
  if (!suites.includes(name)) throw new Error(`Unknown browser suite: ${name}. Available: ${suites.join(', ')}`);
}
// Browser processes receive no application credentials; fixture-specific browser overrides remain.
const { offlineEnvironment } = require('../../scripts/test-environment.mjs');
const env = offlineEnvironment();
for (const key of ['BROWSER_EXECUTABLE', 'PLAYWRIGHT_MODULE', 'PLAYWRIGHT_BROWSERS_PATH', 'XDG_CACHE_HOME']) if (process.env[key]) env[key] = process.env[key];
// A full-suite command must not silently inherit an individual scenario filter.
for (const key of ['CASE_FILTER', 'SCENARIO', 'TEST_CASE', 'WIG_CASE']) delete env[key];
let failures = 0;
const artifactParent = resolve(__dirname, '../../.test-artifacts/browser');
mkdirSync(artifactParent, { recursive: true });
const artifacts = mkdtempSync(join(artifactParent, 'run-'));
const results = [];
function digest(directory) {
  const hash = createHash('sha256');
  const scan = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) scan(join(dir, entry.name), name + '/');
      else if (entry.isFile()) hash.update(name).update('\0').update(readFileSync(join(dir, entry.name))).update('\0');
    }
  };
  scan(directory);
  return hash.digest('hex');
}
// Other sessions may rebuild or edit fixtures. Keep assets and tests fixed for this invocation.
const snapshot = mkdtempSync(join(tmpdir(), 'proto-browser-'));
try {
  cpSync(resolve(__dirname, '../../web/dist'), join(snapshot, 'dist'), { recursive: true });
  cpSync(__dirname, join(snapshot, 'test/browser'), { recursive: true });
  cpSync(resolve(__dirname, '../../src'), join(snapshot, 'src'), { recursive: true });
  cpSync(resolve(__dirname, '../../web'), join(snapshot, 'web'), { recursive: true,
    filter: path => !path.endsWith('/dist') && !path.endsWith('/node_modules') });
  cpSync(resolve(__dirname, '../../evidence'), join(snapshot, 'evidence'), { recursive: true });
  cpSync(resolve(__dirname, '../../package.json'), join(snapshot, 'package.json'));
  cpSync(resolve(__dirname, '../../pnpm-lock.yaml'), join(snapshot, 'pnpm-lock.yaml'));
  symlinkSync(resolve(__dirname, '../../node_modules'), join(snapshot, 'node_modules'), 'dir');
  const manifest = { node: process.version, assets: digest(join(snapshot, 'dist')),
    source: { server: digest(join(snapshot, 'src')), web: digest(join(snapshot, 'web')), evidence: digest(join(snapshot, 'evidence')) },
    fixtures: digest(join(snapshot, 'test/browser')), lockfile: createHash('sha256').update(readFileSync(join(snapshot, 'pnpm-lock.yaml'))).digest('hex'),
    suites: requested.length ? requested : suites };
  writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Browser run manifest: ${join(artifacts, 'manifest.json')}`);
  for (const name of manifest.suites) {
    console.log(`\nBrowser suite: ${name}`);
    const suiteArtifacts = join(artifacts, name);
    const started = Date.now();
    const result = spawnSync(process.execPath, [join(snapshot, 'test/browser', name), join(snapshot, 'dist')], {
      cwd: snapshot, env: { ...env, PROTO_BROWSER_ARTIFACTS: suiteArtifacts }, stdio: 'inherit', timeout: 180_000,
    });
    results.push({ suite: name, status: result.status, signal: result.signal, error: result.error?.message, durationMs: Date.now() - started });
    if (result.error || result.status !== 0) {
      failures++;
      console.error(`${name} failed: ${result.error?.message ?? result.signal ?? result.status}`);
    } else rmSync(suiteArtifacts, { recursive: true, force: true });
  }
} finally {
  writeFileSync(join(artifacts, 'results.json'), JSON.stringify(results, null, 2));
  if (failures) {
    cpSync(snapshot, join(artifacts, 'snapshot'), { recursive: true, filter: path => !path.endsWith('/node_modules') });
    console.error(`Failure traces, screenshots and snapshot retained at ${artifacts}`);
  }
  rmSync(snapshot, { recursive: true, force: true });
}
console.log(`\n${failures} browser suite(s) failed.`);
process.exitCode = failures ? 1 : 0;
