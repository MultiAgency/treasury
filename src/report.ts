import type { Tick } from "./evidence.js";
import type { Row } from "./ledger.js";

/** How late a scheduled tick may run before it counts as missed: the timer checks once a minute. */
const SLACK_MIN = 3;
const MONEY = new Set(["swap", "shield", "unshield", "transfer", "withdraw"]);
/** Operator-only procedures whose handlers only read. */
const OPERATOR_READS = new Set(["autopilot/evidence"]);

export type Intervention = { at: string; account: string; agent: string; path: string };
type ReportInput = {
  since: string;
  until: string;
  /** The scheduler's evidence: ticks with their ends, and the line numbers that didn't parse. */
  evidence: { ticks: Tick[]; corrupt: number[] };
  /**
   * Operator calls the gateway recorded, and the line numbers that didn't parse. Calls made on a host
   * directly (CLI, shell) are not in it.
   */
  interventions: { calls: Intervention[]; corrupt: number[] };
  /** The books: every execution in the API's history. */
  ledger: Row[];
  now?: string;
};

export type Outcome = "executed" | "no-op" | "refused" | "failed" | "skipped" | "incomplete";

/** What a tick came to: a missing end is incomplete, never a success or a failure. */
export function outcomeOf(t: Tick): Outcome {
  const end = t.end;
  if (!end) return "incomplete";
  if (end.outcome.startsWith("Skipped") || end.outcome.startsWith("Not run")) return "skipped";
  // Worst first: a failed send isn't hidden by a refusal after it, and money sent counts as executed even if a
  // later leg was refused. A refusal is a working control, even though its outcome reads "Failed: <code>".
  const sent = [...end.steps, ...end.shields];
  const refused = !!end.refusal || end.rejected.length > 0;
  if (sent.some((s) => s.status !== "SUCCESS")) return "failed";
  // A failure that isn't a refusal (an unknown outcome, an error) is a failure even after settled legs.
  if (end.outcome.startsWith("Failed") && !refused) return "failed";
  if (sent.length > 0) return "executed";
  return refused ? "refused" : "no-op";
}

/**
 * The unattended-run report, as Markdown: criteria, configuration segments, every tick and the
 * incidents behind each failed criterion. It states what the evidence shows and no more: operation
 * only, no custody or economic claims.
 */
export function unattendedReport({ since, until, evidence, interventions: record, ledger, now = new Date().toISOString() }: ReportInput) {
  const ticks = evidence.ticks.filter((t) => t.at >= since && t.at <= until).sort((a, b) => a.at.localeCompare(b.at));
  const rows = ledger.filter((r) => r.at >= since && r.at <= until && MONEY.has(r.type));
  // Operator-only calls that only read (the evidence itself) are listed, not counted as interventions.
  const recorded = record.calls.filter((i) => i.at >= since && i.at <= until);
  const reads = recorded.filter((i) => OPERATOR_READS.has(i.path));
  const interventions = recorded.filter((i) => !OPERATOR_READS.has(i.path));
  const outcome = new Map(ticks.map((t) => [t, outcomeOf(t)]));

  // Configuration segments: build, mandate or scheduler settings changing starts a new one.
  const key = (t: Tick) => JSON.stringify([t.build, t.policy.revision, t.policy.digest, t.strategy, t.grant?.id ?? null, t.schedule.on, t.schedule.everyMin, t.schedule.maxUsd]);
  const segments: Tick[][] = [];
  for (const t of ticks) {
    const last = segments.at(-1);
    if (last && key(last[0]!) === key(t)) last.push(t);
    else segments.push([t]);
  }

  // Cadence: only completed scheduled ticks count as scheduled work; each gap is judged by the
  // settings the later tick recorded. Operator, skipped and incomplete ticks are named, not counted.
  const done = ticks.filter((t) => t.trigger === "schedule" && !["skipped", "incomplete"].includes(outcome.get(t)!));
  const gaps: string[] = [];
  // The scheduler counts the interval from a tick's end (its inbox "run" entry), so a gap runs from one tick's end to the next one's start.
  const points = [{ at: since, ended: since, schedule: done[0]?.schedule },
    ...done.map((t) => ({ at: t.at, ended: t.end?.endedAt || t.at, schedule: t.schedule })), { at: until, ended: until, schedule: done.at(-1)?.schedule }];
  if (done.length === 0) gaps.push(`no completed scheduled tick between ${since} and ${until}`);
  else for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1]!, points[i]!];
    const schedule = i === points.length - 1 ? a.schedule : b.schedule;
    if (!schedule?.on) continue;
    if (Date.parse(b.at) - Date.parse(a.ended) <= (schedule.everyMin + SLACK_MIN) * 60_000) continue;
    const within = ticks.filter((t) => t.at > a.at && t.at < b.at && !done.includes(t)).map((t) => `${t.trigger} ${outcome.get(t)} tick at ${t.at}`);
    gaps.push(`${a.at} → ${b.at} (interval ${schedule.everyMin} min)${within.length ? `; in between: ${within.join(", ")}` : ""}`);
  }

  // References: the same operation or plan named by two ticks. Not proof of two executions.
  const sentBy = new Map<string, { tick: Tick; leg: string }>();
  const references: string[] = [];
  for (const t of ticks) {
    const sent = [...(t.end?.steps ?? []).map((s) => ({ id: s.correlationId, leg: `${t.end!.plan?.id ?? "?"}#${s.index}` })),
      ...(t.end?.shields ?? []).map((s) => ({ id: s.correlationId, leg: `shield ${s.asset} at ${t.at}` }))];
    for (const { id, leg } of sent.filter((s) => s.id)) {
      if (sentBy.has(id)) references.push(`${id} named by ticks at ${sentBy.get(id)!.tick.at} and ${t.at}`);
      else sentBy.set(id, { tick: t, leg });
    }
  }
  const planTicks = new Map<string, string[]>();
  for (const t of ticks.filter((t) => t.end?.plan && t.end.steps.length > 0)) planTicks.set(t.end!.plan!.id, [...(planTicks.get(t.end!.plan!.id) ?? []), t.at]);
  for (const [plan, ats] of planTicks) if (ats.length > 1) references.push(`plan ${plan} executed by ticks at ${ats.join(", ")}`);

  // Executions: each provider execution matched to the tick leg that sent it.
  const unattributed = rows.filter((r) => !sentBy.has(r.correlationId));
  const perLeg = new Map<string, Row[]>();
  for (const r of rows.filter((r) => sentBy.has(r.correlationId) && r.status === "SUCCESS")) {
    const leg = sentBy.get(r.correlationId)!.leg;
    perLeg.set(leg, [...(perLeg.get(leg) ?? []), r]);
  }
  const duplicateExecutions = [...perLeg].filter(([, rs]) => rs.length > 1).map(([leg, rs]) => `${leg}: ${rs.map((r) => r.correlationId).join(", ")}`);
  const terms = (r: Row) => JSON.stringify([r.type, r.assetIn, r.amountIn, r.assetOut]);
  const attributedTerms = new Set(rows.filter((r) => sentBy.has(r.correlationId)).map(terms));
  const lookalikes = unattributed.filter((r) => attributedTerms.has(terms(r)));
  // Confirmed only when both executions trace to the same plan leg; identical terms alone are suspected.
  const duplicateVerdict = duplicateExecutions.length ? "**no**" : lookalikes.length ? "**suspected**" : unattributed.length ? "cannot be established" : "yes";

  const seen = (o: NonNullable<Tick["end"]>["before"]) => ("error" in o ? null : o);
  const unread = ticks.filter((t) => t.end && ("error" in t.end.before || "error" in t.end.after) && outcome.get(t) !== "skipped" || t.policy.status.startsWith("unread"));
  const unresolvedSeen = ticks.filter((t) => t.end && ((seen(t.end.before)?.unresolved ?? 0) > 0 || (seen(t.end.after)?.unresolved ?? 0) > 0));
  const operatorTicks = ticks.filter((t) => t.trigger === "operator");
  const count = (o: Outcome) => ticks.filter((t) => outcome.get(t) === o).length;
  const ok = (pass: boolean) => (pass ? "yes" : "**no**");
  const budget = (o: NonNullable<Tick["end"]>["before"] | undefined) => {
    const b = o && seen(o)?.budget as { daily?: { spent_usd?: string } } | null | undefined;
    return b?.daily?.spent_usd ?? "?";
  };
  const drift = (o: NonNullable<Tick["end"]>["before"] | undefined) => (o && seen(o)?.driftBps) ?? "?";
  const list = (title: string, items: string[]) => (items.length ? [title, ...items.map((i) => `- ${i}`)] : []);

  const lines = [
    `# Unattended run: ${since} → ${until}`,
    "",
    `Generated ${now} from the scheduler's evidence, the gateway's intervention record and the API's execution history.`,
    "",
    "## Criteria",
    `- Scheduled ticks completed without unexplained gaps: ${ok(gaps.length === 0)} (${gaps.length} gaps)`,
    `- Every started tick recorded its end: ${ok(count("incomplete") === 0)} (${count("incomplete")} incomplete)`,
    `- No duplicate execution: ${duplicateVerdict} (${duplicateExecutions.length} confirmed: one plan leg executed twice; ${lookalikes.length} suspected: same terms, no tick recorded one; ${unattributed.length} executions no tick recorded)`,
    `- No duplicate references: ${ok(references.length === 0)} (${references.length})`,
    `- No operator interventions in the gateway's record: ${ok(interventions.length === 0 && record.corrupt.length === 0 && operatorTicks.length === 0)} (${interventions.length} recorded calls, ${record.corrupt.length} unreadable lines, ${operatorTicks.length} operator ticks; calls made on a host directly are not recorded)`,
    `- No failed executions or errors: ${ok(count("failed") === 0)} (${count("failed")} ticks)`,
    `- Every tick read its book and mandate: ${ok(unread.length === 0)} (${unread.length} ticks)`,
    `- Evidence file intact: ${ok(evidence.corrupt.length === 0)} (${evidence.corrupt.length} unreadable lines)`,
    "",
    `${ticks.length} ticks: ${["executed", "no-op", "refused", "failed", "skipped", "incomplete"].map((o) => `${count(o as Outcome)} ${o}`).join(", ")}. ` +
      `${operatorTicks.length} operator-triggered. ${rows.length} executions in the API history. ` +
      `Unresolved operations were observed at ${unresolvedSeen.length} ticks (an observation, not a recovery record).`,
    "",
    "## Configuration segments",
    ...segments.map((s, i) => {
      const t = s[0]!;
      return `${i + 1}. ${t.at} → ${s.at(-1)!.at}, ${s.length} ticks: deployment ${t.build.deployment ?? "unknown"}, source ${t.build.source}, lockfile ${t.build.lockfile ?? "unknown"}, ` +
        `policy revision ${t.policy.revision} (${t.policy.digest}), strategy ${t.strategy}, grant ${t.grant ? `${t.grant.id} "${t.grant.label}"` : "none"}, ` +
        `autopilot ${t.schedule.on ? "on" : "off"} every ${t.schedule.everyMin} min, limit $${t.schedule.maxUsd}`;
    }),
    "The image digest is not visible to the process: take it from the deployment record for each deployment id.",
    "",
    "## Ticks",
    "| started (UTC) | trigger | outcome | drift bps before → after | daily $ spent before → after | plan | sent | summary |",
    "|---|---|---|---|---|---|---|---|",
    ...ticks.map((t) => {
      const e = t.end;
      const sent = e ? [...e.steps.map((s) => `${s.status} ${s.correlationId}`), ...e.shields.map((s) => `shield ${s.status} ${s.correlationId}`)].join("; ") : "";
      return `| ${t.at} | ${t.trigger} | ${outcome.get(t)} | ${drift(e?.before)} → ${drift(e?.after)} | ${budget(e?.before)} → ${budget(e?.after)} | ` +
        `${e?.plan ? `$${e.plan.usd.toFixed(2)}, ${e.plan.legs.length} legs` : "none"} | ${sent || "–"} | ${(e?.outcome ?? "no end recorded").replaceAll("|", "/")} |`;
    }),
    "",
    "## Incidents",
    ...list("Gaps in scheduled work:", gaps),
    ...list("Ticks with no end recorded (interrupted, or outcome unknown):", ticks.filter((t) => outcome.get(t) === "incomplete").map((t) => `${t.at} (${t.trigger})`)),
    ...list("Confirmed duplicates (one plan leg executed more than once):", duplicateExecutions),
    ...list("Suspected duplicates (same terms as a tick's execution, but no tick recorded them; separate operations can share terms):", lookalikes.map((r) => `${r.at} ${r.type} ${r.status} ${r.correlationId}`)),
    ...list("Executions no tick recorded:", unattributed.map((r) => `${r.at} ${r.type} ${r.status} ${r.correlationId}`)),
    ...list("Duplicate references:", references),
    ...list("Operator interventions (dashboard calls beyond reads):", interventions.map((i) => `${i.at} ${i.account} ${i.agent} ${i.path}`)),
    ...list("Unreadable intervention lines (each may have been a call):", record.corrupt.map((n) => `line ${n}`)),
    ...list("Operator-triggered ticks:", operatorTicks.map((t) => t.at)),
    ...list("Operator reads (recorded by the gateway, not interventions):", reads.map((i) => `${i.at} ${i.account} ${i.agent} ${i.path}`)),
    ...list("Refusals (the control was invoked; whether it refused correctly is not judged here):", ticks.filter((t) => t.end && (t.end.refusal || t.end.rejected.length > 0)).map((t) => `${t.at}: ${t.end!.refusal ?? t.end!.rejected.join("; ")}`)),
    ...list("Failed executions or errors:", ticks.filter((t) => outcome.get(t) === "failed").map((t) => `${t.at}: ${t.end!.outcome}`)),
    ...list("Ticks that couldn't read their book or mandate:", unread.map((t) => t.at)),
    ...list("Unreadable evidence lines:", evidence.corrupt.map((n) => `line ${n}`)),
    "",
    "## What this does not show",
    "- Interventions made on a host directly (CLI, shell) are not in the gateway's record.",
    "- Custody guarantees: the bought asset is checked only by this server; per-asset caps are best-effort in the provider; USD-budget atomicity is unverified (docs/enforcement.md).",
    "- Economic benefit: no baseline, cost or time comparison is measured here.",
  ];
  return `${lines.join("\n")}\n`;
}
