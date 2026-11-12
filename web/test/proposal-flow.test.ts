import { test } from "node:test";
import assert from "node:assert/strict";
import { proposalText, type ProposalView } from "@multiagency/sdk";
import { checkVerdict } from "../../apps/server/src/proposals.ts";
import { execute, executeOffered, heldAfter, review, shownAfter, signVerdict, verdictOffered, verdictText } from "../src/proposal-flow.ts";
import { proposalsApi, type SignRequest } from "../src/proposals-api.ts";
import { fail, ID, lost, ok, proposal, refused, scripted } from "./proposals-fixtures.ts";

const READ = `GET /api/agents/portfolio/proposals/${ID}`, EXECUTE = `POST /api/agents/portfolio/proposals/${ID}/execute`;
const APPROVE = `POST /api/agents/portfolio/proposals/${ID}/approve`;
const HOST = "platform.test", OWNER = "owner.near", KEY = `ed25519:${"1".repeat(44)}`;
const setup = () => { const server = scripted(); return { server, agent: proposalsApi(server.fetcher).agent("portfolio") }; };
/** A wallet that signs as `account` and records what it was asked to sign. */
const walletFor = (account = OWNER) => {
  const asked: SignRequest[] = [];
  return { asked, sign: async (request: SignRequest) => { asked.push(request); return { accountId: account, publicKey: KEY, signature: "sig" }; } };
};
const read = (view: ProposalView) => ok({ proposal: view });

// The pending rule ----------------------------------------------------------------------------------------------

test("a pending execute is never answered with Execute: the proposal is read, and only that read can offer it again", async () => {
  const { server, agent } = setup();
  server.answer(EXECUTE, ok({ result: "pending", proposal: proposal({ state: "approved" }) }));
  server.answer(READ, read(proposal({ state: "executing" })));
  const running = await execute(agent, ID);
  assert.equal(running.kind, "pending");
  assert.equal(server.routes("POST").length, 1, "one execute, never a second");
  assert.equal(shownAfter(running)!.state, "executing", "the read decides, not the pending answer's own `approved`");
  assert.equal(executeOffered(shownAfter(running)!, heldAfter(running)), false);

  server.answer(EXECUTE, ok({ result: "pending", proposal: proposal({ state: "approved" }) }));
  server.answer(READ, read(proposal({ state: "approved" })));
  const requoting = await execute(agent, ID);
  assert.equal(heldAfter(requoting), false);
  assert.equal(executeOffered(shownAfter(requoting)!, heldAfter(requoting)), true, "a fresh read that still says approved offers it again");
});

test("a pending execute whose read is lost holds Execute, showing nothing as current, until a later read answers", async () => {
  const { server, agent } = setup();
  server.answer(EXECUTE, ok({ result: "pending", proposal: proposal({ state: "approved" }) }));
  server.answer(READ, lost);
  const execution = await execute(agent, ID);
  assert.equal(heldAfter(execution), true);
  assert.equal(shownAfter(execution), null, "the pending answer's `approved` isn't shown as current");
  assert.equal(executeOffered(proposal({ state: "approved" }), heldAfter(execution)), false, "the page's last read says approved, and it stays held");
  assert.equal(executeOffered(proposal({ state: "approved" }), false), true, "released by a read that answers");
});

test("an execute whose answer was lost, or unanswered, is treated as pending: read, never sent again", async () => {
  for (const answer of [lost, fail({ kind: "unavailable" }, 503), () => new Response("upstream timeout", { status: 504 })]) {
    const { server, agent } = setup();
    server.answer(EXECUTE, answer);
    server.answer(READ, read(proposal({ state: "unknown" })));
    const execution = await execute(agent, ID);
    assert.equal(execution.kind, "pending");
    assert.equal(server.routes("POST").length, 1);
    assert.equal(executeOffered(shownAfter(execution)!, heldAfter(execution)), false);
  }
});

test("final answers are decided by what the proposal reports; not_executable stays approved and offers Execute again", async () => {
  const { server, agent } = setup();
  server.answer(EXECUTE,
    ok({ result: "final", proposal: proposal({ state: "executed", operations: [{ method: "swap", status: "SUCCESS", correlationId: "c1", refused: null }] }) }),
    ok({ result: "final", proposal: proposal({ state: "stopped", operations: [{ method: "swap", status: "SUCCESS", correlationId: "c1", refused: null }, { method: "swap", status: "NOT_SENT", correlationId: null, refused: "cost" }] }) }),
    ok({ result: "final", proposal: proposal({ state: "stopped", reason: "price moved", operations: [{ method: "swap", status: "NOT_SENT", correlationId: null, refused: "floor" }] }) }),
    ok({ result: "not_executable", proposal: proposal({ state: "approved" }) }));
  const executed = await execute(agent, ID), partial = await execute(agent, ID), unsent = await execute(agent, ID), refusedFirst = await execute(agent, ID);
  assert.deepEqual(executed.kind === "final" && executed.outcome, { ok: true });
  assert.equal(partial.kind === "final" && !partial.outcome.ok && partial.outcome.kind, "partial", "a stopped proposal may have run a swap");
  assert.deepEqual(unsent.kind === "final" && unsent.outcome, { ok: false, kind: "refused", code: "NOT_SENT", error: "price moved" });
  assert.equal(refusedFirst.kind, "not_executable");
  assert.equal(executeOffered(shownAfter(refusedFirst)!, heldAfter(refusedFirst)), true, "nothing was sent, and it may be tried again");
  for (const execution of [executed, partial, unsent]) assert.equal(executeOffered(shownAfter(execution)!, heldAfter(execution)), false);
  assert.equal(server.routes("GET").length, 0, "the server's answer already carries its read");
});

test("not_approved reads the proposal again; not_connected asks to connect and reads nothing", async () => {
  const { server, agent } = setup();
  server.answer(EXECUTE, refused("not_approved"), refused("not_connected"));
  server.answer(READ, read(proposal({ state: "proposed" })));
  const notApproved = await execute(agent, ID);
  assert.equal(notApproved.kind === "refused" && notApproved.read?.ok, true);
  assert.equal(shownAfter(notApproved)!.state, "proposed");
  const notConnected = await execute(agent, ID);
  assert.deepEqual(notConnected, { kind: "refused", failure: { ok: false, kind: "refused", code: "not_connected" } });
  assert.equal(shownAfter(notConnected), null);
});

// Verdicts --------------------------------------------------------------------------------------------------------

test("the text shown is the text signed, byte for byte the SDK's, and the server's own check accepts it", async () => {
  for (const verdict of ["approve", "reject"] as const) {
    const { server, agent } = setup();
    const view = proposal();
    server.answer(READ, read(view), read(view));
    server.answer(`POST /api/agents/portfolio/proposals/${ID}/${verdict}`, read(proposal({ state: verdict === "approve" ? "approved" : "rejected" })));
    const shown = await review(agent, ID, verdict);
    assert.equal(shown.kind === "review" && shown.text, proposalText(view, verdict));
    const wallet = walletFor();
    const outcome = await signVerdict({ api: agent, id: ID, verdict, shown: verdictText(view, verdict), owner: OWNER, host: HOST, sign: wallet.sign });
    assert.equal(outcome.kind, "done");
    assert.equal(wallet.asked.length, 1);
    const [asked] = wallet.asked;
    assert.equal(asked!.message, verdictText(view, verdict), "the wallet signs exactly what was shown");
    assert.equal(asked!.recipient, HOST, "for the platform's host");
    assert.equal(Buffer.from(asked!.nonce, "base64").length, 32);
    const body = JSON.parse(server.sent.at(-1)!.body);
    assert.deepEqual(body, { message: asked!.message, nonce: asked!.nonce, publicKey: KEY, signature: "sig" }, "the signed body, relayed unchanged");
    assert.deepEqual(checkVerdict(body.message, view, verdict), { ok: true }, "the server relays exactly this text");
    assert.equal(server.routes("GET").length, 2, "read to review, and again right before the wallet signs");
  }
});

test("a proposal that changed before the wallet signs isn't signed: the new text is shown instead", async () => {
  const { server, agent } = setup();
  const before = proposal(), after = proposal({ policyRevision: 4 });
  server.answer(READ, read(after));
  const wallet = walletFor();
  const outcome = await signVerdict({ api: agent, id: ID, verdict: "approve", shown: verdictText(before, "approve"), owner: OWNER, host: HOST, sign: wallet.sign });
  assert.equal(outcome.kind, "changed");
  assert.equal(outcome.kind === "changed" && outcome.text, proposalText(after, "approve"));
  assert.deepEqual(wallet.asked, [], "nothing was signed");
  assert.equal(server.routes("POST").length, 0);
});

test("nothing is signed for a proposal no longer open or past its time, and a signature from another account isn't relayed", async () => {
  for (const view of [proposal({ state: "approved" }), proposal({ expiresAt: new Date(Date.now() - 1).toISOString() })]) {
    const { server, agent } = setup();
    server.answer(READ, read(view));
    const wallet = walletFor();
    assert.equal((await signVerdict({ api: agent, id: ID, verdict: "approve", shown: verdictText(proposal(), "approve"), owner: OWNER, host: HOST, sign: wallet.sign })).kind, "closed");
    assert.deepEqual(wallet.asked, []);
    assert.equal(verdictOffered(view), false);
  }
  const { server, agent } = setup();
  server.answer(READ, read(proposal()));
  const outcome = await signVerdict({ api: agent, id: ID, verdict: "approve", shown: verdictText(proposal(), "approve"), owner: OWNER, host: HOST, sign: walletFor("someone.near").sign });
  assert.deepEqual(outcome, { kind: "wrong_account", signer: "someone.near" });
  assert.equal(server.routes("POST").length, 0);
});

test("after a refusal that relayed nothing the proposal is read again; a bad signature may be signed again, unread", async () => {
  for (const code of ["not_this_text", "not_open", "expired"]) {
    const { server, agent } = setup();
    server.answer(READ, read(proposal()), read(proposal({ state: "expired" })));
    server.answer(APPROVE, refused(code));
    const outcome = await signVerdict({ api: agent, id: ID, verdict: "approve", shown: verdictText(proposal(), "approve"), owner: OWNER, host: HOST, sign: walletFor().sign });
    assert.equal(outcome.kind === "refused" && outcome.read?.ok && outcome.read.value.proposal.state, "expired", code);
  }
  const { server, agent } = setup();
  server.answer(READ, read(proposal()));
  server.answer(APPROVE, refused("signature_invalid", 400));
  const outcome = await signVerdict({ api: agent, id: ID, verdict: "approve", shown: verdictText(proposal(), "approve"), owner: OWNER, host: HOST, sign: walletFor().sign });
  assert.deepEqual(outcome, { kind: "refused", failure: { ok: false, kind: "refused", code: "signature_invalid" } });
  assert.equal(server.routes("GET").length, 1);
});

test("a verdict whose answer was lost is the owner's own once a read shows it, and otherwise left to that read", async () => {
  const { server, agent } = setup();
  server.answer(READ, read(proposal()), read(proposal({ state: "approved" })), read(proposal()), read(proposal()));
  server.answer(APPROVE, lost, fail({ kind: "unavailable" }, 503));
  const recorded = await signVerdict({ api: agent, id: ID, verdict: "approve", shown: verdictText(proposal(), "approve"), owner: OWNER, host: HOST, sign: walletFor().sign });
  assert.equal(recorded.kind, "done", "your approval, not someone else's change");
  const unrecorded = await signVerdict({ api: agent, id: ID, verdict: "approve", shown: verdictText(proposal(), "approve"), owner: OWNER, host: HOST, sign: walletFor().sign });
  assert.equal(unrecorded.kind === "refused" && unrecorded.read?.ok && unrecorded.read.value.proposal.state, "proposed");
});
