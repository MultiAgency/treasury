import {mkdirSync,readdirSync,existsSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
if(process.env.STAGING_SYNTHETIC!=='true')throw Error('Explicit synthetic mode is required');
const provider=new URL(process.env.STAGING_PROVIDER_ORIGIN??'');
if(provider.protocol!=='https:'||provider.username||provider.password||provider.pathname!=='/')throw Error('Synthetic provider must be an HTTPS origin');
const origin=new URL(process.env.STAGING_PUBLIC_ORIGIN??'');
if(origin.protocol!=='https:')throw Error('Synthetic gateway must use HTTPS');
const data=process.env.STAGING_DATA_DIR??'/data';
mkdirSync(data,{recursive:true,mode:0o700});
const marker=join(data,'.synthetic-gateway-v1');
if(!existsSync(marker)){
 if(readdirSync(data).some(name=>name!=='lost+found'))throw Error('Refusing an existing backend volume');
 writeFileSync(marker,'persistent-synthetic-gateway-v1\n',{mode:0o600,flag:'wx'});
}
if(readFileSync(marker,'utf8')!=='persistent-synthetic-gateway-v1\n')throw Error('Unknown synthetic gateway format');
const state=join(data,'state');mkdirSync(state,{recursive:true,mode:0o700});
const config=join(state,'dashboard.json');
if(!existsSync(config))writeFileSync(config,JSON.stringify({host:origin.host,headless:true,appSetup:['treasury'],agents:[]}),{mode:0o600,flag:'wx'});
if(JSON.parse(readFileSync(config,'utf8')).host!==origin.host)throw Error('Gateway hostname changed; review configuration before starting');
const session=process.env.STAGING_SESSION_SECRET;
if(!session||session.length<32)throw Error('A separate synthetic session secret is required');
const child=spawn(process.execPath,['--import','/app/node_modules/tsx/dist/loader.mjs','/app/src/gateway/server.ts'],{cwd:state,env:{PATH:process.env.PATH,NODE_ENV:'production',PORT:process.env.PORT??'3000',SESSION_SECRET:session,STAGING_PROVIDER_ORIGIN:provider.origin,NODE_OPTIONS:'--require /app/staging/gateway-network.cjs',NEAR_INTENTS_AGENT_API_KEY:'synthetic-provider-only',NEAR_INTENTS_AGENT_API_URL:provider.origin,NEAR_RPC_URL:provider.origin+'/chain',AUTOPILOT:'off',DASHBOARD_FILE:config},stdio:'inherit'});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>child.kill(signal));
child.once('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
