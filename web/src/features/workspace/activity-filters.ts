import type { OwnerOutput } from "@multiagency/sdk";
import type { Decoded } from "@multiagency/sdk";

// The same API type as shared/query-source, without importing browser client modules into pure tests.
type Operation = OwnerOutput<"activity">[number];
type OwnerAction = OwnerOutput<"owner/actions">[number];
type Run = OwnerOutput<"autopilot/evidence">["ticks"][number];

export type HistoryType = "money" | "owner" | "run" | "test" | "proposal";
export type HistoryFilters = { search: string; type: HistoryType | ""; status: string; from: string; to: string };
export const EMPTY_HISTORY_FILTERS: HistoryFilters = { search: "", type: "", status: "", from: "", to: "" };
export type HistoryRecord = { type: HistoryType; status: string; at?: string; search: string };

const searchable = (...values: unknown[]) => values.filter(value => typeof value === "string" || typeof value === "number").join(" ");
const words = (value: string) => value.replaceAll("_", " ").replaceAll("-", " ");
const probeKinds = new Set(["refusal", "verify-refusal", "probe"]);

/** Display classification only; the separate unresolved query determines dispatch blockers. */
export function describeOperation(op: Operation): HistoryRecord {
  const type = probeKinds.has(op.kind) ? "test" : "money";
  return {
    type, status: `${type}:${op.refused !== undefined ? "refused" : op.status || "unknown"}`, at: op.at,
    search: searchable(op.kind, words(op.kind), op.correlationId, op.status, op.refused,
      op.request.recipient, op.request.asset, op.request.origin_asset, op.request.destination_asset, op.request.amount,
      op.policyDigest, op.policyRevision, op.planId),
  };
}

export function describeOwner(action: OwnerAction): HistoryRecord {
  return {
    type: "owner", status: `owner:${action.stage}`,
    // expiresAt is a signing deadline. The API exposes no creation timestamp for owner actions.
    search: searchable(action.type, words(action.type), action.correlationId, action.signer, action.stage,
      action.status, action.failureCode, action.payment?.correlationId, action.payment?.verdict),
  };
}

export function describeRun(run: Run): HistoryRecord {
  return {
    type: "run", status: `run:${run.end ? "ended" : "open"}`, at: run.at,
    search: searchable(run.id, run.trigger, run.end?.outcome, run.end?.refusal, ...(run.end?.rejected ?? [])),
  };
}

export function describeProposal(proposal: Decoded): HistoryRecord {
  return {
    type: "proposal", status: `proposal:${proposal.status}`, at: proposal.submittedAt,
    search: searchable(proposal.id, `#${proposal.id}`, proposal.description, proposal.proposer, proposal.hash,
      proposal.status, proposal.what, ...(proposal.what === "agent" ? [proposal.agent, proposal.type,
        words(proposal.type), proposal.correlationId] : [])),
  };
}

const dayOf = (date: Date) => `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const validDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && dayOf(new Date(`${value}T12:00:00`)) === value;

/** History filters never classify unknown timing as evidence that a record is outside the range. */
export function matchesHistory(record: HistoryRecord, filters: HistoryFilters): boolean {
  if (filters.type && record.type !== filters.type || filters.status && record.status !== filters.status) return false;
  const haystack = record.search.toLowerCase();
  if (!filters.search.trim().toLowerCase().split(/\s+/).every(token => haystack.includes(token))) return false;
  const date = record.at ? new Date(record.at) : undefined;
  if (!date || !Number.isFinite(date.getTime())) return true;
  // Date.parse normalizes impossible ISO calendar dates, so reject those as unknown too.
  const calendarDay = record.at!.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (calendarDay && !validDay(calendarDay)) return true;
  const day = dayOf(date);
  const from = validDay(filters.from) ? filters.from : "";
  const to = validDay(filters.to) ? filters.to : "";
  return (!from || day >= from) && (!to || day <= to);
}

const categories: Record<HistoryType, string> = { money: "Money action", owner: "Owner action", run: "Run", test: "Policy test", proposal: "DAO proposal" };
const statusLabels: Record<string, string> = {
  "owner:prepared": "Prepared", "owner:submitted": "Submission attempted", "owner:settled": "Settled", "owner:expired": "Signing window closed",
  "run:ended": "Recorded end", "run:open": "No recorded end", "proposal:InProgress": "Voting in progress",
};

export function historyStatusLabel(status: string): string {
  const separator = status.indexOf(":");
  const type = status.slice(0, separator) as HistoryType;
  const value = status.slice(separator + 1);
  if (separator < 0 || !(type in categories)) return status;
  const readable = words(value).toLowerCase();
  return `${categories[type]} · ${statusLabels[status] ?? readable.charAt(0).toUpperCase() + readable.slice(1)}`;
}
