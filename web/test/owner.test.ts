import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { agent, failureKind, PlatformError, type Setup } from "../src/platform.ts";
import { CONFIRM_GRACE_MS, runOwnerAction, type Progress, type Wallets } from "../src/features/owner/owner-flow.ts";
import { awaitingOutcome, observeOwnerAction } from "../src/features/owner/owner-observation.ts";

type State = { stage: string; status?: string };
/** A status read answering each of `answers` in turn: a state, or a failure to throw. */
const reader = (...answers: (State | Error)[]) => {
  let reads = 0;
  return { read: async () => { const answer = answers[reads++]; if (!answer) throw new Error("read past the end"); if (answer instanceof Error) throw answer; return answer; },
    get reads() { return reads; } };
};
const lostRead = () => new PlatformError({ ok: false, kind: "unavailable" });

test("an owner action is observed while it is submitting, until it settles", async () => {
  const status = reader({ stage: "submitting" }, { stage: "submitting" }, { stage: "submitted", status: "SUCCESS" });
  const seen: string[] = [];
  const state = await observeOwnerAction(status.read, new AbortController().signal, s => seen.push(s.stage), 1);
  assert.deepEqual(state, { stage: "submitted", status: "SUCCESS" });
  assert.deepEqual(seen, ["submitting", "submitting", "submitted"]);
});

test("a lost status answer is read again: it neither ends the observation nor decides it", async () => {
  const status = reader({ stage: "submitting" }, lostRead(), lostRead(), { stage: "submitted", status: "SUCCESS" });
  assert.deepEqual(await observeOwnerAction(status.read, new AbortController().signal, undefined, 1), { stage: "submitted", status: "SUCCESS" });
  assert.equal(status.reads, 4);
});

test("any other failed status read ends the observation with that failure", async () => {
  const refused = new PlatformError({ ok: false, kind: "refused", error: "Unknown intent" });
  const status = reader({ stage: "submitting" }, refused);
  await assert.rejects(observeOwnerAction(status.read, new AbortController().signal, undefined, 1), refused);
});

test("an observation stops when it is aborted, without reading again", async () => {
  const controller = new AbortController();
  const status = reader({ stage: "submitting" }, { stage: "submitting" });
  const observed = observeOwnerAction(status.read, controller.signal, () => controller.abort(), 60_000);
  await assert.rejects(observed);
  assert.equal(status.reads, 1);
});

test("an earlier action blocks another while its outcome is pending: submitted, or a DAO proposal awaiting its vote", () => {
  const record = (type: string, stage: string, signer = "wallet") => ({ type, stage, signer, correlationId: `${type}-${stage}-${signer}`, expiresAt: "2030-01-01T00:00:00Z" });
  const freezes = ["agent_freeze", "agent_unfreeze"];
  assert.equal(awaitingOutcome([record("agent_freeze", "submitted")], freezes)?.stage, "submitted");
  assert.equal(awaitingOutcome([record("agent_unfreeze", "prepared", "dao")], freezes)?.signer, "dao");
  // Prepared for a wallet that never signed, closed, or settled: nothing is pending.
  for (const [stage, signer] of [["prepared", "wallet"], ["expired", "dao"], ["settled", "dao"], ["settled", "wallet"]])
    assert.equal(awaitingOutcome([record("agent_freeze", stage!, signer)], freezes), undefined, `${stage} ${signer}`);
  assert.equal(awaitingOutcome([record("grant_issue", "submitted")], freezes), undefined, "another kind of action");
});

test("a wallet policy update only prepared blocks another until its window and the grace past it close: the confirm page can still sign it", () => {
  const update = (expiresAt: string) => ({ type: "policy_update", stage: "prepared", signer: "wallet", correlationId: "p1", expiresAt });
  const now = Date.parse("2026-11-03T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(awaitingOutcome([update("2026-11-03T12:05:00Z")], ["policy_update"], now)?.correlationId, "p1");
  assert.equal(awaitingOutcome([update(ago(5 * 60_000))], ["policy_update"], now)?.correlationId, "p1",
    "past its window by this page's clock, but inside the grace: this clock may run fast");
  assert.equal(awaitingOutcome([update(ago(CONFIRM_GRACE_MS - 1))], ["policy_update"], now)?.correlationId, "p1");
  assert.equal(awaitingOutcome([update(ago(CONFIRM_GRACE_MS))], ["policy_update"], now), undefined, "its window and the grace have closed");
  assert.equal(awaitingOutcome([update("not a time")], ["policy_update"], now)?.correlationId, "p1", "a window that can't be read is taken as open");
  assert.equal(awaitingOutcome([{ ...update("2026-11-03T12:05:00Z"), type: "grant_revoke" }], ["grant_revoke"], now), undefined,
    "another wallet action only prepared was never signed");
});

// The flow against a fake host: each request the app sent, and the answers given in order.
let sent: string[] = [];
let answers: (() => Response)[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  sent = [];
  answers = [];
  Object.assign(globalThis, { location: new URL("https://treasury.test/a/portfolio/") });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input instanceof URL || typeof input === "string" ? new URL(input, "https://treasury.test") : input, init);
    sent.push(new URL(request.url).pathname.split("/rpc/")[1]!);
    const answer = answers.shift();
    if (!answer) throw new Error(`No answer for ${request.url}`);
    return answer();
  };
});
afterEach(() => { globalThis.fetch = realFetch; });
const json = (body: unknown, status = 200) => () => Response.json(body, { status });
const lost = () => { throw new TypeError("network"); };
const refused = (message: string) => json({ json: { defined: true, code: "BAD_REQUEST", message, data: { kind: "refused" } } }, 400);
/** The owner's recorded actions, read before anything is prepared: none by default. */
const actions = (...records: { type: string; stage: string; signer?: string; expiresAt?: string }[]) => json({ json: records.map((r, i) => ({
  correlationId: `r${i}`, signer: "wallet", expiresAt: "2030-01-01T00:00:00Z", ownerSucceeded: false, status: null, failureCode: null, payment: null, ...r })) });
const none = actions();
const prepared = json({ json: { correlationId: "c1", preview: { summary: "Freeze" }, expiresAt: "2030-01-01T00:00:00Z", digest: null,
  intent: { standard: "nep413", payload: { message: "m", recipient: "r", nonce: "bg==" } } } });

/** Wallets that sign at once and record what they were asked to do. */
const wallet = (overrides: Partial<Wallets> = {}) => {
  const asked: string[] = [];
  const wallets: Wallets = {
    signIntent: async () => { asked.push("sign"); return { signature: "s" }; },
    ownerWallet: async () => ({ type: "near", account_id: "owner.near", public_key: "ed25519:k" }),
    memberConnected: async () => false,
    sendAsMember: async () => { asked.push("sendAsMember"); },
    ensureDao: async () => { asked.push("ensureDao"); },
    sendAsDao: async () => { asked.push("sendAsDao"); },
    ...overrides,
  };
  return { wallets, asked };
};
const quiet: Progress = { step() {}, prepared() {}, confirm() {}, unknown() {} };
const setup = { owner: { type: "near", account_id: "owner.near" }, dao: null } as unknown as Setup;
const daoSetup = { owner: { type: "near", account_id: "dao.near" }, dao: { id: "dao.sputnik-dao.near", owner: { account_id: "dao.near" } } } as unknown as Setup;
const freeze = (wallets: Wallets, extra: Partial<Parameters<typeof runOwnerAction>[0]> = {}) => runOwnerAction({ api: agent("portfolio"), wallets, setup,
  access: { canPropose: false, canVote: false }, action: { type: "agent_freeze" }, signer: "wallet", signal: new AbortController().signal,
  progress: quiet, intervalMs: 1, ...extra });

test("an unknown submit is followed by status; a refused status poll leaves it unknown, and nothing is signed or submitted again", async () => {
  const { wallets, asked } = wallet();
  const told: string[] = [];
  answers.push(none, prepared, lost, refused("Unknown intent"));
  const ended = await freeze(wallets, { progress: { ...quiet, unknown: message => told.push(message) } });
  assert.equal(ended.ok, false);
  assert.ok(!ended.ok && ended.unknown?.startsWith("The outcome is unknown: this owner/submit request may have taken effect."),
    "the outcome stays unknown, so the owner controls stay disabled");
  assert.equal(!ended.ok && failureKind(ended.error), "refused");
  assert.deepEqual(told, [!ended.ok && ended.unknown]);
  assert.deepEqual(sent, ["owner/actions", "owner/prepare", "owner/submit", "owner/status"]);
  assert.deepEqual(asked, ["sign"]);
});

test("an unknown submit settled by a status read ends known: nothing stays unknown", async () => {
  const { wallets } = wallet();
  answers.push(none, prepared, lost, json({ json: { stage: "submitting" } }), json({ json: { stage: "submitted", status: "SUCCESS" } }));
  assert.deepEqual(await freeze(wallets), { ok: true });
  answers.push(none, prepared, lost, json({ json: { stage: "expired" } }));
  const expired = await freeze(wallets);
  assert.ok(!expired.ok && expired.unknown === undefined, "an expired signing window settles it too");
});

test("a refused submit whose status can't be read ends with the refusal itself", async () => {
  const { wallets } = wallet();
  answers.push(none, prepared, refused("Not submitted: signature mismatch"), lost);
  const ended = await freeze(wallets);
  assert.ok(!ended.ok && ended.error instanceof PlatformError && ended.error.failure.kind === "refused");
  assert.equal(!ended.ok && (ended.error as Error).message, "Not submitted: signature mismatch");
  assert.ok(!ended.ok && ended.unknown === undefined);
  assert.deepEqual(sent, ["owner/actions", "owner/prepare", "owner/submit", "owner/status"]);
});

test("a settled status with no status code says the outcome isn't confirmed", async () => {
  const { wallets } = wallet();
  answers.push(none, prepared, lost, json({ json: { stage: "submitted" } }));
  const ended = await freeze(wallets);
  assert.equal(!ended.ok && (ended.error as Error).message, "The owner action’s outcome isn’t confirmed. Check its record before signing again.");
});

test("a DAO proposal: Trezu unless the member may propose with a connected wallet, and nothing is prepared when neither can file", async () => {
  // May propose, but no wallet connected: Trezu files it, and it must connect before anything is prepared.
  const noTrezu = wallet({ ensureDao: async () => { throw new Error("Trezu is connected as other.near, not dao.sputnik-dao.near"); } });
  answers.push(none);
  const ended = await freeze(noTrezu.wallets, { setup: daoSetup, signer: "dao", access: { canPropose: true, canVote: false } });
  assert.equal(!ended.ok && (ended.error as Error).message, "Trezu is connected as other.near, not dao.sputnik-dao.near");
  assert.deepEqual(sent, ["owner/actions"], "no owner/prepare");

  const daoPrepared = json({ json: { correlationId: "d1", preview: { summary: "Freeze" }, expiresAt: "2030-01-01T00:00:00Z", digest: null,
    dao: { owner: "dao.near", transaction: { receiverId: "dao", actions: [] }, proposal: { receiverId: "dao", actions: [] }, proposalAndVote: null } } });
  const member = wallet({ memberConnected: async () => true });
  answers.push(none, daoPrepared, json({ json: { stage: "submitted", status: "SUCCESS" } }));
  assert.deepEqual(await freeze(member.wallets, { setup: daoSetup, signer: "dao", access: { canPropose: true, canVote: false } }), { ok: true });
  assert.deepEqual(member.asked, ["sendAsMember"], "filed from the member's own wallet, without Trezu");
});

test("a member's filing the wallet reports as failed, as a string or an object, filed nothing; one it doesn't report is followed", async () => {
  const daoPrepared = json({ json: { correlationId: "d1", preview: { summary: "Freeze" }, expiresAt: "2030-01-01T00:00:00Z", digest: null,
    dao: { owner: "dao.near", transaction: { receiverId: "dao", actions: [] }, proposal: { receiverId: "dao", actions: [] }, proposalAndVote: null } } });
  const asMember = { setup: daoSetup, signer: "dao" as const, access: { canPropose: true, canVote: false } };
  for (const status of ["Failure", { Failure: { ActionError: {} } }]) {
    sent.length = 0;
    const member = wallet({ memberConnected: async () => true, sendAsMember: async () => ({ status }) });
    answers.push(none, daoPrepared);
    const ended = await freeze(member.wallets, asMember);
    assert.match(!ended.ok ? (ended.error as Error).message : "", /^The transaction failed, so nothing was filed\./, JSON.stringify(status));
    assert.deepEqual(sent, ["owner/actions", "owner/prepare"], "not followed: nothing was filed");
  }
  // Started, but not reported settled: whether it was filed isn't known, so its record is followed, never filed again.
  sent.length = 0;
  const started = wallet({ memberConnected: async () => true, sendAsMember: async () => ({ status: "Started" }) });
  answers.push(none, daoPrepared, json({ json: { stage: "submitted", status: "SUCCESS" } }));
  assert.deepEqual(await freeze(started.wallets, asMember), { ok: true });
  assert.deepEqual(sent, ["owner/actions", "owner/prepare", "owner/status"]);
});

test("a confirm answer: nothing is signed or submitted here; the owner is sent to the confirm page and the action is followed", async () => {
  const { wallets, asked } = wallet();
  const confirming = json({ json: { correlationId: "p1", preview: { summary: "Change the policy" }, expiresAt: "2030-01-01T00:00:00Z", digest: "sha256:d",
    confirm: { url: "https://platform.test/confirm/t1", expiresAt: "2030-01-01T00:00:00Z" } } });
  const steps: string[] = [], pages: string[] = [];
  const progress: Progress = { ...quiet, step: step => steps.push(step), confirm: url => pages.push(url) };
  // Not yet signed on the page, then signed and settling, then settled.
  answers.push(none, confirming, json({ json: { stage: "unknown" } }), json({ json: { stage: "submitting" } }), json({ json: { stage: "submitted", status: "SUCCESS" } }));
  assert.deepEqual(await freeze(wallets, { progress }), { ok: true });
  assert.deepEqual(pages, ["https://platform.test/confirm/t1"]);
  assert.deepEqual(steps, ["preparing", "confirming", "settling"]);
  assert.deepEqual(sent, ["owner/actions", "owner/prepare", "owner/status", "owner/status", "owner/status"], "never owner/submit");
  assert.deepEqual(asked, [], "the wallet signs nothing here");

  // The platform's own end settles it: an expired window, here.
  sent = [];
  answers.push(none, confirming, json({ json: { stage: "unknown" } }), json({ json: { stage: "expired" } }));
  const expired = await freeze(wallets);
  assert.ok(!expired.ok && expired.unknown === undefined && (expired.error as Error).message === "The signing window closed. Review the existing owner action.");
  assert.deepEqual(sent, ["owner/actions", "owner/prepare", "owner/status", "owner/status"]);
});

test("a confirm page that records no signature is read on past its window, by this page's clock; then the outcome stays unknown", async () => {
  const { wallets } = wallet();
  for (const expiresAt of ["2026-11-03T12:05:00Z", "not a time"]) {
    sent = [];
    // Each read is a minute on: past the window and its grace, or an hour for a window that can't be read.
    let clock = Date.parse("2026-11-03T12:00:00Z");
    const now = () => clock;
    const reads = expiresAt === "not a time" ? 60 : 5 + CONFIRM_GRACE_MS / 60_000;
    answers.push(none, json({ json: { correlationId: "p1", preview: { summary: "Change the policy" }, expiresAt, digest: null,
      confirm: { url: "https://platform.test/confirm/t1", expiresAt } } }));
    for (let i = 0; i < reads; i++) answers.push(() => { clock += 60_000; return Response.json({ json: { stage: "unknown" } }); });
    const told: string[] = [];
    const ended = await freeze(wallets, { now, progress: { ...quiet, unknown: message => told.push(message) } });
    assert.ok(!ended.ok && ended.unknown?.startsWith("The confirm page’s outcome isn’t known"), expiresAt);
    assert.deepEqual(told, [!ended.ok && ended.unknown]);
    assert.equal(sent.filter(path => path === "owner/status").length, reads, expiresAt);
    assert.equal(answers.length, 0);
  }
});

test("a recorded action of the same kind whose outcome is pending blocks preparing; a settled one doesn't", async () => {
  const { wallets, asked } = wallet();
  answers.push(actions({ type: "agent_freeze", stage: "submitted" }));
  const held = await freeze(wallets);
  assert.equal(!held.ok && (held.error as Error).message, "An earlier freeze was submitted and its outcome is still being checked. Do not sign again.");
  assert.equal(!held.ok && held.earlier?.correlationId, "r0", "its record is the one to follow");
  assert.deepEqual(sent, ["owner/actions"], "nothing prepared");
  assert.deepEqual(asked, []);

  sent = [];
  answers.push(actions({ type: "agent_freeze", stage: "settled" }, { type: "agent_freeze", stage: "expired", signer: "dao" }, { type: "grant_revoke", stage: "submitted" }),
    prepared, json({ json: { status: "SUCCESS", failureCode: null } }));
  assert.deepEqual(await freeze(wallets), { ok: true });
  assert.deepEqual(sent, ["owner/actions", "owner/prepare", "owner/submit"]);

  // The records can't be read: nothing is prepared.
  sent = [];
  answers.push(lost);
  const unread = await freeze(wallets);
  assert.equal(!unread.ok && (unread.error as Error).message, "The owner actions couldn’t be read, so nothing was prepared. Try again.");
  assert.deepEqual(sent, ["owner/actions"]);
});

test("a lost owner/prepare: a record it left is followed; with none, nothing took effect and it can be prepared again", async () => {
  const { wallets } = wallet();
  answers.push(none, lost, actions({ type: "agent_freeze", stage: "prepared", signer: "dao" }));
  const recorded = await freeze(wallets, { setup: daoSetup, signer: "dao" });
  assert.equal(!recorded.ok && (recorded.error as Error).message, "An earlier freeze was proposed to dao.sputnik-dao.near and awaits its vote. Do not propose again.");
  assert.equal(!recorded.ok && recorded.earlier?.correlationId, "r0");

  sent = [];
  answers.push(none, lost, actions({ type: "agent_freeze", stage: "prepared" }));
  const nothing = await freeze(wallets);
  assert.match(!nothing.ok ? (nothing.error as Error).message : "", /^Preparing was interrupted\. Nothing was signed, so nothing took effect;/);
  assert.ok(!nothing.ok && nothing.earlier === undefined);
  assert.deepEqual(sent, ["owner/actions", "owner/prepare", "owner/actions"]);

  sent = [];
  answers.push(none, lost, lost);
  const unread = await freeze(wallets);
  assert.equal(!unread.ok && (unread.error as Error).message, "Preparing was interrupted, and the owner actions couldn’t be read to see whether it was recorded. Check them before preparing again.");
});
