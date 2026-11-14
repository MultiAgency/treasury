import {mkdirSync,readdirSync,existsSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {SyntheticStore} from './store.mjs';
import {providerServer} from './provider.ts';
import {walletLookup,readOwnershipQuery} from './ownership.ts';
import {USDC} from './policy.mjs';

if(process.env.STAGING_SYNTHETIC!=='true')throw Error('Explicit synthetic mode is required');
if(process.env.NEAR_INTENTS_AGENT_API_KEY||process.env.TREASURY_CREDENTIAL_FILE)throw Error('Use an isolated environment without platform credentials');
const origin=new URL(process.env.STAGING_PUBLIC_ORIGIN??'');
if(origin.protocol!=='https:')throw Error('Synthetic public origin must use HTTPS');
const data=process.env.STAGING_DATA_DIR??'/data';
mkdirSync(data,{recursive:true,mode:0o700});
const marker=join(data,'.synthetic-provider-v1');
if(!existsSync(marker)){
 if(readdirSync(data).some(name=>name!=='lost+found'))throw Error('Refusing to initialize on an existing backend volume');
 writeFileSync(marker,'persistent-synthetic-provider-v1\n',{flag:'wx',mode:0o600});
}
if(readFileSync(marker,'utf8')!=='persistent-synthetic-provider-v1\n')throw Error('Unknown synthetic volume format');
const store=new SyntheticStore(join(data,'state.sqlite'));
// 10 synthetic USDC: the amount the full journey funds before its first proposal.
const startingFunds={asset:USDC,amount:'10000000'};
const server=providerServer({store,lookup:walletLookup(),chainRead:readOwnershipQuery,recipient:origin.host,controlToken:process.env.STAGING_CONTROL_TOKEN??'',startingFunds});
server.listen(Number(process.env.PORT??3000),'0.0.0.0',()=>console.log(JSON.stringify({ready:true,synthetic:true,origin:origin.origin})));
let stopping=false;
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{
 if(stopping)return;stopping=true;
 server.close(()=>{store.close();process.exit(0);});
 server.closeIdleConnections();
});
