import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, lstatSync, existsSync, openSync, closeSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { offlineEnvironment } from '../../scripts/test-environment.mjs';

// Capture the complete Git-visible working tree, including unstaged/untracked tests, without touching
// the index or making a release commit on behalf of other reviewing sessions.
const root = resolve(import.meta.dirname, '../..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const files = () => [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))]
  .filter(file => existsSync(join(root, file))).sort();
const fingerprint = (base, names) => Object.fromEntries(names.map(file => {
  if (!lstatSync(join(base, file)).isFile()) throw new Error(`Candidate requires regular files: ${file}`);
  return [file, { hash: sha(readFileSync(join(base, file))), mode: lstatSync(join(base, file)).mode & 0o777 }];
}));
// Also reject added snapshot source, while allowing the pipeline's explicit generated outputs.
function capturedFiles(base, prefix = '') {
  return readdirSync(join(base, prefix), { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name;
    if (['node_modules', '.test-artifacts', 'web/dist'].includes(name)) return [];
    return entry.isDirectory() ? capturedFiles(base, name + '/') : [name];
  }).sort();
}
const names = files(), before = fingerprint(root, names), baseCommit = git('rev-parse', 'HEAD').trim();
const parent = join(root, '.test-artifacts/candidates'); mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(join(parent, 'candidate-')), snapshot = join(directory, 'source');
for (const file of names) { const to = join(snapshot, file); mkdirSync(dirname(to), { recursive: true }); copyFileSync(join(root, file), to); }
const captured = fingerprint(snapshot, names);
if (JSON.stringify(before) !== JSON.stringify(captured) || JSON.stringify(before) !== JSON.stringify(fingerprint(root, files())))
  throw new Error('Working files changed during candidate capture; retry after coordinating edits.');
symlinkSync(join(root, 'node_modules'), join(snapshot, 'node_modules'), 'dir');
const manifest = { capturedAt: new Date().toISOString(), baseCommit, sourceHash: sha(JSON.stringify(captured)), files: captured,
  node: process.version, scope: 'offline candidate; not a deployment or release commit', dependencies: 'Existing node_modules shared read-only; do not install/update dependencies during verification' };
writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Candidate ${manifest.sourceHash}\nArtifacts: ${directory}`);
const env = { ...offlineEnvironment(), NODE_ENV: 'production', NODE_OPTIONS: `--require ${JSON.stringify(join(snapshot, 'test/fixtures/offline-network.cjs'))}` };
for (const key of ['BROWSER_EXECUTABLE', 'PLAYWRIGHT_BROWSERS_PATH']) if (process.env[key]) env[key] = process.env[key];
const log = openSync(join(directory, 'verify.log'), 'w');
let result;
try { result = spawnSync('pnpm', ['verify'], { cwd: snapshot, env, stdio: ['ignore', log, log] }); }
finally { closeSync(log); }
const unchanged = JSON.stringify(captured) === JSON.stringify(fingerprint(snapshot, capturedFiles(snapshot)));
const workingTreeStillMatches = JSON.stringify(captured) === JSON.stringify(fingerprint(root, files()));
const summary = { finishedAt: new Date().toISOString(), exitCode: result.status, signal: result.signal, error: result.error?.message,
  snapshotUnchanged: unchanged, workingTreeStillMatches, passed: result.status === 0 && unchanged && workingTreeStillMatches };
writeFileSync(join(directory, 'result.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
process.exitCode = summary.passed ? 0 : 1;
