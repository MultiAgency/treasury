import { test } from "node:test";
import assert from "node:assert/strict";
import { standInKeyLookup, type KeyLookup } from "../src/keys.ts";
import { createSignIn } from "../src/signin.ts";
import { HOST, wallet } from "./fakes.ts";

const owner = wallet("owner.near");
const setup = (keyLookup: KeyLookup = standInKeyLookup({ "owner.near": [owner.publicKey] }), clock = { now: Date.now() }) => {
  const lookups: string[] = [];
  const signIn = createSignIn({
    recipient: HOST, ttlMs: 5 * 60_000, perMinute: 3, now: () => clock.now,
    keyLookup: async (account, key) => { lookups.push(account); return keyLookup(account, key); },
  });
  const challenge = () => { const issued = signIn.challenge("client"); assert.ok(issued.ok); return issued.value; };
  return { signIn, challenge, lookups, clock };
};

test("a challenge names this server as the recipient, and a full-access key's signature over it signs in", async () => {
  const { signIn, challenge } = setup();
  const issued = challenge();
  assert.equal(issued.recipient, HOST);
  assert.deepEqual(await signIn.verify(owner.sign(issued)), { ok: true, account: "owner.near" });
});

test("a challenge is spent by its first use, whatever that use's outcome", async () => {
  const { signIn, challenge } = setup();
  const issued = challenge();
  assert.equal((await signIn.verify(owner.sign(issued))).ok, true);
  assert.deepEqual(await signIn.verify(owner.sign(issued)), { ok: false, kind: "refused", code: "unknown_challenge" });
  const failed = challenge();
  await signIn.verify(owner.sign(failed, { message: "something else" }));
  assert.deepEqual(await signIn.verify(owner.sign(failed)), { ok: false, kind: "refused", code: "unknown_challenge" });
});

test("a challenge this server never issued is refused", async () => {
  const { signIn } = setup();
  const forged = { message: `Sign in to the Treasury app at ${HOST}`, recipient: HOST, nonce: Buffer.alloc(32, 7).toString("base64") };
  assert.deepEqual(await signIn.verify(owner.sign(forged)), { ok: false, kind: "refused", code: "unknown_challenge" });
});

test("an expired challenge is refused", async () => {
  const { signIn, challenge, clock } = setup();
  const issued = challenge();
  clock.now += 5 * 60_000;
  assert.deepEqual(await signIn.verify(owner.sign(issued)), { ok: false, kind: "refused", code: "expired" });
});

test("a tampered message or a wrong recipient fails the signature, with no chain lookup", async () => {
  const { signIn, challenge, lookups } = setup();
  assert.deepEqual(await signIn.verify(owner.sign(challenge(), { message: "Send everything" })), { ok: false, kind: "refused", code: "bad_signature" });
  assert.deepEqual(await signIn.verify(owner.sign(challenge(), { recipient: "platform.test" })), { ok: false, kind: "refused", code: "bad_signature" });
  const issued = challenge();
  assert.deepEqual(await signIn.verify({ ...owner.sign(issued), publicKey: wallet("x.near").publicKey }), { ok: false, kind: "refused", code: "bad_signature" });
  assert.deepEqual(lookups, [], "a bad signature costs no RPC call");
});

test("a key that isn't a full-access key of the signing account is refused", async () => {
  const { signIn, challenge } = setup(async () => "limited");
  assert.deepEqual(await signIn.verify(owner.sign(challenge())), { ok: false, kind: "refused", code: "not_full_access" });
  const other = setup(async () => "none");
  assert.deepEqual(await other.signIn.verify(owner.sign(other.challenge())), { ok: false, kind: "refused", code: "not_full_access" });
});

test("a chain that doesn't answer makes sign-in unavailable, not refused", async () => {
  const { signIn, challenge } = setup(async () => "unavailable");
  assert.deepEqual(await signIn.verify(owner.sign(challenge())), { ok: false, kind: "unavailable" });
});

test("challenges are rate-limited per client and minute", () => {
  const { signIn, clock } = setup();
  for (let i = 0; i < 3; i++) assert.equal(signIn.challenge("a").ok, true);
  assert.deepEqual(signIn.challenge("a"), { ok: false, kind: "refused", code: "rate_limited" });
  assert.equal(signIn.challenge("b").ok, true, "another client isn't affected");
  clock.now += 60_001;
  assert.equal(signIn.challenge("a").ok, true, "the window moves on");
});

test("outstanding challenges are capped overall, however many addresses ask", () => {
  const signIn = createSignIn({ recipient: HOST, ttlMs: 5 * 60_000, perMinute: 10, maxOutstanding: 3, keyLookup: async () => "full" });
  for (const client of ["a", "b", "c"]) assert.equal(signIn.challenge(client).ok, true);
  assert.deepEqual(signIn.challenge("d"), { ok: false, kind: "refused", code: "too_many_challenges" });
});
