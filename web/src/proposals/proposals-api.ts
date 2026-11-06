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
/** A run's tick, a proposal's `requestId` or an operation's `correlationId`, as the server takes one in a path. */
const readId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
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
        consentText: ({ owner = false }: { owner?: boolean } = {}) =>
          call(contract.consentText, `${base}/consent/text`, { method: "POST", body: contract.consentRequest.parse(owner ? { owner: true } : {}) }),
        /**
         * For a DAO-owned agent: files its consent for the DAO's vote, or answers the request already open. The server
         * builds the text, and the platform the proposal a member files.
         */
        fileConsent: () => call(contract.daoFiled, `${base}/consent/text`, { method: "POST" }),
        connect: (submission: z.input<typeof contract.consentSubmission>) =>
          call(contract.consent, `${base}/consent`, { method: "POST", body: contract.consentSubmission.parse(submission) }),
        disconnect: () => call(contract.revoked, `${base}/consent/revoke`, { method: "POST" }),
        proposals: () => call(proposalList, `${base}/proposals`),
        /**
         * Asks for a rebalance to the saved strategy, proposed for approval under `requestId`. Never asked again for a lost
         * answer: the proposal is found by its `requestId` (`request`).
         */
        proposeRebalance: (requestId: string) => call(contract.rebalanceMade, `${base}/proposals`, { method: "POST", body: contract.rebalanceRequest.parse({ requestId }) }),
        /** The agent's open DAO requests (#130): its consent and its verdicts on proposals, soonest deadline first. Empty for a wallet owner. */
        daoRequests: () => call(contract.daoAgentRequests, `${base}/dao-requests`),
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
        /** The owner reads (#61): holdings and policy, activity, payouts held, operations without a proven outcome, the autopilot's runs. */
        overview: () => call(contract.overviewRead, `${base}/overview`),
        activity: () => call(contract.activityRead, `${base}/activity`),
        held: () => call(contract.heldRead, `${base}/held`),
        unresolved: () => call(contract.unresolvedRead, `${base}/unresolved`),
        runs: () => call(contract.runsRead, `${base}/runs`),
        recording: (tick: string) => call(contract.recordingRead, `${base}/runs/${readId.parse(tick)}`),
        /** The agent's account: its wallet, which holds its balances, and the grants its executor holds. */
        account: () => call(contract.accountRead, `${base}/account`),
        /**
         * A grant binding the saved strategy the owner saw (its digest): an intent for a wallet owner's wallet to sign (or
         * the platform's confirm page), or for a DAO the transaction a member files. Each call prepares a new one.
         */
        grant: (expectedDigest: string) => call(contract.grantPrepared, `${base}/grant`, { method: "POST", body: contract.grantRequest.parse({ expectedDigest }) }),
        /** A wallet owner's signed grant intent, relayed once: never sent again for a lost answer; its status says what happened. */
        submitGrant: (id: string, signedData: z.input<typeof contract.grantSubmission>["signedData"]) =>
          call(contract.grantSubmitted, `${base}/grant/${correlation.parse(id)}/submit`, { method: "POST", body: contract.grantSubmission.parse({ signedData }) }),
        grantStatus: (id: string) => call(contract.ownerActionStatus, `${base}/grant/${correlation.parse(id)}`),
        /** The saved strategy and whether the held grant binds it; the schedule. */
        strategy: () => call(contract.strategyRead, `${base}/strategy`),
        /** Saves a strategy over the one the owner saw, once: autopilot turns off, and it needs authorizing again. */
        saveStrategy: (strategy: z.input<typeof contract.strategyInput>, expectedDigest: string) =>
          call(contract.strategySaved, `${base}/strategy`, { method: "POST", body: contract.strategySaveRequest.parse({ strategy, expectedDigest }) }),
        autopilot: () => call(contract.autopilotRead, `${base}/autopilot`),
        /** Autopilot on for the strategy digest the owner saw, off, or one run now: each sent once, never again for a lost answer. */
        enableAutopilot: (expectedDigest: string) =>
          call(contract.autopilotChanged, `${base}/autopilot/enable`, { method: "POST", body: contract.enableRequest.parse({ expectedDigest }) }),
        stopAutopilot: () => call(contract.autopilotChanged, `${base}/autopilot/stop`, { method: "POST" }),
        runNow: () => call(contract.tickRead, `${base}/autopilot/tick`, { method: "POST" }),
        /** Per asset, the provider's balances against the chain and against recorded executions. */
        books: () => call(contract.booksRead, `${base}/books`),
        /** A sweep, sent once, answered as its AG-UI run: a preview, or the shielding of the public balances. Never sent again for a lost answer. */
        sweep: (execute: boolean) => call(contract.sweepRun, `${base}/sweep`, { method: "POST", body: contract.sweepRequest.parse({ execute }) }),
        /** The account linked to fund the agent, or null. */
        treasury: () => call(contract.treasuryRead, `${base}/treasury`),
        /** A fresh one-time deposit address for USDC, or for NEAR (as wNEAR). A lost answer may be asked for again: each is new. */
        deposit: (asset: "USDC" | "NEAR") => call(contract.depositRead, `${base}/deposit`, { method: "POST", body: contract.depositRequest.parse({ asset }) }),
        /** A wallet owner's changes to the funding account, each sent once; the account is read again after. */
        link: (accountId: string) => call(contract.fundingChanged, `${base}/treasury/link`, { method: "POST", body: contract.linkRequest.parse({ accountId }) }),
        unlink: () => call(contract.fundingChanged, `${base}/treasury/unlink`, { method: "POST" }),
        setConfidential: (confidential: boolean) =>
          call(contract.fundingChanged, `${base}/treasury/confidential`, { method: "POST", body: contract.confidentialRequest.parse({ confidential }) }),
        /** A proposal by the `requestId` it was proposed with; read only. */
        request: (requestId: string) => call(contract.requestRead, `${base}/requests/${readId.parse(requestId)}`),
        /** An operation's status by its `correlationId`, from its activity row: null until an outcome is recorded. */
        operation: (correlationId: string) => call(contract.operationRead, `${base}/operations/${readId.parse(correlationId)}`),
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
export type OverviewRead = z.output<typeof contract.overviewRead>;
export type ActivityRead = z.output<typeof contract.activityRead>;
export type RunsRead = z.output<typeof contract.runsRead>;
export type TreasuryRead = z.output<typeof contract.treasuryRead>["treasury"];
export type DepositRead = z.output<typeof contract.depositRead>["deposit"];
export type SweepRun = z.output<typeof contract.sweepRun>;
export type BooksRead = z.output<typeof contract.booksRead>;
export type StrategyRead = z.output<typeof contract.strategyRead>;
export type GrantPrepared = z.output<typeof contract.grantPrepared>;

/** A fresh 32-byte NEP-413 nonce, in the canonical base64 the server accepts. */
export const freshNonce = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
