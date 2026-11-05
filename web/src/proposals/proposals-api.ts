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
/** A creation's correlation ID, as the server takes it in a path. */
const correlation = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
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
    /** The signed-in account's own Treasury agents, set up or created. */
    setups: () => call(contract.setups, "/api/setup"),
    /** The setup text for the owner's wallet: a Treasury agent for their own Organization, built by the server. */
    setupText: () => call(contract.consentText, "/api/setup/text", { method: "POST" }),
    /** The owner's signed setup: the platform reserves their Treasury agent. Never sent again for an answer that was lost. */
    setup: (submission: z.input<typeof contract.consentSubmission>) =>
      call(contract.setupDone, "/api/setup", { method: "POST", body: contract.consentSubmission.parse(submission) }),
    /** A DAO's Treasury setup, for one of its members: its agents, and its setup while one waits for the vote. */
    daoSetup: (dao: string) => call(contract.daoSetup, `/api/setup/dao/${contract.accountId.parse(dao)}`),
    /** Files a DAO's Treasury setup for its vote, or answers the one already open. */
    fileDaoSetup: (dao: string) => call(contract.daoFiled, `/api/setup/dao/${contract.accountId.parse(dao)}`, { method: "POST" }),
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
        /**
         * For a DAO-owned agent: files its consent for the DAO's vote, or answers the request already open. The server
         * builds the text, and the platform the proposal a member files.
         */
        fileConsent: () => call(contract.daoFiled, `${base}/consent/text`, { method: "POST" }),
        connect: (submission: z.input<typeof contract.consentSubmission>) =>
          call(contract.consent, `${base}/consent`, { method: "POST", body: contract.consentSubmission.parse(submission) }),
        disconnect: () => call(contract.revoked, `${base}/consent/revoke`, { method: "POST" }),
        proposals: () => call(proposalList, `${base}/proposals`),
        proposal: (id: string) => call(contract.proposalRead, proposal(id)),
        verdict: (id: string, verdict: Verdict, signed: z.input<typeof contract.verdictSubmission>) =>
          call(contract.proposalRead, `${proposal(id)}/${verdict}`, { method: "POST", body: contract.verdictSubmission.parse(signed) }),
        /**
         * For a DAO-owned agent: files the DAO's vote on the proposal, from the platform's own text of it, or answers the
         * vote already open on it, which may carry the other verdict.
         */
        fileVote: (id: string, verdict: Verdict) => call(contract.daoFiled, `${proposal(id)}/${verdict}`, { method: "POST" }),
        /**
         * Prepares the agent's creation under its setup consent: a link to the platform's confirm page for a wallet
         * owner, the proposal a DAO's member files for a DAO. Each call prepares a new one.
         */
        create: () => call(contract.creation, `${base}/creation`, { method: "POST" }),
        /** Where a creation stands, by its correlation ID. */
        creation: (id: string) => call(contract.creationStatus, `${base}/creation/${correlation.parse(id)}`),
        /** Asks for an approved proposal's execution, once. Never called again for an answer that was lost. */
        execute: (id: string) => call(contract.executeResult, `${proposal(id)}/execute`, { method: "POST" }),
      };
    },
  };
}

export type ProposalsApi = ReturnType<typeof proposalsApi>;
export type AgentApi = ReturnType<ProposalsApi["agent"]>;
export type ExecuteResult = z.output<typeof contract.executeResult>;
export type ConsentText = z.output<typeof contract.consentText>;
export type Identity = z.output<typeof contract.agent>;
export type Connection = z.output<typeof contract.consent>;
export type DaoRequest = z.output<typeof contract.daoRequest>;
export type DaoSetup = z.output<typeof contract.daoSetup>;
export type Creation = z.output<typeof contract.creation>;
export type CreationStatus = z.output<typeof contract.creationStatus>;
export type ProposalRead = z.output<typeof contract.proposalRead>;

/** A fresh 32-byte NEP-413 nonce, in the canonical base64 the server accepts. */
export const freshNonce = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
