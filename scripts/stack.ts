// The platform's simulated stack (`pnpm test:e2e:stack --no-browser --treasury` at 2223d11), through its state file and
// control files only: never through its internals.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** The platform commit the stack runs from: the one `@multiagency/sdk` 0.5.1 was published from (tag `sdk-v0.5.1`). */
export const PLATFORM_COMMIT = "2223d11";

export const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const WNEAR = "nep141:wrap.near";
export const ETH = "nep141:eth.omft.near";

export type Stack = { directory: string; origin: string; agent: string; ca: string };

export function stack(directory: string): Stack {
  const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as { dashboard: string; treasury?: { agent: string } };
  if (!state.treasury) throw new Error("Start the stack with --treasury");
  return { directory, origin: new URL(state.dashboard).origin, agent: state.treasury.agent, ca: join(directory, "environment", "localhost.crt") };
}

/**
 * Starts a fresh stack with the Treasury agent from a platform checkout at `PLATFORM_COMMIT` with its dependencies
 * installed (`../platform` by default, or TREASURY_PLATFORM), as the platform's own specs do, and answers it with a
 * `stop` that ends it. `args` are the stack's other flags: without a browser by default, or `--frontend <dist>` to serve
 * an owner build in the stack's browser, whose owner page starts signed in (`state().cdp` attaches to it).
 * `appCredential` runs the platform's operator command for app credentials (`pnpm app-credential …`) in the stack's
 * gateway, as the stack itself does to issue its first: `issue`, `list` or `revoke`.
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
  const state = () => JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as {
    cdp: string | null; dashboard: string; ownerAccount: string; testPublicKey: string;
    treasury: { agent: string; agentId: string };
    /** With `--app <deployment>`: the app's base and the 0600 file holding its `tap_` credential. */
    app: { deployment: string; base: string; credentialFile: string } | null;
  };
  const appCredential = (...command: string[]) => execFileSync(process.execPath, ["--import", "tsx", join(platform, "src", "app-credential.ts"), ...command],
    { cwd: join(directory, "environment", "gateway"), encoding: "utf8", env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS } });
  return { target: stack(directory), state, stop, appCredential };
}

/** A fetch that trusts only the running stack's own certificate (`Stack.ca`): what a server on the app route calls it with. */
export const stackFetch = (ca: Buffer): typeof fetch => async (input, init) => new Promise((resolve, reject) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const req = request(url, { method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers)), ca, signal: init?.signal ?? undefined }, res => {
    const chunks: Buffer[] = [];
    res.on("data", chunk => chunks.push(chunk));
    res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers as Record<string, string> })));
  });
  req.on("error", reject);
  req.end(init?.body as string | undefined);
});

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

/** The owner saves `portfolio`'s targets through `strategy/save`, which turns autopilot off. Answers the strategy's digest. */
export async function setTargets(target: Stack, targetBps: Record<string, number>): Promise<string> {
  return (await control<{ digest: string }>(target, { command: "setTargets", targetBps })).digest;
}

/**
 * The owner signs a grant bound to `portfolio`'s saved strategy, which turning autopilot on and an app's `executePlan`
 * need (the platform's `src/strategy-readiness.ts`, `src/planning/strategy-grant.ts`). Saving the strategy again unbinds it. Answers the digest the grant binds.
 */
export async function authorizeStrategy(target: Stack): Promise<string> {
  return (await control<{ digest: string }>(target, { command: "authorizeStrategy" })).digest;
}

/** Funds arriving on `portfolio`'s public balance (raw units), outside a confidential deposit: what a sweep shields. */
export const fundPublic = (target: Stack, asset: string, amount: string) => control(target, { command: "fundPublic", asset, amount });

/** `portfolio`'s provider applies its next swap but loses the reply: an `unknown` the agent must reconcile. */
export const dropSwapResponse = (target: Stack) => control(target, { command: "dropSwapResponse" });

/** An outage of `portfolio`'s provider only. */
export const setUnavailable = (target: Stack, value: boolean) => control(target, { command: "setUnavailable", agent: "portfolio", value });

/** `portfolio`'s provider accepts the owner's next signature but loses the reply, and withholds the owner outcome: an `unknown` submission. */
export const dropSignatureResponse = (target: Stack) => control(target, { command: "dropSignatureResponse", agent: "portfolio" });

/** `portfolio`'s provider answers owner outcomes again, after `dropSignatureResponse`. */
export const revealOwnerOutcome = (target: Stack) => control(target, { command: "revealOwnerOutcome", agent: "portfolio" });

/** The owner signs a NEP-413 message, as their wallet would for an app; answers the signing account, key and signature. */
export const signOwner = (target: Stack, payload: { message: string; recipient: string; nonce: string }) =>
  control<{ accountId: string; publicKey: string; signature: string }>(target, { command: "signOwner", ...payload });
