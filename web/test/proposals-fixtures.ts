// A scripted app server for the proposals page's tests: answers queued per route, and every request recorded.
import type { ProposalView } from "@multiagency/sdk";

export const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const ID = "a".repeat(32);

/** One clock for every fixture, so two proposals with the same terms have the same text. */
const NOW = Date.now();
/** A proposal as the platform shows it: one USDC to wNEAR swap, open for an hour. */
export function proposal(change: Partial<ProposalView> = {}): ProposalView {
  return {
    id: ID, requestId: "r1", agentId: "id-portfolio", deployment: "treasury", organization: "owner--near", source: "external",
    legs: [{ from: USDC, to: "nep141:wrap.near", amount: "5000000", minAmountOut: "1000000000000000000000000" }],
    quoted: [{ amountOut: "1100000000000000000000000", costBps: 12, usdIn: 5 }],
    policyRevision: 3, policyDigest: `sha256:${"b".repeat(64)}`, strategyDigest: `sha256:${"c".repeat(64)}`,
    createdAt: new Date(NOW - 60_000).toISOString(), expiresAt: new Date(NOW + 3_600_000).toISOString(), note: null,
    sha256: "d".repeat(64), state: "proposed", reason: null, approvedAt: null, planId: null, operations: [], ...change,
  };
}

export type Sent = { method: string; path: string; body: string; headers: Record<string, string>; credentials: RequestCredentials | undefined };
type Answer = () => Response;

/** A `fetch` answering from `script` (`"POST /api/…"` → answers in order); a route with no answer left fails the test. */
export function scripted() {
  const sent: Sent[] = [];
  const queues = new Map<string, Answer[]>();
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input), method = init?.method ?? "GET";
    sent.push({ method, path, body: typeof init?.body === "string" ? init.body : "", headers: Object.fromEntries(new Headers(init?.headers)), credentials: init?.credentials });
    const answer = queues.get(`${method} ${path}`)?.shift();
    if (!answer) throw new Error(`No answer for ${method} ${path}`);
    return answer();
  };
  const answer = (route: string, ...answers: Answer[]) => { queues.set(route, [...(queues.get(route) ?? []), ...answers]); };
  return { fetcher, sent, answer, routes: (method: string) => sent.filter(request => request.method === method).map(request => request.path) };
}

export const ok = (value: unknown, status = 200): Answer => () => Response.json({ ok: true, value }, { status });
export const fail = (failure: Record<string, unknown>, status: number): Answer => () => Response.json({ ok: false, ...failure }, { status });
export const refused = (code: string, status = 409) => fail({ kind: "refused", code }, status);
export const lost: Answer = () => { throw new TypeError("Failed to fetch"); };
