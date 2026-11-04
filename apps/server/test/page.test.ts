import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createDaoRequests } from "../src/dao-requests.ts";
import { standInDaos } from "../src/dao.ts";
import { createServer } from "../src/http.ts";
import { loadPage } from "../src/page.ts";
import { createSessions } from "../src/sessions.ts";
import { createSignIn } from "../src/signin.ts";
import { fakePlatform, HOST, ORIGIN } from "./fakes.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const PAGE = "<!doctype html><title>Treasury proposals</title>";
/** The proposals page's build as `web/` makes it, with what must never be served beside it. */
const dist = tempDir("treasury-page-");
const outside = tempDir("treasury-outside-");
writeFileSync(join(dist, "index.html"), PAGE);
writeFileSync(join(dist, ".env"), "SECRET=1");
writeFileSync(join(outside, "secret.js"), "secret");
mkdirSync(join(dist, "static", "js"), { recursive: true });
writeFileSync(join(dist, "static", "js", "index.0123abcd.js"), "console.log(1)");
writeFileSync(join(dist, "static", "js", ".hidden.js"), "hidden");
writeFileSync(join(dist, "static", "js", "map.bin"), "no such type");
symlinkSync(join(outside, "secret.js"), join(dist, "static", "js", "linked.js"));

let server: Server, base: string;
before(async () => {
  server = createHttpServer(createServer({
    platform: fakePlatform({ portfolio: "owner.near" }).platform,
    signIn: createSignIn({ recipient: HOST, ttlMs: 60_000, perMinute: 10, keyLookup: async () => "none" }),
    sessions: createSessions({ idleMs: 60_000, maxMs: 120_000 }), publicOrigin: ORIGIN, deployment: "treasury", trustedProxyHops: 0,
    ownerRequestsPerMinute: 10, audit: { append: async () => {} }, consentsPerDay: 1, daoFilingsPerDay: 1_000, keyLookup: async () => "none", daos: standInDaos({}), daoRequests: await createDaoRequests(join(tempDir("treasury-dao-requests-"), "dao-requests.json")),
    page: await loadPage(dist),
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("every page path is the page: never stored by a cache, never framed, sending no referrer", async () => {
  for (const path of ["/", "/index.html", "/agents/portfolio", `/agents/portfolio/proposals/${"a".repeat(32)}`, "/.env", "/static/../.env"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), PAGE, `${path}: the page, never a dotfile`);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  }
});

test("hashed assets are served by their exact path and cached for good; nothing else under static/ is, and nothing is listed", async () => {
  const asset = await fetch(`${base}/static/js/index.0123abcd.js`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(asset.headers.get("x-content-type-options"), "nosniff");
  assert.equal(asset.headers.get("content-length"), "14");
  assert.equal(await asset.text(), "console.log(1)");
  for (const path of ["/static/js/missing.js", "/static/js/.hidden.js", "/static/js/map.bin", "/static/js/linked.js", "/static/js/", "/static/"])
    assert.equal((await fetch(`${base}${path}`)).status, 404, `${path}: a missing file, a dotfile, an unknown type, a link out of the build, or a listing`);
});

test("HEAD answers the headers without a body; other methods get no page", async () => {
  const head = await fetch(`${base}/static/js/index.0123abcd.js`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(head.headers.get("content-length"), "14", "the length of the body a GET would answer");
  assert.equal(await head.text(), "");
  assert.equal((await fetch(`${base}/agents/portfolio`, { method: "HEAD" })).headers.get("content-type"), "text/html; charset=utf-8");
  const write = await fetch(`${base}/agents/portfolio`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" });
  assert.deepEqual([write.status, await write.json()], [404, { ok: false, kind: "refused", code: "not_found" }]);
});

test("/api is matched first and unchanged beside the page", async () => {
  const unknown = await fetch(`${base}/api/nothing`);
  assert.deepEqual([unknown.status, await unknown.json()], [404, { ok: false, kind: "refused", code: "not_found" }]);
  assert.deepEqual(await (await fetch(`${base}/api/agents/portfolio`)).json(), { ok: false, kind: "not_signed_in" });
  assert.equal((await fetch(`${base}/api`)).status, 404);
});

test("a build without its page refuses to load, so the server doesn't start", async () => {
  await assert.rejects(loadPage(tempDir("treasury-empty-")), /has no index.html/);
});
