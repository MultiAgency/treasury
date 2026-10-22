import { readFileSync, writeFileSync } from "node:fs";
import type { Tick } from "./evidence.js";
import { hostedRpc, required } from "./remote.js";
import type { Row } from "./ledger.js";
import { type Intervention, unattendedReport } from "./report.js";

/**
 * The unattended-run report: what the treasury agent's scheduler recorded tick by tick (src/evidence.ts),
 * checked against the API's execution history and the gateway's record of operator calls. Reads only, through the hosted dashboard, as the
 * signed-in account in REPORT_COOKIE_FILE (a file holding `dao_session=…`, never pasted anywhere).
 *
 *   DASHBOARD_URL=https://… REPORT_COOKIE_FILE=… SINCE=2026-…Z [UNTIL=…Z] [MIN_HOURS=72] [OUT=report.md] pnpm run-report
 *
 * It reports operation only: one day of ticks says nothing about atomic budgets, strict caps or savings.
 */

const BASE = new URL(required("DASHBOARD_URL"));
const COOKIE = readFileSync(required("REPORT_COOKIE_FILE"), "utf8").trim();
const SINCE = required("SINCE");
const UNTIL = process.env.UNTIL ?? new Date().toISOString();
const MIN_HOURS = process.env.MIN_HOURS === undefined ? undefined : Number(process.env.MIN_HOURS);
if (MIN_HOURS !== undefined && !(MIN_HOURS > 0)) throw new Error("MIN_HOURS must be a positive number of hours");

const rpc = <T>(path: string, input?: unknown) => hostedRpc<T>(BASE, COOKIE, "treasury", path, input);

const [evidence, ledger, interventions] = await Promise.all([
  rpc<{ ticks: Tick[]; corrupt: number[] }>("autopilot/evidence", { since: SINCE }),
  rpc<Row[]>("ledger"),
  fetch(new URL(`/gw/interventions?since=${encodeURIComponent(SINCE)}`, BASE), { headers: { cookie: COOKIE } }).then(async (res) => {
    if (!res.ok) throw new Error(`interventions: ${res.status} ${await res.text()}`);
    const record = (await res.json()) as { calls: Intervention[]; corrupt: number[] };
    // A gateway that answers a bare list skips unreadable lines, so it can't show there were no calls.
    if (!Array.isArray(record.corrupt)) throw new Error("interventions: this gateway doesn't count unreadable lines; deploy a build that does");
    return record;
  }),
]);
const report = unattendedReport({ since: SINCE, until: UNTIL, evidence, interventions, ledger, minHours: MIN_HOURS });
if (process.env.OUT) writeFileSync(process.env.OUT, report);
process.stdout.write(report);
