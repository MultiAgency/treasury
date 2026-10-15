import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { offlineEnvironment } from './test-environment.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const [proto, artifact]=process.argv.slice(2);
if (!proto || !artifact || process.argv.length !== 4) throw new Error('Usage: node scripts/test-treasury-reference.mjs PROTO_DIRECTORY TREASURY_ARTIFACT_DIRECTORY');
const env={...offlineEnvironment(), TREASURY_REFERENCE_PROTO:resolve(proto), TREASURY_REFERENCE_ARTIFACT:resolve(artifact),
  NODE_OPTIONS:`--require ${JSON.stringify(resolve(root,'test/fixtures/offline-network.cjs'))}`};
for (const key of ['BROWSER_EXECUTABLE','PLAYWRIGHT_BROWSERS_PATH']) if(process.env[key])env[key]=process.env[key];
const result=spawnSync(process.execPath,['--import','tsx','--test','test/treasury-reference.integration.ts'],{cwd:root,env,stdio:'inherit'});
if(result.error)console.error(result.error.message);
process.exitCode=result.status??1;
