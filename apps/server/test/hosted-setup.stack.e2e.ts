// Treasury-owned acceptance reproduction against SDK 0.5.5 and the pinned simulated stack.
// Only local stack APIs are used. No source modules are mocked or replaced.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tempDir } from "../../../scripts/temp-dirs.ts";
import { startStack, signOwner, stackFetch } from "../../../scripts/stack.ts";
import { createCredential } from "../src/credential.ts";
import { createPlatform } from "../src/platform.ts";
import { createServer } from "../src/http.ts";
import { standInKeyLookup } from "../src/keys.ts";
import { createSessions } from "../src/sessions.ts";
import { createSignIn } from "../src/signin.ts";
import { standInDaos } from "../src/dao.ts";
import { createDaoRequests } from "../src/dao-requests.ts";

const ORIGIN = "https://treasury.test";

test("a wallet sets up a hosted Treasury, reviews and signs its readable creation, then connects the created agent", { timeout: 180_000 }, async () => {
  let stack: Awaited<ReturnType<typeof startStack>> | undefined;
  let server: Server | undefined;
  try {
    stack = await startStack({ args: ["--no-browser", "--app", "treasury-test"] });
    const target = stack.target, state = stack.state();
    assert.ok(state.app);
    const keyLookup = standInKeyLookup({ [state.ownerAccount]: [state.testPublicKey] });
    const platform = createPlatform({ origin: state.dashboard, credential: createCredential(state.app.credentialFile),
      timeoutMs: 15_000, fetch: stackFetch(readFileSync(target.ca)) });
    let prepared: Awaited<ReturnType<typeof platform.creation.prepare>> | undefined;
    const realPrepare = platform.creation.prepare;
    // Observe the genuine SDK result so the failure identifies the unsupported reply form.
    platform.creation.prepare = async (...args) => (prepared = await realPrepare(...args));
    const audit: unknown[] = [];
    server = createHttpServer(createServer({ platform, keyLookup, publicOrigin: ORIGIN, trustedProxyHops: 0,
      deployment: state.app.deployment, ownerRequestsPerMinute: 1_000, consentsPerDay: 100, daoFilingsPerDay: 100,
      daos: standInDaos({}), daoRequests: await createDaoRequests(join(tempDir("treasury-hosted-setup-"), "dao-requests.json")),
      signIn: createSignIn({ recipient: new URL(ORIGIN).host, ttlMs: 300_000, perMinute: 100, keyLookup }),
      sessions: createSessions({ idleMs: 1_800_000, maxMs: 43_200_000 }), audit: { append: async record => { audit.push(record); } } }));
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown, cookie?: string) => fetch(`${base}${path}`, { method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const get = (path: string, cookie: string) => fetch(`${base}${path}`, { headers: { cookie } });

    const challenge = await (await post("/api/session/challenge", {})).json() as { value: { message: string; recipient: string; nonce: string } };
    const signedIn = await post("/api/session", { ...(await signOwner(target, challenge.value)), nonce: challenge.value.nonce });
    assert.equal(signedIn.status, 200);
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    const before = await (await get("/api/setup", cookie)).json();
    assert.deepEqual(before, { ok: true, value: { account: state.ownerAccount, agents: [] } });
    const textResponse = await post("/api/setup/text", {}, cookie);
    assert.equal(textResponse.status, 200);
    const text = (await textResponse.json() as { value: { message: string; nonce: string; recipient: string } }).value;
    const signed = await signOwner(target, text);
    const setupResponse = await post("/api/setup", { message: text.message, nonce: text.nonce, publicKey: signed.publicKey, signature: signed.signature }, cookie);
    const setup = await setupResponse.json() as { ok: boolean; value: { agent: string } };
    assert.equal(setupResponse.status, 200, JSON.stringify(setup));
    const agent = setup.value.agent, path = `/api/agents/${agent}`;
    // Setup reserves a hosted process asynchronously, as the upstream hostedAgent acceptance helper does.
    let reserved: { value: { agentId: string | null; owner: string } } | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await get(path, cookie);
      const answer = await response.json() as { value: { agentId: string | null; owner: string } };
      if (response.status === 200) { reserved = answer; break; }
      assert.equal(response.status, 503, JSON.stringify(answer));
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(reserved, "the hosted agent process became readable after reservation");
    assert.equal(reserved.value.agentId, null, "setup reserves an agent; it has not created one");
    assert.equal(reserved.value.owner, state.ownerAccount);

    const creationResponse = await post(`${path}/creation`, {}, cookie);
    const creation = await creationResponse.json() as { ok: boolean; value?: { correlationId: string; intent?: { standard: string; payload: { message: string; recipient: string; nonce: string } } } };
    assert.ok(prepared?.ok, "the real platform successfully prepared the creation");
    assert.equal(creationResponse.status, 200,
      `a valid SDK wallet creation must reach the owner; platform prepared ${prepared.value.intent?.standard}, app answered ${JSON.stringify(creation)}`);
    assert.equal(creation.value?.intent?.standard, "nep413", "the readable SDK intent reaches the review step");
    const requested = creation.value!;
    const reviewResponse = await get(`${path}/creation/${requested.correlationId}/review`, cookie);
    assert.equal(reviewResponse.status, 200, await reviewResponse.clone().text());
    const review = await reviewResponse.json() as { value: unknown };
    assert.deepEqual(review.value, creation.value, "the exact reviewed bytes are retained; current authority and open phase are checked again");
    const unsigned = await get(`${path}/creation/${requested.correlationId}`, cookie);
    assert.equal((await unsigned.json() as { value: { phase?: string } }).value.phase, "open", "it has no effect before the owner signs");
    const creationSignature = await signOwner(target, requested.intent!.payload);
    const submitted = await post(`${path}/owner/actions/${requested.correlationId}/submit`, { signedData: {
      ...requested.intent, public_key: creationSignature.publicKey, signature: creationSignature.signature } }, cookie);
    assert.equal(submitted.status, 200, await submitted.text());
    let settled = false;
    for (let attempt = 0; attempt < 45; attempt++) {
      const status = await (await get(`${path}/creation/${requested.correlationId}`, cookie)).json() as { value: { phase?: string; status?: string } };
      if (status.value.phase === "settled") { assert.equal(status.value.status, "SUCCESS"); settled = true; break; }
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    assert.ok(settled, "creation settled successfully");
    const created = await (await get(path, cookie)).json() as { value: { agentId: string | null } };
    assert.ok(created.value.agentId, "creation status invalidates the cached unborn identity");
    const consentTextResponse = await post(`${path}/consent/text`, { owner: true }, cookie);
    assert.equal(consentTextResponse.status, 200);
    const consentText = (await consentTextResponse.json() as { value: { message: string; nonce: string; recipient: string } }).value;
    const consentSigned = await signOwner(target, consentText);
    const consentResponse = await post(`${path}/consent`, { message: consentText.message, nonce: consentText.nonce,
      publicKey: consentSigned.publicKey, signature: consentSigned.signature }, cookie);
    assert.equal(consentResponse.status, 200, await consentResponse.text());
    const overview = await get(`${path}/overview`, cookie);
    assert.equal(overview.status, 200, await overview.text());
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await stack?.stop();
  }
});
