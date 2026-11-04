import type { OwnerFailure, OwnerInputs, OwnerOutput, ProposalView } from "@multiagency/sdk";

type SweepEvent = OwnerOutput<"sweep">;
type PlanEvent = OwnerOutput<"executePlan">;
/** One send an execution reported: a sweep's shield, a plan's leg (with the shield it needed first), or a proposal's operation. */
export type Send = Extract<SweepEvent, { type: "shield" }> | Extract<PlanEvent, { type: "action" }> | ProposalView["operations"][number];
/** At least one send went out, and not every one succeeded: funds may have moved. `problems` are the executor's, when it rejected the rest. */
export type PartialOutcome = { ok: false; kind: "partial"; sends: readonly Send[]; problems?: string[] };
export type Outcome = { ok: true } | OwnerFailure | PartialOutcome;

/** What an execution reported, one case per procedure. */
export type Report =
  | { procedure: "sweep"; input: OwnerInputs["sweep"]; events: readonly SweepEvent[]; ended: OwnerFailure | undefined }
  | { procedure: "executePlan"; input: OwnerInputs["executePlan"]; events: readonly PlanEvent[]; ended: OwnerFailure | undefined }
  | { procedure: "proposal"; view: ProposalView };

/**
 * A provider status (the platform's `src/ops.ts`): only NOT_SENT proves nothing was sent; FAILED and REFUNDED were sent
 * and settled; anything else was sent and hasn't settled.
 */
export const classify = (status: string) =>
  status === "NOT_SENT" ? "unsent" : status === "SUCCESS" ? "succeeded" : status === "FAILED" || status === "REFUNDED" ? "failed" : "unsettled";

/** Nothing was sent: `error` carries the platform's problems or reason, and the wording is `failureMessage`'s. */
const notSent = (error = ""): OwnerFailure => ({ ok: false, kind: "refused", code: "NOT_SENT", error });

/**
 * Decides an execution from what it reported, not from how its stream ended (the CLI's `settle`): the executor rejects a
 * plan before any send or after earlier ones moved funds, and ends normally after a send that didn't succeed. `offerAgain`
 * is false when funds may have moved (unknown or partial) and true when the outcome proves nothing new is in flight.
 */
export function settle(report: Report): { outcome: Outcome; offerAgain: boolean } {
  const outcome = decide(report);
  return { outcome, offerAgain: outcome.ok || (outcome.kind !== "unknown" && outcome.kind !== "partial") };
}

function decide(report: Report): Outcome {
  switch (report.procedure) {
    case "sweep": {
      // A preview takes no money lock and returns after its plan, before any shield is sent: a lost preview is a lost read.
      if (!report.input.execute && report.ended?.kind === "unknown") return { ok: false, kind: "unavailable" };
      const shields = report.events.filter(event => event.type === "shield");
      return fromSends(report, shields.map(shield => ({ send: shield, statuses: [shield.status] })), null);
    }
    case "executePlan": {
      const legs = report.events.filter(event => event.type === "action");
      const rejected = report.events.find(event => event.type === "rejected")?.problems ?? null;
      return fromSends(report, legs.map(leg => ({ send: leg, statuses: leg.shield ? [leg.status, leg.shield.status] : [leg.status] })), rejected);
    }
    case "proposal": {
      // The platform's own verdict (`src/proposals/store.ts`, `proposalState`).
      const { view } = report;
      switch (view.state) {
        case "executed": return { ok: true };
        // `approved` is read back only after a lost execute answer, and execution re-quotes before it claims
        // (`src/proposals/service.ts`, `executeProposal`): the first call may still be running.
        case "executing": case "unknown": case "approved": return { ok: false, kind: "unknown", procedure: "proposals/execute", identity: { id: view.id } };
        // A refused operation is proven unsent (`src/ops.ts`, `isResolved`).
        case "stopped": return view.operations.every(op => op.refused !== null)
          ? notSent(view.reason ?? undefined) : { ok: false, kind: "partial", sends: view.operations };
        // Never claimed for execution, and never will be: nothing was sent.
        case "proposed": case "rejected": case "withdrawn": case "expired": case "invalidated": return notSent(view.reason ?? undefined);
      }
    }
  }
}

/** A stream's sends, each with its own status and, for a leg, the shield sent before it. */
function fromSends(report: Extract<Report, { ended: unknown }>, sends: { send: Send; statuses: string[] }[], rejected: string[] | null): Outcome {
  const { ended } = report;
  // The SDK reports a stream lost after any event as unknown; so is any send that went out and hasn't settled.
  if (ended?.kind === "unknown" || sends.some(({ statuses }) => statuses.some(status => classify(status) === "unsettled")))
    return { ok: false, kind: "unknown", procedure: report.procedure, identity: report.input };
  const sent = sends.filter(({ statuses }) => statuses.some(status => classify(status) !== "unsent"));
  if (!sent.length) return sends.length || rejected ? notSent(rejected?.join("; ")) : ended ?? { ok: true };
  if (ended || rejected || sends.some(({ statuses }) => classify(statuses[0]!) !== "succeeded"))
    return { ok: false, kind: "partial", sends: sends.map(({ send }) => send), ...(rejected && { problems: rejected }) };
  return { ok: true };
}
