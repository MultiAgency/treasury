import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/gateway/config.js";
import { registeredEnv } from "../src/gateway/treasury-registration.js";

// Retirement phase 0: Proto executes for the agents on production hosts. Nothing this repository
// builds or configures may start a second executor there. Host variables and start-command overrides
// are deployment settings outside the repository and are not checked here. Self-service registration is
// the one recorded exception: see the last test.
const root = fileURLToPath(new URL("../", import.meta.url));
const production = (host: string) => /(^|\.)multiagency\.ai$|\.up\.railway\.app$/i.test(host.replace(/:\d+$/, ""));
const deploy = readdirSync(join(root, "deploy")).filter(name => name.endsWith(".json"));
const dockerfiles = readdirSync(root).filter(name => /^Dockerfile(\..+)?$/.test(name));

/** A gateway configuration as the gateway loads it, schema defaults (`executor: true`) included. */
function gateway(file: string) {
  const previous = process.env.TREASURY_SELF_SERVICE;
  process.env.TREASURY_SELF_SERVICE = "true";
  try { return loadConfig(file); }
  finally { if (previous === undefined) delete process.env.TREASURY_SELF_SERVICE; else process.env.TREASURY_SELF_SERVICE = previous; }
}

/** Gateway configurations whose host is a production host. */
const productionConfigs = () => deploy.filter(name => {
  const raw = JSON.parse(readFileSync(join(root, "deploy", name), "utf8"));
  if (typeof raw.host !== "string") return false;
  const config = gateway(join(root, "deploy", name));
  return [config.host, ...config.signin_hosts, ...config.redirect_hosts].some(production);
});

test("no configured agent executes on a production host", () => {
  const offending: string[] = [];
  for (const name of deploy) {
    const file = join(root, "deploy", name), raw = JSON.parse(readFileSync(file, "utf8"));
    if (typeof raw.host !== "string") {
      // A host-map fragment names existing agents; it must not define one that a gateway would start.
      assert.doesNotMatch(JSON.stringify(raw), /"(executor|envFile|port)"/, `${name} is not a gateway configuration and must not define agent servers`);
      continue;
    }
    const config = gateway(file);
    const hosts = [config.host, ...config.signin_hosts, ...config.redirect_hosts].filter(production);
    if (!hosts.length) continue;
    for (const agent of config.agents) if (agent.executor) offending.push(`${name}: ${agent.name} executes on ${hosts.join(", ")}`);
  }
  assert.deepEqual(offending, []);
});

test("no image runs an agent server that can execute by default", () => {
  const offending: string[] = [];
  for (const name of dockerfiles) {
    const source = readFileSync(join(root, name), "utf8");
    const cmd = source.match(/^CMD (.+)$/m)?.[1] ?? "";
    // An agent server started directly is an executor unless its command forces EXECUTOR=off,
    // which a host variable cannot override.
    if (/src\/(invoices-)?server\.ts/.test(cmd) && !/"EXECUTOR=off"/.test(cmd)) offending.push(`${name}: ${cmd}`);
    // A gateway image's configuration is the one checked above, and must exist.
    const dashboard = source.match(/DASHBOARD_FILE=\/app\/(deploy\/[\w.-]+\.json)/)?.[1];
    if (dashboard) assert.ok(deploy.includes(dashboard.slice("deploy/".length)), `${name} names a missing ${dashboard}`);
  }
  assert.deepEqual(offending, []);
});

// Recorded exception (user decision D3, retirement phase 4): with TREASURY_SELF_SERVICE=true set by the
// host, each registration under .treasuries/ is a new agent that this gateway executes. Proto never
// executes those agents, so it isn't a duplicate executor, but it is execution on a production host.
// Any new production configuration must be added here deliberately.
test("self-service registrations execute on production hosts: the recorded D3 exception", () => {
  const registered = registeredEnv({ name: "t-0", owner: "owner.near", area: "treasury", port: 18000, executor: true, envFile: ".env.instance" }, {});
  assert.equal(registered.EXECUTOR, "on", "self-service registrations execute unless the gateway itself runs EXECUTOR=off");
  assert.deepEqual(productionConfigs(), ["dao-treasury-demo.json", "dashboard.json", "legacy-dashboard.json", "treasury.json"]);
});
