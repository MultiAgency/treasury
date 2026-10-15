import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createServer, request, type Server, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { readGateway } from "../web/src/app/gateway-contract.js";

const require = createRequire(import.meta.url);
const { workspaceEvidence } = require("./browser/fixtures/workspace.cjs");
const listen = (server: Server) => new Promise<number>(done => server.listen(0, "127.0.0.1", () => done((server.address() as AddressInfo).port)));
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function digest(directory: string): string {
  return hash(readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).map(e =>
    e.name + "\0" + (e.isDirectory() ? digest(join(directory,e.name)) : hash(readFileSync(join(directory,e.name))))).join("\n"));
}

test("focused assets reuse the shared gateway and one simulated DAO backend with host-bound private access", { timeout: 90_000 }, async t => {
  const proto = resolve(process.env.TREASURY_REFERENCE_PROTO!);
  const artifact = resolve(process.env.TREASURY_REFERENCE_ARTIFACT!);
  const manifest = JSON.parse(readFileSync(join(artifact,"manifest.json"),"utf8"));
  assert.equal(manifest.presentation,"focused");
  for (const file of manifest.files) assert.equal(hash(readFileSync(join(artifact,"frontend",file.path))),file.sha256);
  const sourceBefore = digest(join(proto,"src"));
  const dir = mkdtempSync(join(tmpdir(),"treasury-reference-"));
  const snapshot = join(dir,"proto"); mkdirSync(snapshot);
  cpSync(join(proto,"src"),join(snapshot,"src"),{recursive:true});
  cpSync(join(proto,"package.json"),join(snapshot,"package.json"));
  cpSync(join(proto,"tsconfig.json"),join(snapshot,"tsconfig.json"));
  symlinkSync(join(proto,"node_modules"),join(snapshot,"node_modules"),"dir");
  // Preserve the source tree's current default frontend; never rebuild or replace Proto.
  const protoDist=join(snapshot,"web/dist"); mkdirSync(protoDist,{recursive:true});
  cpSync(join(proto,"web/dist"),protoDist,{recursive:true});
  const sourceDigest=digest(join(snapshot,"src")); assert.equal(sourceDigest,sourceBefore);
  const defaultIndex=readFileSync(join(protoDist,"index.html"),"utf8");
  const REF="reference.test", PROTO="proto.test", DAO="team.sputnik-dao.near";
  const secret="offline-reference-session-secret-123456789";
  const fragment=JSON.parse(readFileSync("deploy/treasury-reference-host.example.json","utf8"));
  assert(!Object.hasOwn(fragment,"treasury.multiagency.ai"),"candidate must not replace the wallet host");
  assert(!Object.hasOwn(fragment,"proto.multiagency.ai"),"candidate must not replace Proto's frontend");
  const reference=fragment["reference.treasury.multiagency.ai"];
  assert.deepEqual(reference.agents,["treasury"]);assert.deepEqual(reference.hostedAreas,[]);
  const { demoSession } = await import(pathToFileURL(join(snapshot,"src/gateway/demo-hosts.ts")).href);
  const { budget, setup, overview }=workspaceEvidence({policyDetails:true,grants:true});
  const book=overview("treasury"); book.area="treasury";
  book.policy.policy.assets=["usdc"]; book.policy.policy.limits={monthly:{usdc:"100000000"}};
  book.policy.policy.budget={daily_usd:"100",weekly_usd:"100",monthly_usd:"100"};
  book.book[0].priceUpdatedAt=new Date().toISOString(); book.book[0].priceExpiresAt=new Date(Date.now()+600_000).toISOString();
  const daoOwner={type:"near",account_id:"0".repeat(64),public_key:"ed25519:11111111111111111111111111111111"};
  const values: Record<string,unknown>={
    ownerIdentity:{agentId:"fixture",owner:daoOwner},
    setup:{...setup,executor:true,owner:daoOwner,dao:{id:DAO,funded:true,owner:daoOwner}},
    instance:{agentId:"fixture",executor:true}, overview:book,"treasury/get":null, unresolved:[],"owner/actions":[],
    "autopilot/get":{on:false,everyMin:60,maxUsd:10},
  };
  const backendCalls: { path:string; cookie:unknown; origin:unknown }[]=[];
  const backend=createServer((req,res)=>{
    const method=new URL(req.url!,"http://fixture").pathname.slice("/rpc/".length);
    backendCalls.push({path:req.url!,cookie:req.headers.cookie,origin:req.headers.origin});
    if(!Object.hasOwn(values,method)){res.writeHead(500).end("Unexpected fixture procedure");return;}
    res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({json:values[method]}));
  });
  const backendPort=await listen(backend);
  const chain=createServer((req,res)=>{
    let body="";req.on("data",x=>body+=x).on("end",()=>{
      const {id,params}=JSON.parse(body);
      const view=(value:unknown)=>({result:{result:[...Buffer.from(JSON.stringify(value))],logs:[],block_height:1,block_hash:"11111111111111111111111111111111"}});
      const policy={proposal_bond:"0",roles:[{name:"Council",kind:{Group:["member.near"]},permissions:["call:*","policy:*"],vote_policy:{}}],default_vote_policy:{threshold:[1,2]}};
      const answer=params.account_id===DAO?view(policy):params.account_id==="v1.signer"?view(daoOwner.public_key)
        :{error:{name:"HANDLER_ERROR",cause:{name:"UNKNOWN_ACCOUNT",info:{requested_account_id:params.account_id}},code:-32000,message:"Server error"}};
      res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id,...answer}));
    });
  });
  const chainPort=await listen(chain);
  const probe=createServer();const port=await listen(probe);await new Promise<void>(done=>probe.close(()=>done()));
  const state=join(dir,"state");mkdirSync(state);
  const config={host:PROTO,selfService:true,walkthroughs:true,agents:[
    {name:"treasury",area:"treasury",owner:DAO,port:backendPort},
    {name:"payout",area:"payables",owner:DAO,port:backendPort+1,executor:false},
  ],hosts:{
    [PROTO]:{demo:"showcase",agents:["treasury","payout"],hostedAreas:[]},
    [REF]:{...reference,frontendDist:join(artifact,"frontend")},
  }};
  writeFileSync(join(state,"dashboard.json"),JSON.stringify(config));
  const child=spawn(process.execPath,["--import",pathToFileURL(join(snapshot,"node_modules/tsx/dist/loader.mjs")).href,join(snapshot,"src/gateway/server.ts")],{
    cwd:state,env:{...process.env,PORT:String(port),NEAR_RPC_URL:`http://127.0.0.1:${chainPort}`,SESSION_SECRET:secret,DASHBOARD_FILE:join(state,"dashboard.json")},stdio:["ignore","pipe","pipe"],
  });
  let stderr="";child.stderr!.on("data",x=>stderr+=x);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async()=>{await browser?.close();child.kill();backend.closeAllConnections();chain.closeAllConnections();await Promise.all([new Promise<void>(r=>backend.close(()=>r())),new Promise<void>(r=>chain.close(()=>r()))]);assert.equal(digest(join(proto,"src")),sourceBefore,"Proto source changed during the check; rerun against a stable candidate");rmSync(dir,{recursive:true,force:true});});
  await new Promise<void>((done,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`Shared gateway did not start: ${stderr}`)),12_000);
    child.stdout!.on("data",x=>{if(String(x).includes("on port")){clearTimeout(timer);done();}});
    child.on("exit",code=>{clearTimeout(timer);reject(new Error(`Shared gateway exited ${code}: ${stderr}`));});
  });
  const call=(host:string,path:string,method="GET",headers:Record<string,string>={},body?:string)=>new Promise<{status:number;headers:IncomingHttpHeaders;body:Buffer}>((done,reject)=>{
    const req=request({hostname:"127.0.0.1",port,path,method,headers:{host,...headers}},res=>{const chunks:Buffer[]=[];res.on("data",x=>chunks.push(x)).on("end",()=>done({status:res.statusCode!,headers:res.headers,body:Buffer.concat(chunks)}));});req.on("error",reject);req.end(body);
  });
  assert.equal((await call(PROTO,"/")).body.toString(),defaultIndex,"Proto retains its original frontend");
  const publicPage=await call(REF,"/");assert.equal(publicPage.status,200);assert.equal(publicPage.headers.location,undefined);
  assert.equal(publicPage.body.toString(),readFileSync(join(artifact,"frontend/index.html"),"utf8"));
  const discovery=await call(REF,"/gw/me");assert.deepEqual(JSON.parse(discovery.body.toString()).agents,[]);assert.equal(backendCalls.length,0,"signed-out discovery reads no backend");
  const challenge=await call(REF,"/gw/challenge");assert.equal(JSON.parse(challenge.body.toString()).recipient,REF);
  const cookie=demoSession(secret,REF).open("member.near").split(";")[0];
  const me=await call(REF,"/gw/me","GET",{cookie});
  const gateway=await readGateway(new Response(me.body.toString(),{headers:{"content-type":"application/json"}}),{hostname:REF,protocol:"https:",pathname:"/"});
  assert.deepEqual(gateway?.agents.map(a=>a.name),["treasury"]);assert.equal(gateway?.agents[0]?.dao,true);assert.equal(gateway?.selfServiceTreasury,false);
  const copied=await call(REF,"/gw/me","GET",{cookie:demoSession(secret,PROTO).open("member.near").split(";")[0]});assert.equal(JSON.parse(copied.body.toString()).viewer,null);
  const outsider=await call(REF,"/a/treasury/rpc/overview","POST",{cookie:demoSession(secret,REF).open("outsider.near").split(";")[0],origin:`https://${REF}`},'{}');assert.equal(outsider.status,403);
  const beforeDenied=backendCalls.length;
  for(const [host,path,headers,status] of [
    [REF,"/a/payout/rpc/overview",{cookie,origin:`https://${REF}`},404],
    [REF,"/a/treasury/rpc/overview",{cookie,origin:`https://${PROTO}`},403],
    ["unknown.test","/a/treasury/rpc/overview",{cookie,"x-forwarded-host":REF},421],
  ] as const){assert.equal((await call(host,path,"POST",headers,'{}')).status,status);}
  assert.equal(backendCalls.length,beforeDenied,"denied requests never reach the executor");
  const retainedPage=await call(REF,"/a/treasury/follow/run?run=retained-record");
  assert.equal(retainedPage.status,200);assert.equal(retainedPage.headers.location,undefined,"scoped record URLs are not redirected or rewritten");
  assert.equal(retainedPage.body.toString(),publicPage.body.toString());
  const exact="/a/treasury/rpc/overview?json=%7B%22id%22%3A%22retained%22%7D";
  const observed=await call(REF,exact,"GET",{cookie});assert.equal(observed.status,200);assert.equal(backendCalls.at(-1)?.path,exact.replace("/a/treasury",""));
  assert.equal(backendCalls.at(-1)?.cookie,undefined);assert.equal(backendCalls.at(-1)?.origin,undefined);
  assert.equal(observed.headers["cache-control"],"private, no-store");
  assert.equal((await call(REF,"/gw/agents","POST",{cookie,origin:`https://${REF}`},JSON.stringify({owner:DAO,kind:"dao",area:"treasury"}))).status,403,"reference entry cannot reserve another executor");
  assert(!existsSync(join(state,".hosted")),"reference entry created no registry or child settings");

  browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE});
  const context=await browser.newContext({viewport:{width:1280,height:1000},reducedMotion:"reduce"});
  await context.addCookies([{name:"__Host-demo_session",value:cookie.split("=").slice(1).join("="),domain:REF,path:"/",secure:true,httpOnly:true,sameSite:"Strict"}]);
  const page=await context.newPage();const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.route("**/*",async route=>{
    const req=route.request(),url=new URL(req.url());if(url.hostname!==REF)return route.abort();
    const all=await req.allHeaders();const headers=Object.fromEntries(Object.entries(all).filter(([key])=>!["host","content-length","connection","accept-encoding"].includes(key)));
    const answer=await call(REF,url.pathname+url.search,req.method(),headers,req.postData()??undefined);
    await route.fulfill({status:answer.status,headers:Object.fromEntries(Object.entries(answer.headers).filter(([key,value])=>value!==undefined&&!["transfer-encoding","connection","content-length"].includes(key)).map(([key,value])=>[key,Array.isArray(value)?value.join(", "):String(value)])),body:answer.body});
  });
  await page.goto(`https://${REF}/`);
  await page.getByRole("heading",{name:"Signed limits",exact:true}).waitFor();
  assert.equal(new URL(page.url()).pathname,"/a/treasury/");
  await page.getByRole("region",{name:"Treasury owner"}).getByText(`${DAO} (by proposal)`,{exact:true}).waitFor();
  await page.getByRole("region",{name:"Schedule status"}).getByText("off",{exact:true}).waitFor();
  assert.equal(await page.getByRole("link",{name:"Payables",exact:true}).count(),0);
  const screenshots=join(artifact,"inspection");mkdirSync(screenshots,{recursive:true});
  for(const width of [1280,390]){await page.setViewportSize({width,height:1000});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(screenshots,`reference-${width}.png`),fullPage:true});}
  assert.deepEqual(errors,[]);
  assert(backendCalls.every(c=>Object.hasOwn(values,new URL(c.path,"http://fixture").pathname.slice("/rpc/".length))),"only declared observation procedures reached the backend");
  writeFileSync(join(artifact,"integration-result.json"),JSON.stringify({protoSourceDigest:sourceDigest,treasurySourceDigest:manifest.sourceDigest,backend:"one simulated existing DAO server",executorStarted:false,browser:"focused Treasury desktop/mobile",hostIsolation:true},null,2)+'\n');
});
