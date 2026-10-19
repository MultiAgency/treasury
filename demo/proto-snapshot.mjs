// Shared by the Treasury demo recipes: run against a verified copy of a Proto stack snapshot (or a working
// checkout), so a concurrent edit or build cannot change a run, and record what the run used.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const SKIP = new Set(['.test-artifacts', 'SNAPSHOT.json']);

/** Proto's `test/e2e/run.mjs` digest(): sorted paths and file bytes; symlinks such as node_modules are skipped. */
export function digest(dir, skipTop = new Set()) {
  const hash = createHash('sha256');
  const scan = (path, prefix = '') => { for (const file of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!prefix && skipTop.has(file.name)) continue;
    if (file.isDirectory()) scan(join(path, file.name), prefix + file.name + '/');
    else if (file.isFile()) hash.update(prefix + file.name).update('\0').update(readFileSync(join(path, file.name))).update('\0');
  } };
  scan(dir); return hash.digest('hex');
}

/**
 * A pinned snapshot is used only if its content still matches its recorded runDigest; it is refused before
 * anything is created. `copy(into)` copies it (or a checkout's sources) and checks the copy again.
 */
export function openProto(dir) {
  const proto = resolve(dir);
  if (!existsSync(join(proto, 'test/e2e/environment.mjs'))) throw new Error(`No Proto checkout with its simulated harness at ${proto}; pass --proto DIR`);
  const pinned = existsSync(join(proto, 'SNAPSHOT.json')) ? JSON.parse(readFileSync(join(proto, 'SNAPSHOT.json'), 'utf8')) : null;
  const verified = pinned && digest(proto, SKIP);
  if (pinned && verified !== pinned.runDigest) throw new Error(`Proto snapshot ${proto} does not match its runDigest (${verified} ≠ ${pinned.runDigest}); refusing to run`);
  return {
    proto, pinned,
    copy(snapshot) {
      if (pinned) {
        cpSync(proto, snapshot, { recursive: true, verbatimSymlinks: true, filter: path => ![...SKIP].some(name => path === join(proto, name)) });
        if (digest(snapshot, SKIP) !== pinned.runDigest) throw new Error('Copied Proto snapshot does not match its runDigest; refusing to run');
        return;
      }
      for (const name of ['src', 'web', 'evidence', 'scripts', 'test/e2e', 'test/offline.env', 'test/fixtures/offline-network.cjs', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json']) {
        mkdirSync(resolve(join(snapshot, name), '..'), { recursive: true });
        cpSync(join(proto, name), join(snapshot, name), { recursive: true, filter: path => !path.endsWith('/node_modules') && !path.endsWith('/dist') });
      }
      symlinkSync(join(proto, 'node_modules'), join(snapshot, 'node_modules'), 'dir');
    },
    /** What the run used, for its receipt. */
    provenance(snapshot) {
      return { ...(pinned ? { protoSnapshot: { path: proto, runDigest: pinned.runDigest, verifiedBeforeRun: verified, sourceHead: pinned.sourceHead, overlayDiffSha256: pinned.overlayDiffSha256 } }
        : { protoHead: spawnSync('git', ['-C', proto, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
          protoDirty: spawnSync('git', ['-C', proto, 'status', '--short'], { encoding: 'utf8' }).stdout.trimEnd().split('\n').filter(Boolean) }),
        protoSource: digest(join(snapshot, 'src')), protoHarness: digest(join(snapshot, 'test/e2e')) };
    },
    /** A pinned snapshot carries its verified web/dist; a working checkout is built in the copy. */
    build(snapshot, artifacts, env) {
      if (pinned) return;
      const build = spawnSync(join(proto, 'node_modules/.bin/rsbuild'), ['build', '--root', 'web'], { cwd: snapshot, env: { ...env, NODE_ENV: 'production' }, encoding: 'utf8' });
      writeFileSync(join(artifacts, 'proto-web-build.log'), build.stdout + build.stderr);
      if (build.status !== 0) throw new Error(`Proto web build failed; see ${join(artifacts, 'proto-web-build.log')}`);
    },
    /** A pinned snapshot must be unchanged after the run, or the run does not count. */
    unchanged() { return pinned ? digest(proto, SKIP) === pinned.runDigest : null; },
  };
}
