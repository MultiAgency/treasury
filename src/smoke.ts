import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostedRpc, required } from "./remote.js";
import type { Access } from "./gateway/roles.js";

/**
 * Checks a deployed Treasury dashboard and, only when configured, a legacy invoice page from outside, changing nothing: health, security
 * headers, the sign-in host each signs for, and that nothing is reachable without a session.
 *
 *   DASHBOARD_URL=https://… pnpm smoke
 * Legacy invoice checks are opt-in through INVOICES_URL.
 *
 * With SMOKE_COOKIE_FILE (a file holding a signed-in `dao_session=…`) it also reads as that account.
 * With SMOKE_SNAPSHOT (a file path) it records what must survive a restart, and on the next run compares
 * against it: run once, restart a service, run again.
 *
 * It calls only procedures whose handlers write nothing, with or without a session: a refusal probe
 * of a money or settings procedure would run it if authorization were broken. Those refusals are
 * proven in test/gateway-denial.test.ts, against an instrumented agent server. Also left out:
 * `setup` (may adopt a staged grant), `held` (records settled outcomes) and the invoice list (refreshes
 * and records each open invoice's status).
 */

const DASHBOARD = new URL(required("DASHBOARD_URL"));
const INVOICES = process.env.INVOICES_URL ? new URL(process.env.INVOICES_URL) : undefined;
const COOKIE = process.env.SMOKE_COOKIE_FILE ? readFileSync(process.env.SMOKE_COOKIE_FILE, "utf8").trim() : undefined;
const SNAPSHOT = process.env.SMOKE_SNAPSHOT;
const ELSEWHERE = "https://elsewhere.example";

/** Procedures whose handlers write nothing: the only ones this script calls. */
const PROBES = ["overview", "ledger", "autopilot/get", "owner/pending"];

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? `: ${detail}` : ""}`);
}

const at = (base: URL, path: string) => new URL(path, base);
const get = (url: URL, headers: Record<string, string> = {}) => fetch(url, { headers, redirect: "manual" });
const post = (url: URL, headers: Record<string, string> = {}, body = "{}") =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, redirect: "manual" });
const rpc = <T>(agent: string, path: string) => hostedRpc<T>(DASHBOARD, COOKIE!, agent, path);

// The dashboard, without a session.
{
  const health = await get(at(DASHBOARD, "/health"));
  check("dashboard /health", health.ok && ((await health.json()) as { ok?: boolean }).ok === true, String(health.status));

  const page = await get(DASHBOARD);
  check("dashboard page", page.ok, String(page.status));
  for (const header of ["strict-transport-security", "x-frame-options", "x-content-type-options", "content-security-policy"])
    check(`dashboard header ${header}`, page.headers.has(header));

  const challenge = (await (await get(at(DASHBOARD, "/gw/challenge"))).json()) as { recipient?: string };
  check("dashboard signs in for its own host", challenge.recipient === DASHBOARD.host, `signs for ${challenge.recipient}`);

  const me = (await (await get(at(DASHBOARD, "/gw/me"))).json()) as { agents: { name: string; owner: string; dao: boolean }[]; viewer: unknown };
  check("no viewer without a session", me.viewer === null);
  check("signed out, only DAO-owned agents are listed", me.agents.every((a) => a.dao));
  const dao = me.agents[0]?.owner ?? "";
  check("proposals need a session", (await get(at(DASHBOARD, `/gw/proposals?dao=${dao}`))).status === 401);
  for (const { name: agent } of me.agents)
    for (const path of PROBES) {
      const { status } = await post(at(DASHBOARD, `/a/${agent}/rpc/${path}`));
      check(`${agent} ${path} needs a session`, status === 401, String(status));
    }
  const { status } = await post(at(DASHBOARD, "/gw/logout"), { origin: ELSEWHERE });
  check("dashboard refuses cross-site writes", status === 403, String(status));
}

// Optional legacy invoice page, without a session.
if (INVOICES) {
  const health = await get(at(INVOICES, "/health"));
  check("invoices /health", health.ok, String(health.status));
  const challenge = (await (await post(at(INVOICES, "/api/signin/challenge"))).json()) as { recipient?: string };
  check("invoices sign in for their own host", challenge.recipient === INVOICES.host, `signs for ${challenge.recipient}`);
  // An unknown path behind the same session guard: no handler runs whichever way the guard answers.
  const { status } = await get(at(INVOICES, "/api/smoke-no-such-route"));
  check("invoices need a session", status === 401, String(status));
  const crossSite = await post(at(INVOICES, "/api/signout"), { origin: ELSEWHERE });
  check("invoices refuse cross-site writes", crossSite.status === 403, String(crossSite.status));
}

// As a signed-in account.
if (COOKIE) {
  type Me = { agents: { name: string; owner: string; dao: boolean }[]; viewer: { account: string; access: Record<string, Access> } | null };
  const me = (await (await get(at(DASHBOARD, "/gw/me"), { cookie: COOKIE })).json()) as Me;
  check("the session signs in", me.viewer !== null);
  if (me.viewer) console.log(`     as ${me.viewer.account} (${Object.entries(me.viewer.access).map(([agent, access]) =>
    `${agent}: ${Object.entries(access).filter(([, allowed]) => allowed).map(([capability]) => capability).join(", ") || "read only"}`).join("; ")})`);
  for (const dao of new Set(me.agents.filter((a) => a.dao).map((a) => a.owner)))
    check(`proposals of ${dao} read`, (await get(at(DASHBOARD, `/gw/proposals?dao=${dao}`), { cookie: COOKIE })).ok);

  if (SNAPSHOT && me.viewer) {
    type Overview = { digest: string | null; grants: { label: string }[] };
    type Autopilot = { on: boolean; everyMin: number; maxUsd: number; lastRun: string | null };
    const now: Record<string, { digest: string | null; grants: string[]; autopilot?: Pick<Autopilot, "on" | "everyMin" | "maxUsd">; lastRun?: string | null; ledger: number }> = {};
    for (const agent of me.agents) {
      const [overview, autopilot, ledger] = await Promise.all([
        rpc<Overview>(agent.name, "overview"),
        rpc<Autopilot>(agent.name, "autopilot/get"),
        rpc<unknown[]>(agent.name, "ledger"),
      ]);
      now[agent.name] = { digest: overview.digest, grants: overview.grants.map(grant => grant.label).sort(),
        autopilot: { on: autopilot.on, everyMin: autopilot.everyMin, maxUsd: autopilot.maxUsd }, lastRun: autopilot.lastRun, ledger: ledger.length };
    }
    if (!existsSync(SNAPSHOT)) {
      writeFileSync(SNAPSHOT, JSON.stringify(now, null, 2));
      console.log(`     recorded ${SNAPSHOT}: restart the service, then run again`);
    } else {
      const before = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as typeof now;
      check("snapshot agent identities kept", JSON.stringify(Object.keys(now).sort()) === JSON.stringify(Object.keys(before).sort()));
      for (const [name, n] of Object.entries(now)) {
        const b = before[name];
        if (!b) { check(`${name} previous snapshot exists`, false); continue; }
        check(`${name} mandate digest kept`, n.digest === b.digest, `${b.digest} → ${n.digest}`);
        check(`${name} grants kept`, JSON.stringify(n.grants) === JSON.stringify(b.grants), JSON.stringify(n.grants));
        // Older payout snapshots did not include schedule fields; retain compatibility without inventing them.
        if (b.autopilot) check(`${name} autopilot settings kept`, JSON.stringify(n.autopilot) === JSON.stringify(b.autopilot));
        if (b.lastRun !== undefined) check(`${name} autopilot history kept`, (n.lastRun ?? "") >= (b.lastRun ?? ""));
        check(`${name} ledger kept`, n.ledger >= b.ledger, `${b.ledger} → ${n.ledger}`);
      }
    }
  }
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
