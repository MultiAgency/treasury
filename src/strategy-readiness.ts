/** Presentation of current observations only. Dispatch remains the authorization boundary. */
export function strategyReadiness(facts: {
  executor: boolean;
  on: boolean;
  policyReason: string | null;
  unresolved: number;
  grantMatches: boolean | null;
}) {
  const reasons: string[] = [];
  if (!facts.executor) reasons.push("This host is approve-only. Check strategy authorization and configure scheduled runs on its executor.");
  if (facts.policyReason) reasons.push(`Policy not in force: ${facts.policyReason}.`);
  if (facts.unresolved > 0) reasons.push(`${facts.unresolved} unresolved operation${facts.unresolved === 1 ? "" : "s"} block new sends.`);
  if (facts.executor && !facts.grantMatches) reasons.push("The owner must issue a matching grant before this strategy can act on its schedule.");
  const state = !facts.executor ? "approve-only"
    : facts.policyReason || facts.unresolved > 0 ? "blocked"
      : !facts.grantMatches ? "authorization-required"
        : facts.on ? "ready" : "off";
  return { state, reasons, canEnable: reasons.length === 0 } as const;
}
