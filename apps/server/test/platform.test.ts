import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredential } from "../src/credential.ts";
import { createPlatform } from "../src/platform.ts";

const tap = (fill: string) => `tap_00000000-0000-4000-8000-000000000000.${fill.repeat(43)}`;
const identity = { agent: "portfolio", owner: "owner.near", agentId: "id-1", created: true, host: "platform.test", deployment: "treasury" };

/** A fetch that records each request's headers and answers `answer`. */
function recording(answer: (signal: AbortSignal | undefined) => Promise<Response>) {
  const seen: Headers[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    seen.push(new Headers(input instanceof Request ? input.headers : init?.headers));
    return answer(init?.signal ?? (input instanceof Request ? input.signal : undefined));
  };
  return { fetch, seen };
}

const setup = (answer: Parameters<typeof recording>[0], timeoutMs = 1_000) => {
  const file = join(mkdtempSync(join(tmpdir(), "platform-")), "app-credential");
  writeFileSync(file, tap("a"), { mode: 0o600 });
  const { fetch, seen } = recording(answer);
  const clock = { now: 0 };
  return { file, seen, clock, platform: createPlatform({ origin: "https://platform.test", credential: createCredential(file), timeoutMs, now: () => clock.now, fetch }) };
};

test("identity reads the platform under the current credential, and a rotated one is used at once", async () => {
  const { file, seen, platform } = setup(async () => Response.json(identity));
  assert.deepEqual(await platform.identity("portfolio"), { answer: { ok: true, value: identity }, cached: false });
  assert.equal(seen[0]!.get("authorization"), `Bearer ${tap("a")}`);
  writeFileSync(file, tap("b"), { mode: 0o600 });
  await platform.identity("portfolio", { fresh: true });
  assert.equal(seen[1]!.get("authorization"), `Bearer ${tap("b")}`);
});

test("a successful identity is reused for a minute per agent, then read again", async () => {
  const { seen, clock, platform } = setup(async () => Response.json(identity));
  await platform.identity("portfolio");
  clock.now += 59_999;
  assert.deepEqual(await platform.identity("portfolio"), { answer: { ok: true, value: identity }, cached: true });
  assert.equal(seen.length, 1, "within the minute, no platform call");
  await platform.identity("other");
  assert.equal(seen.length, 2, "each agent has its own");
  clock.now += 1;
  await platform.identity("portfolio");
  assert.equal(seen.length, 3, "after the minute, read again");
});

test("a failure is never reused, a 404 included, so an agent set up a moment later is reachable at once", async () => {
  let status = 404;
  const { seen, platform } = setup(async () => status === 200 ? Response.json(identity) : Response.json({ error: "x" }, { status }));
  for (const failing of [404, 403, 409, 429, 503]) {
    status = failing;
    await platform.identity("portfolio", { fresh: true });
    assert.equal((await platform.identity("portfolio")).cached, false, String(failing));
  }
  assert.equal(seen.length, 10, "every request after a failure asks again");
  status = 200;
  assert.equal((await platform.identity("portfolio")).answer.ok, true, "the agent, once set up, at the next request");
  status = 429;
  assert.equal((await platform.identity("portfolio", { fresh: true })).answer.ok, false);
  status = 200;
  await platform.identity("portfolio");
  assert.equal(seen.length, 13, "a fresh failure drops the success it replaced");
});

test("a read that answers after a newer one can't overwrite what the newer one kept", async () => {
  const answers: ((response: Response) => void)[] = [];
  const { seen, platform } = setup(() => new Promise(resolve => { answers.push(resolve); }));
  // Each read first checks the credential file, so it reaches the platform a few I/O turns later.
  // With a deadline: a read that never reaches the platform must fail the test, not leave it waiting.
  const asked = async (count: number) => {
    for (const deadline = Date.now() + 2_000; answers.length < count;) {
      if (Date.now() > deadline) throw new Error(`${count} reads expected at the platform, ${answers.length} arrived`);
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  };
  const settled = <T>(read: Promise<T>) => Promise.race([read, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("never settled")), 2_000).unref())]);
  const older = platform.identity("portfolio");
  await asked(1);
  const newer = platform.identity("portfolio", { fresh: true });
  await asked(2);
  answers[1]!(Response.json({ ...identity, owner: "new.near" }));
  await newer;
  answers[0]!(Response.json(identity));
  await older;
  assert.equal(((await settled(platform.identity("portfolio"))).answer as { value: { owner: string } }).value.owner, "new.near", "the older answer, arriving late, didn't replace it");
  assert.equal(seen.length, 2);
  const failing = platform.identity("portfolio", { fresh: true });
  await asked(3);
  const newest = platform.identity("portfolio", { fresh: true });
  await asked(4);
  answers[3]!(Response.json(identity));
  await newest;
  answers[2]!(Response.json({ error: "x" }, { status: 503 }));
  await failing;
  assert.equal((await settled(platform.identity("portfolio"))).cached, true, "nor delete it by failing late");
});

test("requests that miss together share one platform call", async () => {
  const { seen, platform } = setup(async () => Response.json(identity));
  const answers = await Promise.all([platform.identity("portfolio"), platform.identity("portfolio"), platform.identity("portfolio")]);
  assert.equal(seen.length, 1);
  for (const answer of answers) assert.deepEqual(answer, { answer: { ok: true, value: identity }, cached: false });
  await Promise.all([platform.identity("portfolio", { fresh: true }), platform.identity("portfolio", { fresh: true })]);
  assert.equal(seen.length, 3, "a fresh read always makes its own call");
});

test("a fresh read always asks, and what it read is reused after", async () => {
  const { seen, platform } = setup(async () => Response.json(identity));
  await platform.identity("portfolio");
  await platform.identity("portfolio", { fresh: true });
  assert.equal(seen.length, 2);
  assert.equal((await platform.identity("portfolio")).cached, true);
  assert.equal(seen.length, 2);
});

test("nothing a browser sends reaches the platform: no Origin, no Cookie", async () => {
  const { seen, platform } = setup(async () => Response.json(identity));
  await platform.identity("portfolio");
  assert.equal(seen[0]!.get("origin"), null);
  assert.equal(seen[0]!.get("cookie"), null);
});

test("a platform that doesn't answer in time is unavailable", async () => {
  const { platform } = setup(signal => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason));
  }), 30);
  // Its own deadline: without a timeout the call would never settle, and a test that never settles is cancelled, not failed.
  const settled = await Promise.race([platform.identity("portfolio"), new Promise(resolve => setTimeout(resolve, 1_000, "never settled"))]);
  assert.deepEqual(settled, { answer: { ok: false, kind: "unavailable" }, cached: false });
});
