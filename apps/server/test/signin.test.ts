import { test } from "node:test";
import assert from "node:assert/strict";
import { standInKeyLookup, type KeyLookup } from "../src/keys.ts";
import { clientKey, createSignIn } from "../src/signin.ts";
import { HOST, wallet } from "./fakes.ts";

const owner = wallet("owner.near");
const setup = (keyLookup: KeyLookup = standInKeyLookup({ "owner.near": [owner.publicKey] }), clock = { now: Date.now() }, perMinute = 10) => {
  const lookups: string[] = [];
  const signIn = createSignIn({
    recipient: HOST, ttlMs: 5 * 60_000, perMinute, now: () => clock.now,
    keyLookup: async (account, key) => { lookups.push(account); return keyLookup(account, key); },
  });
  const challenge = () => { const issued = signIn.challenge("client"); assert.ok(issued.ok); return issued.value; };
  return { signIn, challenge, lookups, clock };
};

test("a challenge names this server as the recipient, and a full-access key's signature over it signs in", async () => {
  const { signIn, challenge } = setup();
  const issued = challenge();
  assert.equal(issued.recipient, HOST);
  assert.deepEqual(await signIn.verify("client", owner.sign(issued)), { ok: true, account: "owner.near" });
});

test("a challenge is spent by its first valid signature, even by two uses at once; a bad signature doesn't spend it", async () => {
  const { signIn, challenge } = setup();
  const issued = challenge();
  assert.equal((await signIn.verify("client", owner.sign(issued))).ok, true);
  assert.deepEqual(await signIn.verify("client", owner.sign(issued)), { ok: false, kind: "refused", code: "unknown_challenge" });
  const raced = owner.sign(challenge());
  const answers = await Promise.all([signIn.verify("client", raced), signIn.verify("client", raced)]);
  assert.equal(answers.filter(answer => answer.ok).length, 1, "one signature signs in once");
  const kept = challenge();
  assert.equal((await signIn.verify("client", owner.sign(kept, { message: "something else" }))).ok, false);
  assert.equal((await signIn.verify("client", owner.sign(kept))).ok, true, "a bad signature didn't spend it");
});

test("a challenge this server never issued, or one altered, is refused", async () => {
  const { signIn, challenge } = setup();
  const unknown = { ok: false, kind: "refused", code: "unknown_challenge" };
  const forged = { message: `Sign in to the Treasury app at ${HOST}`, recipient: HOST, nonce: Buffer.alloc(32, 7).toString("base64") };
  assert.deepEqual(await signIn.verify("client", owner.sign(forged)), unknown);
  for (const at of [0, 7, 8, 31]) {
    const issued = signIn.challenge(`192.0.2.${at}`);
    assert.ok(issued.ok);
    const nonce = Buffer.from(issued.value.nonce, "base64");
    nonce[at]! ^= 1;
    assert.deepEqual(await signIn.verify("client", owner.sign({ ...forged, nonce: nonce.toString("base64") })), unknown, `byte ${at}: its issue time, random part or HMAC`);
  }
  assert.deepEqual(await signIn.verify("client", owner.sign(setup().challenge())), unknown, "another process's challenge");
  assert.deepEqual(await signIn.verify("client", { ...owner.sign(challenge()), nonce: Buffer.alloc(31).toString("base64") }), unknown, "a nonce that isn't 32 bytes");
});

test("a captured sign-in can't be replayed with another encoding of the same nonce", async () => {
  const { signIn, challenge } = setup();
  const signed = owner.sign(challenge());
  assert.equal((await signIn.verify("client", signed)).ok, true);
  const n = signed.nonce, bytes = Buffer.from(n, "base64");
  const otherLast = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"]
    .find(c => c !== n[42] && Buffer.from(`${n.slice(0, 42)}${c}=`, "base64").equals(bytes))!;
  for (const nonce of [n.slice(0, -1), `${n}=`, ` ${n}`, `${n.slice(0, 20)}\n${n.slice(20)}`, `${n.slice(0, 42)}${otherLast}=`]) {
    assert.ok(Buffer.from(nonce, "base64").equals(bytes), "the same bytes");
    assert.deepEqual(await signIn.verify("client", { ...signed, nonce }), { ok: false, kind: "refused", code: "unknown_challenge" }, JSON.stringify(nonce));
  }
});

test("an expired challenge is refused", async () => {
  const { signIn, challenge, clock } = setup();
  const issued = challenge();
  clock.now += 5 * 60_000;
  assert.deepEqual(await signIn.verify("client", owner.sign(issued)), { ok: false, kind: "refused", code: "expired" });
});

test("a tampered message or a wrong recipient fails the signature, with no chain lookup", async () => {
  const { signIn, challenge, lookups } = setup();
  assert.deepEqual(await signIn.verify("client", owner.sign(challenge(), { message: "Send everything" })), { ok: false, kind: "refused", code: "bad_signature" });
  assert.deepEqual(await signIn.verify("client", owner.sign(challenge(), { recipient: "platform.test" })), { ok: false, kind: "refused", code: "bad_signature" });
  const issued = challenge();
  assert.deepEqual(await signIn.verify("client", { ...owner.sign(issued), publicKey: wallet("x.near").publicKey }), { ok: false, kind: "refused", code: "bad_signature" });
  assert.deepEqual(lookups, [], "a bad signature costs no RPC call");
});

test("a key that isn't a full-access key of the signing account is refused", async () => {
  const { signIn, challenge } = setup(async () => "limited");
  assert.deepEqual(await signIn.verify("client", owner.sign(challenge())), { ok: false, kind: "refused", code: "not_full_access" });
  const other = setup(async () => "none");
  assert.deepEqual(await other.signIn.verify("client", owner.sign(other.challenge())), { ok: false, kind: "refused", code: "not_full_access" });
});

test("a chain that doesn't answer makes sign-in unavailable, not refused, and the same signature works once it answers", async () => {
  let chain: "unavailable" | "full" = "unavailable";
  const { signIn, challenge } = setup(async () => chain);
  const signed = owner.sign(challenge());
  assert.deepEqual(await signIn.verify("client", signed), { ok: false, kind: "unavailable" });
  chain = "full";
  assert.deepEqual(await signIn.verify("client", signed), { ok: true, account: "owner.near" });
  assert.deepEqual(await signIn.verify("client", signed), { ok: false, kind: "refused", code: "unknown_challenge" });
});

test("challenges are rate-limited per client and minute", () => {
  const { signIn, clock } = setup(undefined, undefined, 3);
  for (let i = 0; i < 3; i++) assert.equal(signIn.challenge("a").ok, true);
  assert.deepEqual(signIn.challenge("a"), { ok: false, kind: "refused", code: "rate_limited" });
  assert.equal(signIn.challenge("b").ok, true, "another client isn't affected");
  clock.now += 60_001;
  assert.equal(signIn.challenge("a").ok, true, "the window moves on");
});

test("a client's window moves on between the periodic clean-ups too", () => {
  const { signIn, clock } = setup(undefined, undefined, 3);
  for (let i = 0; i < 3; i++) assert.equal(signIn.challenge("a").ok, true);
  clock.now += 55_000;
  assert.equal(signIn.challenge("b").ok, true, "a clean-up runs here");
  clock.now += 5_500;
  assert.equal(signIn.challenge("a").ok, true, "a's requests are over a minute old, though no clean-up has run since");
});

test("issuing challenges stores nothing, so a flood from many addresses can't crowd out an owner's", async () => {
  const { signIn, challenge } = setup();
  const mine = challenge();
  for (let i = 0; i < 20_000; i++) assert.equal(signIn.challenge(`198.51.${i >> 8}.${i & 255}`).ok, true);
  assert.deepEqual(await signIn.verify("client", owner.sign(mine)), { ok: true, account: "owner.near" });
});

test("the rate limit counts an IPv6 client by its /64, and an IPv4-mapped address as IPv4", () => {
  assert.equal(clientKey("2001:db8:1:2:aaaa::1"), clientKey("2001:db8:1:2:ffff:ffff:ffff:ffff"));
  assert.notEqual(clientKey("2001:db8:1:2::1"), clientKey("2001:db8:1:3::1"));
  assert.equal(clientKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(clientKey("::ffff:192.0.2.7"), "192.0.2.7");
  assert.equal(clientKey("192.0.2.7"), "192.0.2.7");
  assert.equal(clientKey("fe80::1%en0"), "fe80:0:0:0::/64");
  assert.equal(clientKey("192.0.2.7:5678"), "192.0.2.7", "a port a proxy appended is dropped");
  assert.equal(clientKey("[2001:db8:1:2::1]:443"), clientKey("2001:db8:1:2::9"));
  assert.equal(clientKey("[2001:db8:1:2::1]"), clientKey("2001:db8:1:2::9"));
  const { signIn } = setup(undefined, undefined, 3);
  for (let i = 0; i < 3; i++) assert.equal(signIn.challenge(`2001:db8:1:2::${i + 1}`).ok, true);
  assert.deepEqual(signIn.challenge("2001:db8:1:2::99"), { ok: false, kind: "refused", code: "rate_limited" }, "another address in the same /64");
});

test("sign-in attempts are rate-limited per client too, so a challenge a bad signature leaves usable can't be tried without limit", async () => {
  const { signIn, challenge, clock, lookups } = setup(undefined, undefined, 3);
  const issued = challenge();
  for (let i = 0; i < 3; i++) assert.equal((await signIn.verify("2001:db8:1:2::1", owner.sign(issued, { message: `guess ${i}` }))).ok, false);
  const limited = { ok: false, kind: "refused", code: "rate_limited" };
  assert.deepEqual(await signIn.verify("2001:db8:1:2::2", owner.sign(issued)), limited, "the same /64, even with a valid signature");
  assert.deepEqual(lookups, []);
  assert.equal(signIn.challenge("2001:db8:1:2::1").ok, true, "attempts and challenges are counted apart");
  assert.deepEqual(await signIn.verify("192.0.2.1", owner.sign(issued)), { ok: true, account: "owner.near" }, "another client isn't affected");
  clock.now += 60_001;
  assert.equal((await signIn.verify("2001:db8:1:2::1", owner.sign(challenge()))).ok, true, "the window moves on");
});

test("two uses of one signature at once sign in once, whichever chain lookup answers first, and cost one lookup", async () => {
  const pending: ((state: "full") => void)[] = [];
  const { signIn, challenge, lookups } = setup(() => new Promise(resolve => { pending.push(resolve); }));
  const signed = owner.sign(challenge());
  const first = signIn.verify("192.0.2.1", signed), second = signIn.verify("192.0.2.2", signed);
  const third = signIn.verify("192.0.2.3", signed);
  await new Promise(resolve => setImmediate(resolve));
  for (const resolve of pending.reverse()) resolve("full");
  // Its own deadline: a lookup left unresolved would leave the test unsettled, which is cancelled, not failed.
  const answers = await Promise.race([Promise.all([first, second, third]), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("never settled")), 2_000).unref())]);
  assert.equal(answers.filter(answer => answer.ok).length, 1);
  assert.equal(answers.filter(answer => !answer.ok && answer.kind === "refused" && answer.code === "unknown_challenge").length, 2);
  assert.equal(lookups.length, 1, "the nonce is spent before the chain is asked, so it costs one RPC call");
});
