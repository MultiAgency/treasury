// The hedge plan as one assistant tool (#221, #219): a read, scoped to one agent, that answers what the hedge page shows.
// It lives apart from `assistant/tools.ts` so that module's own list is the assistant's to change: registering this is
// three lines there (its definition in `TOOL_DEFINITIONS`, its name in `PLATFORM_TOOLS`, a case in `runTool` that calls
// `hedgeTool` with the scope below). Like every tool it reads and drafts nothing it can send: a move becomes a proposal only
// through the owner's own click on the hedge page (`POST …/hedge/propose`), which plans again.
//
// The answer is data: NEAR Intents' list and quotes are untrusted text and numbers, trimmed here to the fields the
// planner reads, and the assistant's frozen instructions already say a record's words are quoted, never followed.

import type { Platform } from "./platform.ts";
import type { ToolDefinition } from "./assistant/model.ts";
import type { BallastSettings } from "./ballast.ts";
import { buildHedge } from "./hedge.ts";
import type { Intents } from "./intents.ts";
import type { LatestRisk } from "./risk.ts";

export const HEDGE_TOOL: ToolDefinition = {
  name: "get_hedge_plan",
  description: "Read the treasury's hedge plan: NEAR Intents' live token list against the asset registry (each asset's live USD price, whether the "
    + "platform can trade it, and any drift), and the moves the planner would make into gold and other chains' assets, each executable now or blocked "
    + "with every reason by code. Nothing is proposed by reading it.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
};

export type HedgeToolScope = {
  platform: Pick<Platform, "reads">;
  organization: string;
  agent: string;
  /** Who is asking, as the audit log records it. */
  who: string;
  settings: BallastSettings | undefined;
  intents?: Intents;
  latestRisk?: LatestRisk;
  now: () => number;
};

/** The tool's outcome in the assistant's own shape: its content for the model and the source it cites, or an error. */
export async function hedgeTool(scope: HedgeToolScope): Promise<{ content: unknown; source: { label: string; read: string; at: string } } | { error: string }> {
  const overview = await scope.platform.reads.overview(scope.organization, scope.agent);
  if (!overview.ok) return { error: "the agent's overview couldn't be read, so the hedge can't be planned" };
  const { read } = await buildHedge({ ...(scope.intents && { intents: scope.intents }), ...(scope.latestRisk && { latestRisk: scope.latestRisk }), now: scope.now },
    { who: scope.who, organization: scope.organization, agent: scope.agent, overview: overview.value, settings: scope.settings });
  return {
    content: {
      intents: read.intents, forwardRiskLevel: read.level, configured: read.configured, problems: read.problems,
      registry: read.registry.map(({ symbol, class: cls, chain, proposable, listed, priceUsd, heldUsd, drift }) => ({ symbol, class: cls, chain, platformCanTrade: proposable, onNearIntentsList: listed, priceUsd, heldUsd, drift })),
      moves: read.plan?.moves.map(({ id, kind, shape, from, to, sizeUsd, status, blocked, quote, reason }) => ({ id, kind, shape, from, to, sizeUsd, status, blocked, quote, reason })) ?? [],
      notes: read.plan?.notes ?? [],
    },
    source: { label: "the hedge plan and NEAR Intents' live list", read: "hedge plan", at: new Date(scope.now()).toISOString() },
  };
}
