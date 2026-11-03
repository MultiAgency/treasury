// The CLI end to end on a fresh simulated stack, started from the platform at 1a7fe98 and stopped afterwards:
// `pnpm test:stack`. Each role's credential is issued by the owner through the stack's control and kept in this process.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { ROLES, type Role } from "../src/config.ts";
import { authorizeStrategy, dropSwapResponse, ETH, fundPublic, issue, setTargets, setUnavailable, startStack, USDC, WNEAR, type Stack } from "../scripts/stack.ts";

let target: Stack, stop: () => Promise<void>;
const tokens = {} as Record<Role, string>;

type Holding = { asset: string; public: string; confidential: string };

before(async () => {
  ({ target, stop } = await startStack());
  for (const role of ["propose", "execute", "sweep"] as const) tokens[role] = await issue(target, role, 600);
  // The stack starts with 100 USDC, so these targets ask for a USDC → wNEAR and a USDC → ETH leg of $20 each.
  const digest = await setTargets(target, { [USDC]: 6_000, [WNEAR]: 2_000, [ETH]: 2_000 });
  // The execute credential's plans run only while the owner's grant binds the saved strategy.
  assert.equal(await authorizeStrategy(target), digest);
}, { timeout: 180_000 });

after(() => stop?.());

/** Runs the CLI with stdin that isn't a terminal; its output is a sequence of JSON values. */
function treasury(args: string[], credentials: Partial<Record<Role, string>> = tokens) {
  const env = { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: target.ca, TREASURY_ORIGIN: target.origin, TREASURY_AGENT: target.agent,
    ...Object.fromEntries(Object.entries(credentials).map(([role, token]) => [ROLES[role as Role].token, token])) };
  const run = spawnSync(process.execPath, ["src/cli.ts", ...args], { env, encoding: "utf8", input: "" });
  for (const token of Object.values(tokens)) assert.ok(!run.stdout.includes(token) && !run.stderr.includes(token), "no token is printed");
  const values = run.stdout.trim() ? run.stdout.trim().split(/\n(?=[{[])/).map(text => JSON.parse(text)) : [];
  return { code: run.status, values, outcome: values.find(value => value.outcome)?.outcome, recorded: values.find(value => value.recorded)?.recorded, stderr: run.stderr };
}

const report = () => treasury(["status"]).values[0];
const activity = () => report().activity.value as { planId?: string; status?: string }[];
const holding = (asset: string) => (report().overview.value.book as Holding[]).find(h => h.asset === asset)!;
const proposeSwap = () => treasury(["plan", "swap", USDC, WNEAR, "1000000"]).values[0].id as string;

test("the agent proposes a rebalance; the owner's approval executes it once", () => {
  const plan = treasury(["plan"]);
  assert.equal(plan.code, 0, plan.stderr);
  const saved = plan.values.find(value => value.type === "saved");
  assert.deepEqual(saved?.plan.actions.map((action: { to: string }) => action.to).sort(), [ETH, WNEAR].sort());
  const planId: string = saved.plan.id;

  const unconfirmed = treasury(["execute", planId]);
  assert.deepEqual([unconfirmed.code, unconfirmed.outcome.kind], [2, "refused"]);
  assert.ok(!activity().some(row => row.planId === planId), "nothing was sent without the owner's confirmation");

  const executed = treasury(["execute", planId, "--yes"]);
  assert.equal(executed.code, 0, JSON.stringify(executed.values));
  assert.deepEqual(executed.values.filter(value => value.type === "action").map(value => value.status), ["SUCCESS", "SUCCESS"]);
  assert.equal(activity().filter(row => row.planId === planId && row.status === "SUCCESS").length, 2);

  const again = treasury(["execute", planId, "--yes"]);
  assert.equal(again.code, 2, "a saved plan executes at most once");
  assert.equal(activity().filter(row => row.planId === planId).length, 2);
});

test("a swap the agent won't plan is refused with its reason, and nothing is read or sent", () => {
  // More USDC than the agent holds: `externalPlan` refuses it with a reason (since 766b3f3, not an unknown outcome).
  const refused = treasury(["plan", "swap", USDC, ETH, "1000000000000000"]);
  assert.deepEqual([refused.code, refused.outcome.kind], [2, "refused"], JSON.stringify(refused.values));
  assert.ok(refused.outcome.error, "the reason is printed");
  assert.equal(refused.recorded, undefined, "a refusal reads no records");
});

test("each credential reaches only its scopes", () => {
  const planId = proposeSwap();
  const forbidden = treasury(["execute", planId, "--yes"], { propose: tokens.propose, execute: tokens.propose });
  assert.deepEqual([forbidden.code, forbidden.outcome.kind], [2, "forbidden"], "preparing doesn't permit executing");
  const unread = treasury(["sweep"], { propose: tokens.propose, sweep: tokens.execute });
  assert.deepEqual([unread.code, unread.outcome.kind], [2, "forbidden"], "executing a plan doesn't permit sweeping");
  assert.ok(!activity().some(row => row.planId === planId));
});

test("a sweep shields a public balance, with the owner's confirmation", async () => {
  await fundPublic(target, WNEAR, "5000000000000000000000000");
  const preview = treasury(["sweep"]);
  assert.equal(preview.code, 0);
  assert.deepEqual(preview.values[0].exposed.map((h: Holding) => [h.asset, h.public]), [[WNEAR, "5000000000000000000000000"]]);
  assert.equal(treasury(["sweep", "--execute"]).code, 2, "nothing is shielded without confirmation");

  const swept = treasury(["sweep", "--execute", "--yes"]);
  assert.equal(swept.code, 0, JSON.stringify(swept.values));
  assert.deepEqual(swept.values.filter(value => value.type === "shield").map(value => [value.asset, value.status]), [[WNEAR, "SUCCESS"]]);
  assert.equal(holding(WNEAR).public, "0", "nothing is left public");
});

test("an outage of the agent's provider: the gateway answers forbidden, and nothing is sent", async () => {
  const planId = proposeSwap();
  await setUnavailable(target, true);
  try {
    // The gateway re-checks the agent's identity with the provider on every call; unanswered, it refuses with 403
    // before forwarding, so an outage reads as `forbidden` on the machine route.
    const status = treasury(["status"]);
    assert.equal(status.code, 2);
    for (const read of ["overview", "unresolved", "activity"]) assert.equal(status.values[0][read].kind, "forbidden", read);
    const executed = treasury(["execute", planId, "--yes"]);
    assert.deepEqual([executed.code, executed.outcome.kind, executed.outcome.source], [2, "forbidden", "gateway"]);
  } finally {
    await setUnavailable(target, false);
  }
  assert.ok(!activity().some(row => row.planId === planId), "nothing was sent during the outage");
});

// Last: the unresolved operation it leaves blocks every later money action until the owner's `recover`.
test("a lost swap reply: unknown, records read, applied once and never resent", async () => {
  const planId = proposeSwap(), before = BigInt(holding(USDC).confidential);
  await dropSwapResponse(target);
  const executed = treasury(["execute", planId, "--yes"]);
  assert.deepEqual([executed.code, executed.outcome.kind], [3, "unknown"], JSON.stringify(executed.values));
  assert.equal(executed.recorded?.unresolved.value.length, 1, "unresolved was read and lists the operation");

  // How it settled: the swap was applied exactly once, and stays unresolved, so nothing new is sent meanwhile.
  assert.equal(before - BigInt(holding(USDC).confidential), 1_000_000n, "applied once");
  assert.equal(treasury(["execute", proposeSwap(), "--yes"]).outcome.kind, "unresolved");
});
