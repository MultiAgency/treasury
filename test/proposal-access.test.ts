import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import type { Decoded } from "../src/gateway/proposals.js";

test("late shared-DAO proposal reads cannot put denied-agent payloads back in the query cache", async () => {
  Object.defineProperty(globalThis, "location", { value: { pathname: "/" }, configurable: true });
  // Load browser modules after supplying their location; no browser or network is involved.
  const { gatewayQueries, redactProposalCaches } = await import(new URL("../web/src/app/queries.ts", import.meta.url).href);
  const { reportAccessDenial, onAccessDenial, visibleProposals } = await import(new URL("../web/src/shared/access.ts", import.meta.url).href);
  const proposals: Decoded[] = ["denied", "healthy"].map((agent, id) => ({
    id, agent, what: "agent", type: "policy_update", correlationId: agent, expiresAt: "2099-01-01T00:00:00Z",
    state: "waiting", hash: agent, status: "InProgress", proposer: "owner.near", description: "",
    submittedAt: "2026-01-01T00:00:00Z", votes: {},
    check: { kind: "verified", standard: "nep413", message: { private: agent } },
  }));
  const client = new QueryClient();
  const cached = ["gw", "proposals", "cached.near"];
  client.setQueryData(cached, proposals);
  client.setQueryData(["sibling", "healthy"], { allowed: true });
  const stop = onAccessDenial((denial: { scope: string }) => {
    if (denial.scope !== "procedure") redactProposalCaches(client);
  });
  const originalFetch = globalThis.fetch;
  let finish!: (response: Response) => void;
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  globalThis.fetch = async () => { started(); return new Promise(resolve => { finish = resolve; }); };
  try {
    const forbidden = gatewayQueries.proposals("forbidden.near");
    client.setQueryData(forbidden.queryKey, [proposals[1]]);
    const waitingFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ error: "Proposal access denied", access: "procedure" }, { status: 403 });
    await assert.rejects(client.fetchQuery(forbidden), /Proposal access denied/);
    globalThis.fetch = waitingFetch;
    const options = gatewayQueries.proposals("shared.near");
    const pending = client.fetchQuery(options);
    void pending.catch(() => {}); // Keep failure cleanup from reporting a second cancellation error.
    await requested;
    reportAccessDenial({ base: "/a/denied", scope: "agent", message: "Access denied" });
    assert.equal(client.getQueryState(forbidden.queryKey)?.status, "error", "another agent denial must not clear an existing proposal denial");
    assert.match(String(client.getQueryState(forbidden.queryKey)?.error), /Proposal access denied/);
    assert.deepEqual(client.getQueryData(cached), [proposals[1]], "previously cached private payloads are removed immediately");
    assert.deepEqual(visibleProposals(proposals), [proposals[1]], "render-time consumers use the current denial");
    assert.deepEqual(client.getQueryData(["sibling", "healthy"]), { allowed: true });
    finish(Response.json(proposals));
    assert.deepEqual(await pending, [proposals[1]], "late successful reads must exclude the denied payload");
    assert.deepEqual(client.getQueryData(options.queryKey), [proposals[1]], "the shared cache retains the healthy sibling only");
    reportAccessDenial({ base: "", scope: "procedure", message: "Procedure denied" });
    assert.deepEqual(client.getQueryData(cached), [proposals[1]], "procedure denials preserve permitted sibling reads");
    let releaseSession!: (response: Response) => void;
    let sessionStarted!: () => void;
    const sessionRequested = new Promise<void>(resolve => { sessionStarted = resolve; });
    globalThis.fetch = async () => { sessionStarted(); return new Promise(resolve => { releaseSession = resolve; }); };
    const sessionPending = client.fetchQuery(gatewayQueries.proposals("session.near"));
    await sessionRequested;
    reportAccessDenial({ base: "", scope: "session", message: "Session expired" });
    assert.deepEqual(client.getQueryData(cached), []);
    releaseSession(Response.json(proposals));
    assert.deepEqual(await sessionPending, [], "late successful reads cannot restore any proposal after session expiry");
  } finally {
    stop();
    globalThis.fetch = originalFetch;
    client.clear();
    Reflect.deleteProperty(globalThis, "location");
  }
});
