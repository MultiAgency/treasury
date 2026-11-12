import { test } from "node:test";
import assert from "node:assert/strict";
import { main, pingAnchorCheck } from "../src/anchor-check-ping.ts";

const url = "https://hc-ping.com/11111111-2222-4333-8444-555555555555";
const noWait = async () => {};
const failureLine = "::error::Audit monitor heartbeat failed. Check the ping URL and service availability; no heartbeat was confirmed.";

test("an absent heartbeat secret is an explicit notice, without a request", async () => {
  for (const value of [undefined, "", "  \n"]) {
    const lines: string[] = [];
    let sent = 0;
    assert.equal(await main({ ANCHOR_CHECK_PING_URL: value }, line => lines.push(line), {
      fetch: async () => { sent++; return new Response("OK"); }, sleep: noWait,
    }), 0);
    assert.equal(sent, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^::notice::.*not configured.*missing-run alerts are inactive/);
  }
});

test("only a single-check HTTPS UUID URL is accepted before any request", async () => {
  for (const bad of [url.replace("https:", "http:"), url.replace("hc-ping.com", "example.com"), `${url}?create=1`,
    `${url}#fragment`, `${url}/fail`, `${url}/`, url.replace("hc-ping.com", "hc-ping.com:443"),
    url.replace("hc-ping.com", "user:password@hc-ping.com"), "https://hc-ping.com/project-key/check-slug"]) {
    let sent = 0;
    await assert.rejects(pingAnchorCheck(bad, { fetch: async () => { sent++; return new Response("OK"); } }), /Invalid audit monitor ping URL/);
    assert.equal(sent, 0);
  }
});

test("a bodyless POST omits credentials, rejects redirects and has an abort deadline", async () => {
  let sent = 0;
  const answer = await pingAnchorCheck(url, { fetch: async (input, init) => {
    sent++;
    assert.equal(input, url);
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, undefined);
    assert.equal(init?.headers, undefined);
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    return new Response("OK");
  } });
  assert.equal(answer, "sent");
  assert.equal(sent, 1);
});

test("a temporary network failure is retried with a bounded wait", async () => {
  let sent = 0;
  const waits: number[] = [];
  assert.equal(await pingAnchorCheck(url, { fetch: async () => {
    if (++sent < 3) throw new Error(`network failed for ${url}`);
    return new Response("OK");
  }, sleep: async ms => { waits.push(ms); } }), "sent");
  assert.equal(sent, 3);
  assert.deepEqual(waits, [1_000, 1_000]);
});

test("redirects, errors and ignored 200 replies never confirm a heartbeat", async () => {
  for (const [status, body] of [[302, "OK"], [500, "OK"], [200, "OK (not found)"], [200, "OK (rate limited)"], [200, ""]] as const) {
    let sent = 0;
    const lines: string[] = [];
    assert.equal(await main({ ANCHOR_CHECK_PING_URL: url }, line => lines.push(line), {
      fetch: async () => { sent++; return new Response(body, { status }); }, sleep: noWait,
    }), 1);
    assert.equal(sent, 3);
    assert.deepEqual(lines, [failureLine]);
  }
});

test("exceptions containing the bearer credential are sanitized at the CLI boundary", async () => {
  const lines: string[] = [];
  let sent = 0;
  const waits: number[] = [];
  assert.equal(await main({ ANCHOR_CHECK_PING_URL: url }, line => lines.push(line), {
    fetch: async () => { sent++; throw new Error(`secret request failed: ${url}`); },
    sleep: async ms => { waits.push(ms); },
  }), 1);
  assert.equal(sent, 3);
  assert.deepEqual(waits, [1_000, 1_000]);
  assert.deepEqual(lines, [failureLine]);
});

test("a failed response body is retried without exposing its error", async () => {
  const lines: string[] = [];
  let sent = 0;
  assert.equal(await main({ ANCHOR_CHECK_PING_URL: url }, line => lines.push(line), {
    fetch: async () => {
      sent++;
      return new Response(new ReadableStream({
        start(controller) { controller.error(new Error(`secret response failed: ${url}`)); },
      }));
    }, sleep: noWait,
  }), 1);
  assert.equal(sent, 3);
  assert.deepEqual(lines, [failureLine]);
});

test("the CLI confirms API acceptance without logging the credential", async () => {
  const lines: string[] = [];
  assert.equal(await main({ ANCHOR_CHECK_PING_URL: url }, line => lines.push(line), {
    fetch: async () => new Response("OK"),
  }), 0);
  assert.deepEqual(lines, ["Audit monitor heartbeat accepted."]);
});
