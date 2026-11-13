import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { actionPhase, isFinal, outcomeOf, statusText, type OwnerOutcome, type OwnerStatus, type PhaseWords } from "../../apps/server/src/owner-action.ts";
import { ErrorBox, errorMessage } from "./shared/ui";
import { waitingOn } from "./freeze-view";
import type { Identity, OwnerActionPrepared, Result } from "./server-api";
import { OwnerActionVote } from "./owner-vote";
import { refreshPortfolio, type agentReads } from "./queries";
import { when } from "./ui";
import { file, signIntent, WrongAccount } from "./wallet";
import { filedText } from "./dao-filing";
import { failureText, type Context } from "./words";

type Reads = ReturnType<typeof agentReads>;

/**
 * What an owner action of `kind` waits on in the platform's own record (`owner/actions`), so it holds after a reload too:
 * read every few seconds while something waits, or while `poll` asks, and rendered again when a waiting vote lapses, since
 * the record may read the same once it has. `reading`: the record isn't read yet, so nothing of its kind is offered.
 */
export function useWaiting(reads: Reads, kind: string, { enabled = true, poll = false }: { enabled?: boolean; poll?: boolean } = {}) {
  const actions = useQuery({ ...reads.ownerActions, enabled,
    refetchInterval: query => poll || waitingOn(kind, { actions: query.state.data ?? [], now: Date.now() }) ? 10_000 : false });
  const waiting = waitingOn(kind, { actions: actions.data ?? [], now: Date.now() });
  const [, lapsed] = useReducer((n: number) => n + 1, 0);
  const lapses = waiting?.why === "vote" ? Date.parse(waiting.expiresAt) : undefined;
  useEffect(() => {
    if (lapses === undefined) return;
    const timer = setTimeout(lapsed, Math.max(0, lapses - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [lapses]);
  return { waiting, actions: actions.data, reading: enabled && actions.isPending, error: actions.error, refetch: actions.refetch };
}

/**
 * One owner action from preparation to outcome, for the pages that act on the agent's policy (#142, #134): prepared by the
 * server, then signed here (an intent), signed on the platform's confirm page, or filed from a DAO member's wallet, and
 * sent once. After a lost answer it is only read. Its status is followed every few seconds until it is final, and the
 * earlier ones awaiting an outcome are read from the platform's own record, so an action held between a prepare and its
 * outcome holds another of its kind after a reload too. A DAO member may be shown the terms before and after before
 * filing (`reviewDao`).
 */
export function useOwnerFlow<T extends OwnerActionPrepared = OwnerActionPrepared>({ reads, identity, kind, words, reviewDao = false, enabled = true, onFinal, reviewWallet, readStatus, resumeWaiting = false }: {
  reads: Reads; identity: Identity;
  /** The kind of action: an earlier one that holds it (`holdsEach`, as the server holds) holds this one too. */
  kind: string;
  /** The words for each phase and its terminal outcome. */
  words: PhaseWords;
  reviewDao?: boolean;
  /** Whether the platform's records may be read yet (the stop reads them only once the agent is connected). */
  enabled?: boolean;
  /** Called once with an action's final outcome; settlement alone doesn't establish success. */
  onFinal?: (outcome: OwnerOutcome) => void;
  /**
   * An immutable readable intent is reviewed first, then read again after the wallet connects. A changed one is shown
   * for review; a refusal other than a rate limit ends the review, which then can't be signed. `context` reads the
   * refusal; `closed` and `changed` say why nothing was signed.
   */
  reviewWallet?: { read: (reviewed: T) => Promise<Result<T>>; same: (reviewed: T, fresh: T) => boolean; context: Context; closed: string; changed: string };
  readStatus?: (id: string) => Promise<Result<OwnerStatus>>;
  /** Follow a durable submitted creation after navigation/reload, without recovering signing bytes or resending. */
  resumeWaiting?: boolean;
}) {
  const client = useQueryClient();
  const [action, setAction] = useState<T>();
  const [following, setFollowing] = useState<Pick<OwnerActionPrepared, "correlationId" | "expiresAt">>();
  const current = action ?? following;
  const [toSign, setToSign] = useState<T>();
  /** The review in `toSign` was refused on its reread: it stays shown with why, and isn't offered for signing. */
  const [reviewEnded, setReviewEnded] = useState(false);
  /** A DAO's prepared action waiting for its member to compare the terms and file it. */
  const [toFile, setToFile] = useState<T>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  /** A DAO member's filing from here proved to have sent nothing (it failed, or the wallet never sent it): it may be filed again. */
  const [unfiled, setUnfiled] = useState(false);
  const status = useQuery({
    queryKey: [...reads.ownerActions.queryKey.slice(0, 2), "owner-action", current?.correlationId],
    queryFn: async () => {
      const read = await (readStatus ?? reads.agent.ownerActionStatus)(current!.correlationId);
      if (!read.ok) throw new Error(failureText(read, "read"));
      return read.value;
    },
    enabled: current !== undefined, retry: false,
    refetchInterval: query => isFinal(query.state.data) ? false : 5_000,
  });
  const outcome = outcomeOf(status.data);
  const inFlight = current !== undefined && !isFinal(status.data);
  const records = useWaiting(reads, kind, { enabled, poll: inFlight || toFile !== undefined || toSign !== undefined });
  const { waiting } = records;
  useEffect(() => {
    if (!resumeWaiting || current) return;
    const found = records.actions?.find(record => record.type === kind && (actionPhase(record) === "submitted" || actionPhase(record) === "settled"));
    if (found) setFollowing({ correlationId: found.correlationId, expiresAt: found.expiresAt });
  }, [resumeWaiting, current, records.actions, kind]);
  const holding = waiting !== undefined || inFlight || toFile !== undefined || toSign !== undefined;
  /**
   * An owner action changes what every page reads of the agent: a freeze or a policy edit invalidates its proposals, a
   * revoked grant unbinds its strategy and stops its autopilot. So the portfolio's reads are made again with the action's
   * own, each when its page next shows it, rather than left as they were for the minute a read is kept.
   */
  const refresh = () => {
    refreshPortfolio(client, reads);
    for (const read of [reads.ownerActions, reads.account, reads.policyHistory]) void client.invalidateQueries({ queryKey: read.queryKey });
  };
  const notified = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (current && outcome && notified.current !== current.correlationId) {
      notified.current = current.correlationId;
      refresh();
      onFinal?.(outcome);
    }
  }, [current?.correlationId, outcome]);

  /**
   * An earlier one this page didn't start (prepared before a reload, in another tab, or by another member) has stopped
   * waiting: it took effect, failed or lapsed, and nothing here followed it, so what the pages read is read again.
   */
  const waited = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (waiting) { waited.current = waiting.correlationId; return; }
    if (waited.current === undefined) return;
    const ended = waited.current;
    waited.current = undefined;
    if (ended !== current?.correlationId) refresh();
  }, [waiting?.correlationId]);

  const dao = identity.signer === "dao";
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const sendFiled = async (prepared: T) => {
    let submissionAttempted = false;
    let replacement: T | undefined;
    let ended = false;
    try {
      if (prepared.intent) {
        const signedData = await signIntent(prepared.intent, identity.owner, reviewWallet && (async () => {
          if (!mounted.current) throw new Error(reviewWallet.closed);
          const fresh = await reviewWallet.read(prepared);
          if (!fresh.ok) {
            ended = fresh.kind === "refused" && fresh.code !== "rate_limited" && fresh.code !== "platform_rate_limited";
            throw new Error(failureText(fresh, reviewWallet.context));
          }
          if (!mounted.current) throw new Error(reviewWallet.closed);
          if (!reviewWallet.same(prepared, fresh.value)) {
            replacement = fresh.value;
            throw new Error(reviewWallet.changed);
          }
        }));
        if (reviewWallet && !mounted.current) return; // A wallet answer for a departed review cannot submit from the new page.
        setToSign(undefined);
        submissionAttempted = true;
        const submitted = await reads.agent.submitOwnerAction(prepared.correlationId, signedData);
        // A lost answer may have been submitted: its status says, and nothing is sent again.
        if (!submitted.ok) setError(submitted.kind === "lost" || submitted.kind === "unavailable"
          ? "The answer was lost: it may have been submitted. Its status below says; nothing is sent again." : failureText(submitted, "owner-action"));
      } else if (prepared.dao) {
        const outcome = await file(prepared.dao.transaction, identity.account);
        setUnfiled(outcome.kind === "failed");
        setNotice(outcome.kind === "succeeded" ? filedText(prepared.dao.transaction, when(prepared.expiresAt), "or it expires and nothing takes effect")
          : outcome.kind === "failed" ? "The transaction failed, so nothing was filed. Ask again."
          : "The wallet didn't say whether it was sent. Its status below shows whether the DAO is voting; don't file again meanwhile.");
      }
    } catch (problem) {
      // A DAO filing that threw never left the wallet.
      if (prepared.dao) setUnfiled(true);
      if (submissionAttempted) {
        // A transport can throw after the POST left. Keep the action and read its durable status.
        setError("The answer was lost: it may have been submitted. Its status below says; nothing is sent again.");
      } else {
        setAction(undefined);
        if (reviewWallet && prepared.intent) { setToSign(replacement ?? prepared); setReviewEnded(ended); }
        setError(problem instanceof WrongAccount ? problem.message : `${dao ? "The wallet didn't send it" : "The wallet didn't sign"}: ${errorMessage(problem)}. Nothing took effect.`);
      }
    } finally {
      running.current = false;
      setBusy(false);
      void client.invalidateQueries({ queryKey: [...reads.ownerActions.queryKey.slice(0, 2), "owner-action", prepared.correlationId] });
      refresh();
    }
  };

  /** Prepares the action and, unless a DAO member is to compare the terms first, signs or files it. */
  const start = async (prepare: () => Promise<Result<T>>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setNotice(undefined);
    setError(undefined);
    setUnfiled(false);
    const prepared = await prepare();
    if (!prepared.ok) { running.current = false; setBusy(false); setError(failureText(prepared, "owner-action")); refresh(); return; }
    if (reviewWallet && prepared.value.intent) { running.current = false; setBusy(false); setToSign(prepared.value); setReviewEnded(false); return; }
    if (dao && reviewDao && prepared.value.dao) { running.current = false; setBusy(false); setToFile(prepared.value); return; }
    setAction(prepared.value);
    await sendFiled(prepared.value);
  };
  /** A DAO member's filing, after comparing the terms. */
  const fileNow = async () => {
    const prepared = toFile;
    if (!prepared || running.current) return;
    running.current = true;
    setToFile(undefined);
    setBusy(true);
    setUnfiled(false);
    setAction(prepared);
    await sendFiled(prepared);
  };
  const dropFiling = () => setToFile(undefined);
  const signNow = async () => {
    if (!toSign || reviewEnded || running.current) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    setAction(toSign);
    await sendFiled(toSign);
  };
  const dropSigning = () => { if (!running.current) setToSign(undefined); };

  /** The DAO owner action whose vote is shown: this page's own, or an earlier one waiting for the DAO's vote. */
  const voting = dao ? action?.correlationId ?? (waiting?.why === "vote" ? waiting.correlationId : undefined) : undefined;
  const progress: ReactNode = <>
    {(waiting || inFlight) && !toFile && <p role="status" className="text-sm text-muted-foreground">{waiting?.why === "vote" ? "Waiting for the vote or signature on an earlier one." : "An earlier one's outcome isn't known yet."} Nothing more of its kind can be sent until it is.</p>}
    {action?.confirm && <p className="text-sm">Sign it on the platform's own page, which shows exactly what you sign: <a className="underline" href={action.confirm.url} target="_blank" rel="noopener noreferrer">open the confirm page</a>. It expires {when(action.confirm.expiresAt)}.</p>}
    {current && <p role="status" className="text-sm">{statusText(status.data, words)}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <ErrorBox error={error} />
    {/* The DAO's vote on it, for every member. One this page prepared is filed above, so it is offered here only once that proved to have sent nothing. */}
    {voting && !toFile && !busy && <OwnerActionVote reads={reads} account={identity.account} correlationId={voting} mayFile={action === undefined || unfiled} />}
  </>;
  return { start, fileNow, dropFiling, toFile, signNow, dropSigning, toSign, reviewEnded, action: current, outcome, error, notice, busy, holding, waiting, reading: records.reading, recordsError: records.error, progress };
}
