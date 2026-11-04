/**
 * Every call the proposals page makes: the app server's own `/api/` routes, same-origin, under its session cookie. No
 * other module of the page calls a server, and the page never calls the platform: `/apps/v1` is server to server. Each
 * answer is parsed with the server's own contract (`apps/server/src/contract.ts`), and decided by `kind` and `code`,
 * never by message text. Nothing here ever sends a call again.
 */
import { proposalId, proposalList } from "@multiagency/sdk";
import { z } from "zod";
// With their extensions: test/proposals-api.test.ts loads these modules under Node, which resolves only explicit `.ts` paths.
import * as contract from "../../../apps/server/src/contract.ts";

/**
 * An answer the page couldn't read: the request or its reply was lost, or the reply didn't match the contract. Reading
 * again is safe; after a write, its outcome is unknown, so the page reads before anything else.
 */
export type Lost = { ok: false; kind: "lost" };
export type Failure = contract.ServerFailure | Lost;
export type Result<T> = { ok: true; value: T } | Failure;
export type Verdict = "approve" | "reject";
/** What the owner's wallet signs: a NEP-413 message for `recipient`, with `nonce` (base64 of 32 bytes). */
export type SignRequest = { message: string; recipient: string; nonce: string };
export type Signed = { accountId: string; publicKey: string; signature: string };

const LOST: Lost = { ok: false, kind: "lost" };
/** Sign-out answers nothing but that it happened. */
const nothing = z.strictObject({});

/** The server's API over `fetcher` (the browser's `fetch` by default; tests pass their own). */
export function proposalsApi(fetcher: typeof fetch = (input, init) => fetch(input, init)) {
  /** One call. A write is a POST with a JSON body (the server requires one) or a bodiless DELETE. */
  async function call<S extends z.ZodType>(schema: S, path: string, write?: { method: "POST"; body?: unknown } | { method: "DELETE" }): Promise<Result<z.output<S>>> {
    const init: RequestInit = write?.method === "POST"
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(write.body ?? {}) }
      : { method: write?.method ?? "GET" };
    let body: unknown;
    try { body = await (await fetcher(path, { ...init, credentials: "same-origin" })).json(); } catch { return LOST; }
    if (typeof body === "object" && body !== null && "ok" in body && body.ok === true) {
      const value = schema.safeParse("value" in body ? body.value : undefined);
      return value.success ? { ok: true, value: value.data } : LOST;
    }
    const failure = contract.serverFailure.safeParse(body);
    return failure.success ? failure.data : LOST;
  }

  return {
    /** The text the wallet signs to sign in to this server. */
    challenge: () => call(contract.challenge, "/api/session/challenge", { method: "POST" }),
    signIn: (signed: z.input<typeof contract.signIn>) => call(contract.session, "/api/session", { method: "POST", body: contract.signIn.parse(signed) }),
    signOut: () => call(nothing, "/api/session", { method: "DELETE" }),
    /** One agent's routes; each needs the signed-in account to be its owner. */
    agent(name: string) {
      const base = `/api/agents/${contract.agentName.parse(name)}`;
      const proposal = (id: string) => `${base}/proposals/${proposalId.parse(id)}`;
      return {
        /** Its owner, its ID and the platform's host: the NEP-413 recipient for every platform text. */
        identity: () => call(contract.agent, base),
        consent: () => call(contract.consent, `${base}/consent`),
        /** The consent text for the owner's wallet, built by the server from the agent as the platform answers it now. */
        consentText: () => call(contract.consentText, `${base}/consent/text`, { method: "POST" }),
        connect: (submission: z.input<typeof contract.consentSubmission>) =>
          call(contract.consent, `${base}/consent`, { method: "POST", body: contract.consentSubmission.parse(submission) }),
        disconnect: () => call(contract.revoked, `${base}/consent/revoke`, { method: "POST" }),
        proposals: () => call(proposalList, `${base}/proposals`),
        proposal: (id: string) => call(contract.proposalRead, proposal(id)),
        verdict: (id: string, verdict: Verdict, signed: z.input<typeof contract.verdictSubmission>) =>
          call(contract.proposalRead, `${proposal(id)}/${verdict}`, { method: "POST", body: contract.verdictSubmission.parse(signed) }),
        /** Asks for an approved proposal's execution, once. Never called again for an answer that was lost. */
        execute: (id: string) => call(contract.executeResult, `${proposal(id)}/execute`, { method: "POST" }),
        /**
         * A DAO-owned agent's consent request, read by the server from the platform: reading it after the DAO's vote
         * passed is what stores the consent, so it's safe and needed to read again.
         */
        daoConsent: () => call(contract.daoConsent, `${base}/consent/dao`),
        /** Asks the server to file the DAO's consent for its vote; an open request is answered instead of a new one. */
        fileDaoConsent: () => call(contract.daoConsent, `${base}/consent/dao`, { method: "POST" }),
        /** The DAO's vote on a proposal, as the server follows it: reading it after the vote passed relays the verdict. */
        vote: (id: string) => call(contract.daoVote, `${proposal(id)}/vote`),
        /** Asks the server to file the DAO's vote on a proposal; an open vote is answered instead of a new one. */
        fileVote: (id: string, verdict: Verdict) => call(contract.daoVote, `${proposal(id)}/vote`, { method: "POST", body: contract.voteSubmission.parse({ verdict }) }),
      };
    },
  };
}

export type ProposalsApi = ReturnType<typeof proposalsApi>;
export type AgentApi = ReturnType<ProposalsApi["agent"]>;
export type ExecuteResult = z.output<typeof contract.executeResult>;
export type ConsentText = z.output<typeof contract.consentText>;
export type Identity = z.output<typeof contract.agent>;
export type DaoRequest = z.output<typeof contract.daoRequest>;
export type DaoConsent = z.output<typeof contract.daoConsent>;
export type DaoVote = z.output<typeof contract.daoVote>;

/** A fresh 32-byte NEP-413 nonce, in the canonical base64 the server accepts. */
export const freshNonce = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
