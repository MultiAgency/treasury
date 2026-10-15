/**
 * A Sputnik DAO proposal as its contract returns it, and the `v1.signer` request inside one. Decoding
 * only, from what the chain shows everyone, so it imports nothing.
 */

export type DaoProposal = {
  id: number;
  proposer: string;
  description: string;
  status: string;
  submission_time: string;
  votes: Record<string, string>;
  kind: Record<string, Record<string, unknown>> | string;
};

/** The signing request inside a proposal, if it is a `v1.signer` sign call. */
export function signRequestOf(proposal: DaoProposal) {
  const call = typeof proposal.kind === "object" ? (proposal.kind.FunctionCall as { receiver_id: string; actions: { method_name: string; args: string }[] } | undefined) : undefined;
  if (call?.receiver_id !== "v1.signer" || call.actions.length !== 1 || call.actions[0]!.method_name !== "sign") return null;
  try {
    const { request } = JSON.parse(Buffer.from(call.actions[0]!.args, "base64").toString()) as {
      request: { path: string; payload_v2?: { Eddsa?: string }; domain_id: number };
    };
    const hash = request.payload_v2?.Eddsa;
    return hash ? { path: request.path, hash: hash.toLowerCase(), domainId: request.domain_id } : null;
  } catch {
    return null;
  }
}
