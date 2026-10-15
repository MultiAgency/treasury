import { api } from "./api.js";
import { notInForce } from "./authorize.js";
import { agentId, executes } from "./env.js";
import { liveGrant } from "./grants.js";
import { blocksDispatch, readOps } from "./ops.js";
import { loadStrategy } from "./strategy.js";
import { grantApproves, strategyDigest, strategyLabelSuffix } from "./strategy-digest.js";
import { strategyReadiness } from "./strategy-readiness.js";

/** Private observations for the dashboard. Never issues a grant, changes settings, or sends. */
export async function readStrategyStatus() {
  const [view, grants] = await Promise.all([api.getPolicy(agentId(), { signal: AbortSignal.timeout(5_000) }), api.listGrants(agentId(), { signal: AbortSignal.timeout(5_000) })]);
  const strategy = loadStrategy();
  const executor = executes();
  const grant = executor ? liveGrant(grants, process.env.AGENT_GRANT_TOKEN) : undefined;
  const grantMatches = executor ? Boolean(grant && grant.label.startsWith("treasury:") && grantApproves(grant.label, strategy)) : null;
  const on = process.env.AUTOPILOT === "on";
  const unresolved = readOps().filter(blocksDispatch).length;
  return {
    strategy, digest: strategyDigest(strategy), grantSuffix: strategyLabelSuffix(strategy),
    executor, on, grantMatches, unresolved,
    grant: grant ? { id: grant.grant_id, label: grant.label, expiresAt: grant.expires_at } : null,
    readiness: strategyReadiness({ executor, on, policyReason: notInForce(view), unresolved, grantMatches }),
    observedAt: new Date().toISOString(),
  };
}

export type StrategyStatus = Awaited<ReturnType<typeof readStrategyStatus>>;
