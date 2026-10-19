// The SDK dependency spec decides the mode: `link:` for development against Proto's SDK checkout, or the
// vendored tarball for a release candidate. Release steps (packaging, Docker images) run only on a
// release candidate.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SDK = '@multiagency/sdk';
const manifest = fileURLToPath(new URL('../package.json', import.meta.url));

export function sdkMode() {
  const { dependencies, devDependencies } = JSON.parse(readFileSync(manifest, 'utf8'));
  const spec = dependencies?.[SDK] ?? devDependencies?.[SDK] ?? '';
  if (spec.startsWith('link:')) return { mode: 'dev', spec };
  const tarball = spec.match(/^file:(vendor\/multiagency-sdk-[\d.]+\.tgz)$/)?.[1];
  if (tarball) return { mode: 'release', spec, tarball };
  throw new Error(`${SDK} must be a link: (development) or file:vendor/multiagency-sdk-<version>.tgz (release), not ${JSON.stringify(spec)}`);
}

export function requireRelease() {
  const current = sdkMode();
  if (current.mode !== 'release') throw new Error(`dev link: build from a release candidate (${SDK} is ${current.spec})`);
  return current;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(`${SDK}: ${requireRelease().tarball}`); } catch (error) { console.error(error.message); process.exit(1); }
}
