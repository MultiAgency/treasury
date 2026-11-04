// Opens a visible browser on a running stack's Treasury dashboard, signed in as the owner through the stack's simulated
// wallet. The stack's gateway accepts only that wallet's test key, so a real NEAR wallet in another browser can't sign
// in to it. The stack's own `--headed` window is the same, but once it's closed the stack can't open another.
//
//   node scripts/owner-browser.ts [stack directory]
//
// The stack directory is the one holding `state.json`; by default the newest under the platform's `.test-artifacts`.
// The platform checkout is `../platform`, or TREASURY_PLATFORM. Ctrl-C closes the browser; the stack keeps running.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { get } from "node:https";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const platform = process.env.TREASURY_PLATFORM ?? join(import.meta.dirname, "..", "..", "platform");
const fromPlatform = (path: string) => import(pathToFileURL(join(platform, path)).href);

function newestStack() {
  const artifacts = join(platform, ".test-artifacts");
  const stacks = readdirSync(artifacts).map(name => join(artifacts, name, "stack")).filter(dir => {
    try { return statSync(join(dir, "state.json")).isFile(); } catch { return false; }
  });
  if (!stacks.length) throw new Error(`No running stack under ${artifacts}: start one first`);
  return stacks.sort((a, b) => statSync(join(b, "state.json")).mtimeMs - statSync(join(a, "state.json")).mtimeMs)[0];
}

const directory = process.argv[2] ?? newestStack();
const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as {
  dashboard: string; payee: string; ownerAccount: string; treasury: { agent: string } | null;
};
if (!state.treasury) throw new Error("This stack has no Treasury agent: start it with --treasury");
// The stack's certificate is its own, so this check doesn't verify it: it only asks whether the stack answers.
const running = await new Promise<boolean>(resolve => {
  get(`${state.dashboard}/gw/me`, { rejectUnauthorized: false }, res => { res.resume(); resolve(true); }).on("error", () => resolve(false));
});
if (!running) throw new Error(`The stack at ${state.dashboard} isn't running (${directory})`);

const { chromium } = await fromPlatform("node_modules/playwright/index.mjs");
const { installWallet, connectWallet } = await fromPlatform("test/e2e/wallet.mjs");

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "block", viewport: null });
await installWallet(context, { dashboard: state.dashboard, invoices: new URL(state.payee).origin }, state.ownerAccount);
const page = await context.newPage();
await page.goto(`${state.dashboard}/a/${state.treasury.agent}/`);
await connectWallet(page, state.ownerAccount);
await page.goto(`${state.dashboard}/a/${state.treasury.agent}/`);
console.log(`Signed in as ${state.ownerAccount}: ${page.url()}`);

const close = async () => { await browser.close().catch(() => {}); process.exit(0); };
process.once("SIGINT", close);
process.once("SIGTERM", close);
browser.on("disconnected", () => process.exit(0));
