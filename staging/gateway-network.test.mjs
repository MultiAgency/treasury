import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('packaged guard starts in the hosted-agent environment without staging-only variables',()=>{
 const guard=fileURLToPath(new URL('./gateway-network.cjs',import.meta.url));
 const script=`Promise.resolve().then(()=>fetch('https://api.dev.multiagency.ai/')).then(()=>process.exit(2)).catch(error=>{if(!error.message.includes('blocked'))process.exit(3);});`;
 const child=spawnSync(process.execPath,['--require',guard,'-e',script],{encoding:'utf8',env:{PATH:process.env.PATH,NEAR_INTENTS_AGENT_API_URL:'https://persistent-synthetic-provider-staging.up.railway.app'}});
 assert.equal(child.status,0,child.stderr);
});
