import {existsSync, readdirSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

// Full acceptance is deliberately separate from the optional focused test command.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = process.env.STAGING_PLATFORM_SOURCE;
if (!source) throw Error('STAGING_PLATFORM_SOURCE must name an isolated reviewed platform checkout');
const platform = resolve(source);
const loader = join(platform, 'node_modules/tsx/dist/loader.mjs');
const sdk = join(platform, 'node_modules/@near-intents-agent-api/sdk/dist/index.mjs');
for (const path of [loader, sdk, join(platform, 'src/ledger.ts'),
  join(platform, 'src/gateway/server.ts'), join(platform, 'web/dist/confirm.html'),
  join(root, 'web/dist/index.html')]) {
  if (!existsSync(path)) throw Error(`Missing full-acceptance prerequisite: ${path}`);
}
const tests = readdirSync(join(root, 'staging'))
  .filter(name => /\.test\.(ts|mjs)$/.test(name)).sort()
  .map(name => join(root, 'staging', name));
if (!tests.length) throw Error('No staging tests found');
const child = spawn(process.execPath, ['--import', loader, '--test', '--test-reporter=tap', ...tests], {
  cwd: root,
  env: {...process.env, STAGING_PLATFORM_SOURCE: platform, STAGING_TSX_LOADER: loader,
    STAGING_PROVIDER_SDK: sdk, STAGING_BROWSER: 'true'},
  stdio: ['inherit', 'pipe', 'inherit'],
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('close', code => {
  const skipped = /^# skipped (\d+)\s*$/m.exec(output);
  if (code !== 0 || !skipped || skipped[1] !== '0') {
    console.error('Full staging acceptance requires successful tests with zero skips.');
    process.exitCode = 1;
  }
});
