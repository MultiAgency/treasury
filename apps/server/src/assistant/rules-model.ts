import { ASSETS } from "@multiagency/sdk";
import type { AssistantModel, ModelReply, ModelRequest, TextBlock, ToolUseBlock } from "./model.ts";

/**
 * A deterministic stand-in for a language model (#219): `TREASURY_ASSISTANT_PROVIDER=rules`. It answers a fixed set of
 * question kinds (balances, budget use, limits, proposals, runs, Ballast's decisions) and drafts (a rebalance, new
 * targets, a budget or approval edit, a grant, a freeze) by keywords in the owner's question, through the same tools and
 * the same loop as a hosted model: each read is a tool call, audited and limited, and each figure cites the source it came from.
 *
 * It's for the stack's tests and for a deployment that wants the panel without sending any treasury data to a model
 * provider. Nothing leaves the server. What it does is chosen from the owner's own question only: text inside a tool
 * result (a proposal's note, an agent's reasons) is quoted, never read for what to do.
 */

type Block = TextBlock | ToolUseBlock;
type Result = { tool: string; source: string | null; data: any; error?: string };
type Intent =
  | { kind: "retarget"; percent: number; symbol: string }
  | { kind: "whatif"; dropPct: number }
  | { kind: "autopilot"; action: "on" | "off" | "run-now" }
  | { kind: "page"; page: string }
  | { kind: "risk" }
  | { kind: "policy"; budget?: { window: "daily" | "weekly" | "monthly"; usd: string }; ownerApproval?: boolean }
  | { kind: "freeze" | "grant" | "rebalance" | "decisions" | "budget" | "proposals" | "runs" | "limits" | "balances" };

/** What the owner asked for, read from their question alone. */
export function intentOf(question: string): Intent {
  const text = question.toLowerCase();
  const fall = /what if\b.*?(\d{1,3}(?:\.\d+)?)\s*%/.exec(text);
  if (fall && /\b(fall|falls|drop|drops|crash|crashes|dump|dumps|lose|loses)\b/.test(text)) return { kind: "whatif", dropPct: Number(fall[1]) };
  if (/\b(pause|stop|turn off|disable|switch off)\s+(the\s+)?autopilot\b/.test(text)) return { kind: "autopilot", action: "off" };
  if (/\b(turn on|enable|resume|start|switch on)\s+(the\s+)?autopilot\b/.test(text)) return { kind: "autopilot", action: "on" };
  if (/\brun\s+(the\s+)?autopilot\b|\brun now\b/.test(text)) return { kind: "autopilot", action: "run-now" };
  const page = /\b(?:open|go to|take me to|show me|navigate to)\b.*?\b(home|proposals|strategy|funding|policy|activity|agents)\b/.exec(text);
  if (page) return { kind: "page", page: page[1]! };
  const retarget = /(\d{1,3}(?:\.\d{1,2})?)\s*%\s*(?:in\s+|of\s+|to\s+)?([a-z][a-z0-9]{1,9})/.exec(text);
  if (retarget && /rebalanc|target|strateg|allocat|move/.test(text)) return { kind: "retarget", percent: Number(retarget[1]), symbol: retarget[2]! };
  const budget = /(daily|weekly|monthly)\s+budget\s+(?:to|at)\s+\$?(\d+(?:\.\d{1,2})?)/.exec(text);
  const approval = /\b(require|turn on)\s+(the\s+)?owner approval\b/.test(text) ? true : /\b(drop|turn off|stop requiring)\s+(the\s+)?owner approval\b/.test(text) ? false : undefined;
  if (budget || approval !== undefined)
    return { kind: "policy", ...(budget && { budget: { window: budget[1] as "daily", usd: budget[2]! } }), ...(approval !== undefined && { ownerApproval: approval }) };
  if (/\bfreeze\b|\bstop everything\b/.test(text) && !/\bwhy\b|\bfrozen\b/.test(text)) return { kind: "freeze" };
  if (/\brisk\b|\bstress\b|\bscenarios?\b|\bstabili[sz]|\bdrawdown\b|\brunway\b|\bthe level\b|\bwhat have you been doing\b/.test(text)) return { kind: "risk" };
  if (/\bwhy\b|\bdecision|\bballast\b|\bdidn.?t\b/.test(text)) return { kind: "decisions" };
  if (/\bbudget|\bspent\b|\bspend|\bleft\b/.test(text)) return { kind: "budget" };
  if (/\bproposals?\b|\bwaiting\b|\bapprov|\bpending\b/.test(text)) return { kind: "proposals" };
  if (/\brebalanc/.test(text)) return { kind: "rebalance" };
  if (/\bauthori[sz]e\b|\brenew\b|\bdraft a grant\b/.test(text)) return { kind: "grant" };
  if (/\blimits?\b|\bpolicy\b|\bcaps?\b|\ballowed\b/.test(text)) return { kind: "limits" };
  if (/\bruns?\b|\bautopilot\b|\bticks?\b/.test(text)) return { kind: "runs" };
  return { kind: "balances" };
}

const usd = (value: number | string | null | undefined) => value == null || !Number.isFinite(Number(value)) ? "no limit"
  : `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cite = (result: Result) => result.source ? ` [${result.source}]` : "";
const quote = (text: string) => `"${text.replace(/\s+/g, " ").trim()}"`;
const day = (iso: string | null | undefined) => iso ? iso.replace("T", " ").replace(/\.\d+Z$|Z$/, " UTC") : "unknown";
/** Units of a holding, from the smallest unit's decimal string. */
function units(raw: string, decimals: number) {
  const value = BigInt(raw), scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
  return `${(value / scale).toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

/** Targets that give `symbol` `percent`, the rest shared among the saved strategy's other assets as they're shared now, in hundredths. */
export function retargeted(savedBps: Record<string, number>, symbol: string, percent: number): Record<string, number> | undefined {
  const bySymbol = Object.fromEntries(Object.entries(savedBps).map(([asset, bps]) => [Object.entries(ASSETS).find(([, id]) => id === asset)?.[0] ?? asset, bps]));
  const named = Object.keys(bySymbol).find(entry => entry.toLowerCase() === symbol.toLowerCase());
  if (!named || percent > 100) return undefined;
  const others = Object.keys(bySymbol).filter(entry => entry !== named);
  const rest = 10_000 - Math.round(percent * 100), weight = others.reduce((sum, entry) => sum + bySymbol[entry]!, 0);
  const out: Record<string, number> = { [named]: Math.round(percent * 100) };
  let given = 0;
  others.forEach((entry, index) => {
    const share = index === others.length - 1 ? rest - given : Math.floor(rest * (weight > 0 ? bySymbol[entry]! / weight : 1 / others.length));
    out[entry] = share; given += share;
  });
  if (others.length === 0 && rest !== 0) return undefined;
  return Object.fromEntries(Object.entries(out).map(([entry, hundredths]) => [entry, hundredths / 100]));
}

function balances(overview: Result) {
  const holdings = overview.data.holdings as { symbol: string; usd: number | null; price_usd: number | null; price_at: string | null; public_units: string; confidential_units: string; decimals: number }[];
  const priced = holdings.filter(holding => holding.usd !== null);
  const total = priced.reduce((sum, holding) => sum + holding.usd!, 0);
  const lines = holdings.map(holding => `${holding.symbol}: ${units((BigInt(holding.public_units) + BigInt(holding.confidential_units)).toString(), holding.decimals)} (${holding.usd === null ? "unpriced" : usd(holding.usd)}${holding.price_usd !== null ? ` at ${usd(holding.price_usd)}, priced ${day(holding.price_at)}` : ""})`);
  return `The book is worth ${usd(total)}${priced.length < holdings.length ? " not counting unpriced holdings" : ""}${cite(overview)}.\n${lines.map(line => `- ${line}`).join("\n")}`;
}

function budget(overview: Result, activity: Result | undefined, question: string) {
  const usage = overview.data.policy.budget_usage as Record<"daily" | "weekly" | "monthly", { limit_usd: string | null; spent_usd: string; remaining_usd: string | null; resets_at: string | null } | undefined>;
  const order = /\bweek/.test(question) ? (["weekly", "monthly", "daily"] as const) : /\bday\b|\btoday\b|\bdaily\b/.test(question) ? (["daily", "weekly", "monthly"] as const) : (["monthly", "weekly", "daily"] as const);
  const limited = order.filter(window => usage[window]?.limit_usd != null);
  const label = { daily: "Today", weekly: "This week", monthly: "This month" } as const;
  const lines = limited.map(window => { const entry = usage[window]!; return `${label[window]}: ${usd(entry.remaining_usd)} of ${usd(entry.limit_usd)} left, ${usd(entry.spent_usd)} spent; it resets ${day(entry.resets_at)}${cite(overview)}.`; });
  const head = lines.length ? lines.join("\n") : `The signed policy sets no USD budget, so nothing is counted against one${cite(overview)}. Spent so far this month: ${usd(usage.monthly?.spent_usd ?? 0)}${cite(overview)}.`;
  if (!activity || activity.error) return head;
  const entries = (activity.data.entries ?? []) as { at: string; kind: string; status?: string }[];
  const used = entries.slice(-5).reverse().map(entry => `${entry.kind} on ${day(entry.at)}${entry.status ? ` (${entry.status})` : ""}`);
  return `${head}\nWhat used it: ${used.length ? `the latest recorded actions are ${used.join("; ")}${cite(activity)}.` : `no actions are recorded${cite(activity)}.`}`;
}

function limits(overview: Result) {
  const policy = overview.data.policy.in_force as { budget?: Record<string, string | null>; max_actions_per_hour?: number | null; owner_approval?: boolean; actions?: string[]; frozen?: boolean; assets?: "any" | string[] } | null;
  if (!policy) return `No signed policy is in force${cite(overview)}.`;
  const budgets = (["daily", "weekly", "monthly"] as const).map(window => `${window} ${usd(policy.budget?.[`${window}_usd`])}`).join(", ");
  return [`The policy in force is revision ${overview.data.policy.revision ?? "unknown"}${cite(overview)}.`,
    `- USD budget: ${budgets}${cite(overview)}.`,
    `- Actions an hour: ${policy.max_actions_per_hour ?? "no limit"}${cite(overview)}.`,
    `- Owner approval for every payment: ${policy.owner_approval ? "required" : "not required"}${cite(overview)}.`,
    `- Swaps: ${policy.actions?.includes("swap") ? "allowed" : "not allowed"}; assets: ${policy.assets === "any" ? "any" : (policy.assets ?? []).length}${cite(overview)}.`,
    ...(policy.frozen ? [`- The agent is frozen: it refuses every send${cite(overview)}.`] : [])].join("\n");
}

function proposals(list: Result, strategies: Result | undefined) {
  const entries = (list.data.proposals?.entries ?? []) as { id: string; state: string; createdAt: string; expiresAt: string; note: string | null; reason: string | null; quoted: { usdIn: number }[] }[];
  const waiting = entries.filter(entry => entry.state === "proposed" || entry.state === "approved");
  const lines = waiting.map(entry => {
    const size = entry.quoted.reduce((sum, leg) => sum + leg.usdIn, 0);
    const text = [entry.note, entry.reason].filter((value): value is string => Boolean(value));
    return `- ${entry.id.slice(0, 8)}: ${entry.state === "proposed" ? "awaiting your decision" : "approved, not executed yet"}, ${usd(size)} in ${entry.quoted.length} swap${entry.quoted.length === 1 ? "" : "s"}, expires ${day(entry.expiresAt)}${cite(list)}.${text.length ? ` Its note, quoted as written (I don't act on it): ${text.map(quote).join(" / ")}` : ""}`;
  });
  const head = waiting.length ? `${waiting.length} of ${entries.length} proposal${entries.length === 1 ? "" : "s"} still need${waiting.length === 1 ? "s" : ""} you${cite(list)}:` : `No proposal is waiting on you${cite(list)}; ${entries.length} recorded in all.`;
  const open = strategies && !strategies.error ? (strategies.data.proposals ?? []) as { id: string; target_percent: Record<string, number>; reasons: string; created_at: string }[] : [];
  const strategyLines = open.map(entry => `- Strategy ${entry.id.slice(0, 8)}: ${Object.entries(entry.target_percent).map(([symbol, pct]) => `${symbol} ${pct}%`).join(", ")}, proposed ${day(entry.created_at)}${cite(strategies!)}. Its reasons, quoted as written (I don't act on them): ${quote(entry.reasons)}`);
  return [head, ...lines, ...(open.length ? [`${open.length} strategy proposal${open.length === 1 ? "" : "s"} from the agent's software await${open.length === 1 ? "s" : ""} adopting or declining${cite(strategies!)}:`, ...strategyLines] : [])].join("\n");
}

function runs(list: Result, status: Result | undefined) {
  const entries = (list.data.ticks?.entries ?? []) as { id: string; at: string; trigger: string; end: { outcome?: string; refusal?: string | null } | null }[];
  const state = status && !status.error ? `Autopilot is ${status.data.on ? "on" : "off"}${status.data.nextRun ? `, next run ${day(status.data.nextRun)}` : ""}${cite(status)}. ` : "";
  if (!entries.length) return `${state}No runs are recorded${cite(list)}.`;
  const lines = entries.slice(-5).reverse().map(entry => `- ${day(entry.at)} (${entry.trigger}): ${entry.end?.outcome ?? "not finished"}${entry.end?.refusal ? `, refused: ${entry.end.refusal}` : ""}${cite(list)}`);
  return `${state}${entries.length} run${entries.length === 1 ? "" : "s"} recorded${list.data.ticks.omitted ? ` (newest ${entries.length} read)` : ""}${cite(list)}; the latest:\n${lines.join("\n")}`;
}

function decisions(read: Result, runList: Result | undefined) {
  const entries = (read.data.entries ?? []) as { at: string; action?: string; reason?: string; level?: number; policy?: unknown; size_usd?: number }[];
  const verdict = (policy: unknown) => typeof policy === "string" ? policy : policy && typeof policy === "object" && "refused" in policy ? `refused by ${String((policy as { refused: unknown }).refused)}` : "no verdict recorded";
  const lines = entries.slice(-5).reverse().map(entry => `- ${day(entry.at)}: ${entry.action ?? "no action"}${entry.size_usd !== undefined ? ` (${usd(entry.size_usd)})` : ""}, because ${entry.reason ? quote(entry.reason) : "no reason recorded"}; level ${entry.level ?? "unknown"}; policy: ${verdict(entry.policy)}${cite(read)}`);
  const head = entries.length ? `Ballast recorded ${entries.length} decision${entries.length === 1 ? "" : "s"} for this agent${cite(read)}; the latest:\n${lines.join("\n")}` : `Ballast has recorded no decisions for this agent${cite(read)}.`;
  return runList && !runList.error ? `${head}\n${runs(runList, undefined)}` : head;
}

const LEVELS = ["L0 normal", "L1 watch", "L2 caution", "L3 critical", "L4 red hand"];
const pct = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "unknown" : `${Number(value.toFixed(2))}%`;

function riskReport(result: Result, history: Result | undefined) {
  const report = result.data?.report as { at: string; level: number; reason: string; projection: { usable: boolean; projectedDrawdownPct: number; expectedShortfallPct: number; breachProbabilityPct: number; runwayMonths: number };
    scenarios: { label: string; drawdownPct: number; floorBreached: boolean }[]; recommendations: { action: string; reason: string }[]; proposed: boolean } | null | undefined;
  if (!report) return `No forward risk assessment has been recorded for this agent yet; the stabilization agent may not be configured for it${cite(result)}.`;
  const p = report.projection;
  const top = report.scenarios.slice(0, 3).map(scenario => `${scenario.label} (${pct(scenario.drawdownPct)} drawdown${scenario.floorBreached ? ", breaks the cash floor" : ""})`);
  const lines = [`The forward risk level is ${LEVELS[report.level] ?? `L${report.level}`}: ${quote(report.reason)}${cite(result)}, assessed ${day(report.at)}.`,
    p.usable ? `Projected drawdown ${pct(p.projectedDrawdownPct)}, expected shortfall ${pct(p.expectedShortfallPct)}, ${pct(p.breachProbabilityPct)} chance of breaching the cash floor, ${Number(p.runwayMonths.toFixed(1))} months of runway${cite(result)}.`
      : `The projection wasn't usable on the last assessment, so its figures are held at the conservative reading${cite(result)}.`,
    `The most severe scenarios: ${top.join("; ")}${cite(result)}.`,
    report.recommendations.length ? `What I would do: ${report.recommendations.map(r => r.action.replace(/-/g, " ")).join(", ")}${report.proposed ? "; a de-risk proposal is waiting for your approval" : ""}${cite(result)}.` : `Nothing: every scenario is within its steps${cite(result)}.`];
  const entries = history && !history.error ? (history.data?.entries ?? []) as { at: string; level: number }[] : [];
  if (entries.length > 1) lines.push(`I have made ${entries.length} recent assessments; the level was ${entries.slice(0, 5).map(entry => entry.level).join(", ")} newest first${cite(history!)}.`);
  return lines.join("\n");
}

function whatIfAnswer(result: Result) {
  const r = result.data as { label: string; now: { valueUsd: number; stableUsd: number; runwayMonths: number }; after: { valueUsd: number; lossUsd: number; drawdownPct: number; stableUsd: number; runwayMonths: number; floorBreached: boolean; tradable: boolean } };
  return [`If ${r.label}: the book would be worth ${usd(r.after.valueUsd)} instead of ${usd(r.now.valueUsd)} (${usd(r.after.lossUsd)} lost, ${pct(r.after.drawdownPct)})${cite(result)}.`,
    `The stables would fund ${Number(r.after.runwayMonths.toFixed(1))} months instead of ${Number(r.now.runwayMonths.toFixed(1))}, and the cash floor ${r.after.floorBreached ? "would break" : "would hold"}${cite(result)}. I ${r.after.tradable ? "could" : "could not"} still trade through it${cite(result)}.`,
    "This is arithmetic on the last recorded book, not a forecast, and nothing was proposed."].join("\n");
}

function drafted(result: Result) {
  const draft = result.data?.drafted;
  if (!draft) return "";
  const changes = (draft.changes ?? []) as { field: string; from: string; to: string }[];
  const legs = (draft.legs ?? []) as { sell: string; buy: string; usd: number }[];
  if (draft.kind === "page") return `Opening the ${draft.page} page: ${draft.why}. Nothing changes.`;
  if (draft.kind === "autopilot") return `I've opened the autopilot controls to ${({ on: "turn it on", off: "turn it off", "run-now": "run it once" } as Record<string, string>)[draft.action]}. You confirm it on the Strategy page; nothing is sent from here${cite(result)}.`;
  const what = { strategy: "a strategy change", policy: "a policy edit", rebalance: "a rebalance proposal", grant: "a grant", freeze: "a freeze" }[draft.kind as string] ?? "a change";
  return [`I've drafted ${what} for you to review${cite(result)}. Nothing is sent until you submit it and sign in your wallet (or the DAO votes).`,
    ...changes.map(change => `- ${change.field}: ${change.from} → ${change.to}`),
    ...(legs.length ? [`A rebalance to it would swap, at current prices: ${legs.map(leg => `${leg.sell} → ${leg.buy} ${usd(leg.usd)}`).join("; ")}${cite(result)}.`] : [])].join("\n");
}

const say = (text: string): Block => ({ type: "text", text });
let calls = 0;
const use = (name: string, input: Record<string, unknown> = {}): Block => ({ type: "tool_use", id: `toolu_rules_${++calls}`, name, input });
const reply = (content: Block[]): ModelReply => ({ content, stop_reason: content.some(block => block.type === "tool_use") ? "tool_use" : "end_turn", model: "rules" });

/** The tool results the last message carried, with the tool each answers, read from the message before it. */
function lastResults(messages: ModelRequest["messages"]): Result[] | undefined {
  const last = messages.at(-1), before = messages.at(-2);
  if (last?.role !== "user" || typeof last.content === "string" || !before || typeof before.content === "string") return undefined;
  const names = new Map((before.content ?? []).flatMap(block => block.type === "tool_use" ? [[block.id, block.name] as const] : []));
  return (last.content ?? []).flatMap(block => {
    if (block.type !== "tool_result") return [];
    const tool = names.get(block.tool_use_id) ?? "unknown";
    const text = typeof block.content === "string" ? block.content : "";
    if (block.is_error) return [{ tool, source: null, data: null, error: text }];
    try { const body = JSON.parse(text) as { source: string | null; data: unknown }; return [{ tool, source: body.source, data: body.data }]; }
    catch { return [{ tool, source: null, data: null, error: "unreadable result" }]; }
  });
}

export function rulesModel(): AssistantModel {
  return {
    name: "rules",
    async respond({ system, tools, messages }) {
      const question = [...messages].reverse().find(message => message.role === "user" && typeof message.content === "string")?.content as string ?? "";
      const intent = intentOf(question);
      const results = lastResults(messages);
      // The stabilization agent has fewer tools: a request for one it wasn't given is said to be the other agent's, never tried.
      const offered = new Set(tools.map(tool => tool.name));
      const stabilization = system.startsWith("You are the stabilization agent");
      const needs: Partial<Record<Intent["kind"], string>> = { retarget: "draft_strategy", policy: "draft_policy_edit", grant: "draft_grant" };
      const wanted = needs[intent.kind];
      if (!results && wanted && !offered.has(wanted)) return reply([say("I watch forward risk; I can't edit the strategy, the policy or a grant. The treasury assistant does that: ask it on this page, or open the Strategy or Policy page.")]);
      if (!results && stabilization && ["balances", "limits", "budget"].includes(intent.kind)) return reply([use("get_risk_report"), use("get_risk_history", { limit: 10 })]);
      if (!results) switch (intent.kind) {
        case "whatif": return reply([use("run_what_if", { volatileDropPct: intent.dropPct })]);
        case "autopilot": return reply([use("draft_autopilot", { action: intent.action })]);
        case "page": return reply([use("open_page", { page: intent.page, why: `where you can see ${intent.page}` })]);
        case "risk": return reply([use("get_risk_report"), use("get_risk_history", { limit: 10 })]);
        case "retarget": return reply([use("get_strategy")]);
        case "policy": return reply([use("get_overview")]);
        case "freeze": return reply([use("draft_freeze", { reason: question.slice(0, 300) })]);
        case "grant": return reply([use("draft_grant")]);
        case "rebalance": return reply([use("draft_rebalance")]);
        case "decisions": return reply([use("get_ballast_decisions", { limit: 10 }), use("get_runs", { limit: 5 })]);
        case "budget": return reply([use("get_overview"), use("get_activity", { limit: 5 })]);
        case "proposals": return reply([use("list_proposals"), use("list_strategy_proposals")]);
        case "runs": return reply([use("get_runs", { limit: 5 }), use("get_autopilot")]);
        case "limits": case "balances": return reply([use("get_overview")]);
      }
      const by = (tool: string) => results.find(result => result.tool === tool);
      const failed = results.filter(result => result.error);
      // A read that failed is said, never filled in.
      const failures = failed.map(result => `I couldn't read that (${result.tool}): ${result.error}`).join("\n");
      const first = results[0]!;

      if (intent.kind === "retarget" && first.tool === "get_strategy") {
        if (first.error) return reply([say(failures)]);
        const targets = retargeted(first.data.strategy.targetBps, intent.symbol, intent.percent);
        if (!targets) return reply([say(`The saved strategy targets ${Object.keys(first.data.strategy.targetBps).length} assets, and ${quote(intent.symbol)} at ${intent.percent}% can't be drafted from it${cite(first)}. Nothing was drafted.`)]);
        return reply([use("draft_strategy", { targets })]);
      }
      if (intent.kind === "policy" && first.tool === "get_overview") {
        if (first.error) return reply([say(failures)]);
        const inForce = first.data.policy.in_force?.budget ?? {};
        const input: Record<string, unknown> = {};
        if (intent.budget) input.budget = { daily_usd: inForce.daily_usd ?? null, weekly_usd: inForce.weekly_usd ?? null, monthly_usd: inForce.monthly_usd ?? null, [`${intent.budget.window}_usd`]: intent.budget.usd };
        if (intent.ownerApproval !== undefined) input.owner_approval = intent.ownerApproval;
        return reply([use("draft_policy_edit", input)]);
      }
      if (first.tool.startsWith("draft_")) return reply([say(first.error ? `Nothing was drafted: ${first.error}` : drafted(first))]);
      if (failed.length === results.length) return reply([say(failures)]);

      const overview = by("get_overview");
      const report = by("get_risk_report");
      if (report && !report.error && (intent.kind === "risk" || stabilization)) return reply([say(riskReport(report, by("get_risk_history")))]);
      const whatIf = by("run_what_if");
      if (whatIf) return reply([say(whatIf.error ? `I couldn't run that: ${whatIf.error}` : whatIfAnswer(whatIf))]);
      const text = intent.kind === "budget" && overview && !overview.error ? budget(overview, by("get_activity"), question.toLowerCase())
        : intent.kind === "limits" && overview && !overview.error ? limits(overview)
        : intent.kind === "proposals" && by("list_proposals") && !by("list_proposals")!.error ? proposals(by("list_proposals")!, by("list_strategy_proposals"))
        : intent.kind === "runs" && by("get_runs") && !by("get_runs")!.error ? runs(by("get_runs")!, by("get_autopilot"))
        : intent.kind === "decisions" && by("get_ballast_decisions") && !by("get_ballast_decisions")!.error ? decisions(by("get_ballast_decisions")!, by("get_runs"))
        : overview && !overview.error ? balances(overview) : failures;
      return reply([say(failed.length && text !== failures ? `${text}\n${failures}` : text)]);
    },
  };
}
