// The browser never sees the credential (#20's acceptance list): the server runs with its real platform module and a
// real 0600 credential file, against a platform that even echoes the credential back in its errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCredential } from "../src/credential.ts";
import { routes } from "../src/http.ts";
import { loadPage } from "../src/page.ts";
import { createPlatform } from "../src/platform.ts";
import { ORIGIN, wallet } from "./fakes.ts";
import { testServer } from "./test-server.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const secret = randomBytes(32).toString("base64url").slice(0, 43);
const tap = `tap_00000000-0000-4000-8000-000000000000.${secret}`;
const owner = wallet("owner.near");

/** The platform's `/apps/v1` as far as the routes reach it: the agent and its consent, and every other call refused with the credential in its text. */
const platformFetch = (seen: { url: string; headers: Headers }[]): typeof fetch => async (input, init) => {
  const url = String(input instanceof Request ? input.url : input), headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  seen.push({ url, headers });
  const echo = { error: `Refused for ${headers.get("authorization")}`, credential: tap };
  if (url.endsWith("/apps/v1/agents/portfolio"))
    return Response.json({ agent: "portfolio", owner: "owner.near", agentId: "id-portfolio", created: true, host: "platform.test", deployment: "treasury" });
  if (url.includes("/apps/v1/consents?"))
    return Response.json({ consents: [{ id: "c".repeat(64), deployment: "treasury", host: "platform.test", organization: "owner--near", owner: "owner.near", agent: "portfolio",
      agentId: "id-portfolio", scopes: ["read", "treasury"], expiresAt: Date.now() + 86_400_000, createdAt: 0, publicKey: "ed25519:k", revoked: false, revokedAt: null }] });
  return Response.json(echo, { status: url.includes("/rpc/") ? 500 : 400 });
};

test("the browser never sees the credential: no tap_ value in any answer, header or page, while every platform call carries it", async t => {
  t.mock.method(console, "error", () => {});
  const dir = tempDir("credential-browser-");
  writeFileSync(join(dir, "app-credential"), tap, { mode: 0o600 });
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Treasury proposals</title>");
  const seen: { url: string; headers: Headers }[] = [];
  const { server, base } = await testServer({ wallets: [owner], page: await loadPage(dir),
    platform: createPlatform({ origin: "https://platform.test", credential: createCredential(join(dir, "app-credential")), timeoutMs: 1_000, fetch: platformFetch(seen) }) });
  t.after(() => server.close());
  const write = { origin: ORIGIN, "content-type": "application/json" };
  const answers: string[] = [];
  const send = async (method: string, path: string, headers: Record<string, string>, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) });
    const text = await response.text();
    answers.push(`${response.status} ${[...response.headers].map(([name, value]) => `${name}: ${value}`).join("\n")}\n${text}`);
    return { headers: response.headers, body: text };
  };
  const issued = JSON.parse((await send("POST", "/api/session/challenge", write)).body) as { value: { message: string; recipient: string; nonce: string } };
  const cookie = (await send("POST", "/api/session", write, owner.sign(issued.value))).headers.get("set-cookie")!.split(";")[0]!;
  // Sign-out last, so every other route runs signed in.
  for (const route of [...routes].sort((a, b) => Number(a.method === "DELETE") - Number(b.method === "DELETE"))) {
    const path = route.path.replace(":agent", "portfolio").replace(":id", "a".repeat(32));
    await send(route.method, path, route.method === "GET" ? { cookie } : { ...write, cookie }, route.method === "GET" ? undefined : { verdict: "approve" });
  }
  for (const path of ["/", "/agents/portfolio", "/index.html"]) await send("GET", path, {});
  for (const reached of ["/apps/v1/agents/portfolio", "/apps/v1/consents?", "/rpc/"]) assert.ok(seen.some(({ url }) => url.includes(reached)), `the routes reached ${reached}`);
  assert.ok(answers.length > routes.length);
  for (const answer of answers) {
    assert.ok(!answer.includes("tap_"), answer);
    assert.ok(!answer.includes(secret), answer);
  }
  for (const { url, headers } of seen) {
    assert.equal(headers.get("authorization"), `Bearer ${tap}`, url);
    assert.equal(headers.get("origin"), null, `${url}: no browser header is forwarded`);
    assert.equal(headers.get("cookie"), null, url);
  }
});
