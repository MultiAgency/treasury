// The platform's simulated stack (`pnpm test:e2e:stack --no-browser --treasury` at 766b3f3), through its state file and
// control files only: never through its internals.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ROLES, type Role } from "../src/config.ts";

/** The platform commit the stack runs from: the one `@multiagency/sdk` 0.3.1 was published from (tag `sdk-v0.3.1`). */
export const PLATFORM_COMMIT = "766b3f3";

export const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const WNEAR = "nep141:wrap.near";
export const ETH = "nep141:eth.omft.near";

export type Stack = { directory: string; origin: string; agent: string; ca: string };

export function stack(directory: string): Stack {
  const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as { treasury?: { agent: string; machineBase: string } };
  if (!state.treasury) throw new Error("Start the stack with --treasury");
  return { directory, origin: new URL(state.treasury.machineBase).origin, agent: state.treasury.agent, ca: join(directory, "environment", "localhost.crt") };
}

/**
 * Starts a fresh stack with the Treasury agent from a platform checkout at `PLATFORM_COMMIT` with its dependencies
 * installed (`../platform` by default, or TREASURY_PLATFORM), as the platform's own specs do, and answers it with a
 * `stop` that ends it. `args` are the stack's other flags: without a browser by default, or `--frontend <dist>` to serve
 * an owner build in the stack's browser, whose owner page starts signed in (`state().cdp` attaches to it).
 */
export async function startStack({ args = ["--no-browser"], platform = process.env.TREASURY_PLATFORM ?? join(import.meta.dirname, "..", "..", "platform") }: { args?: string[]; platform?: string } = {}) {
  const head = execFileSync("git", ["-C", platform, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!head.startsWith(PLATFORM_COMMIT)) throw new Error(`Check out ${PLATFORM_COMMIT} in ${platform} (it's at ${head.slice(0, 7)})`);
  // Inside the platform checkout, as its own runs are: the stack's agents resolve their dependencies from there.
  mkdirSync(join(platform, ".test-artifacts"), { recursive: true });
  const artifacts = mkdtempSync(join(platform, ".test-artifacts", "treasury-stack-")), directory = join(artifacts, "stack");
  const child = spawn(process.execPath, [join(platform, "test", "e2e", "stack.mjs"), "--treasury", ...args],
    { cwd: platform, env: { ...process.env, PROTO_E2E_ARTIFACTS: artifacts }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  const stop = async () => {
    if (child.exitCode === null) writeFileSync(join(directory, "stop"), "");
    const code = await Promise.race([exited, delay(30_000, "timeout" as const)]);
    if (code === "timeout") child.kill("SIGTERM");
  };
  for (let waited = 0; !output.includes("Isolated stack ready"); waited += 250) {
    if (child.exitCode !== null || waited > 120_000) {
      await stop();
      throw new Error(`The stack didn't start:\n${output.slice(-2_000)}`);
    }
    await delay(250);
  }
  const state = () => JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as { cdp: string | null; dashboard: string; ownerAccount: string };
  return { target: stack(directory), state, stop };
}

let sequence = 0;
/** One control file, written whole, and its answer. The answer is reduced to `{ ok }` on disk once read. */
async function control<T>({ directory }: Stack, command: Record<string, unknown>): Promise<T> {
  const name = `treasury-${process.pid}-${Date.now()}-${++sequence}`, request = join(directory, "controls", `${name}.json`), answer = join(directory, "controls", `${name}.result.json`);
  writeFileSync(`${request}.tmp`, JSON.stringify(command));
  renameSync(`${request}.tmp`, request);
  for (let waited = 0; !existsSync(answer); waited += 250) {
    if (waited > 15_000) throw new Error(`The stack did not answer ${command.command}`);
    await delay(250);
  }
  const result = JSON.parse(readFileSync(answer, "utf8")) as { ok: true; value: T } | { ok: false; error: string };
  writeFileSync(answer, JSON.stringify({ ok: result.ok }));
  if (!result.ok) throw new Error(`${command.command} failed: ${result.error}`);
  return result.value;
}

/** The platform's credential lifetimes (`src/gateway/machine-auth.ts` at 766b3f3). */
export const TTL = { min: 60, max: 86_400 } as const;

/** The owner issues a `portfolio` machine credential for the role, with its scopes, as on its access page. Returns the token. */
export async function issue(target: Stack, role: Role, ttlSeconds: number): Promise<string> {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < TTL.min || ttlSeconds > TTL.max)
    throw new Error(`ttlSeconds must be an integer from ${TTL.min} to ${TTL.max}`);
  return (await control<{ token: string }>(target, { command: "machineCredential", label: `treasury ${role}`, scopes: ROLES[role].scopes, ttlSeconds })).token;
}

/** The owner saves `portfolio`'s targets through `strategy/save`, which turns autopilot off. Answers the strategy's digest. */
export async function setTargets(target: Stack, targetBps: Record<string, number>): Promise<string> {
  return (await control<{ digest: string }>(target, { command: "setTargets", targetBps })).digest;
}

/** Funds arriving on `portfolio`'s public balance (raw units), outside a confidential deposit: what a sweep shields. */
export const fundPublic = (target: Stack, asset: string, amount: string) => control(target, { command: "fundPublic", asset, amount });

/** `portfolio`'s provider applies its next swap but loses the reply: an `unknown` the agent must reconcile. */
export const dropSwapResponse = (target: Stack) => control(target, { command: "dropSwapResponse" });

/** An outage of `portfolio`'s provider only. */
export const setUnavailable = (target: Stack, value: boolean) => control(target, { command: "setUnavailable", agent: "portfolio", value });
