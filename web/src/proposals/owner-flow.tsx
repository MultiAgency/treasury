import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { ErrorBox, errorMessage } from "../shared/ui";
import { waitingOn, type Waiting } from "./freeze-view";
import type { Identity, OwnerActionPrepared, Result } from "./proposals-api";
import type { agentReads } from "./queries";
import { when } from "./ui";
import { file, signIntent, WrongAccount } from "./wallet";
import { failureText } from "./words";

type Reads = ReturnType<typeof agentReads>;

export const FINAL = new Set(["submitted", "expired", "failed"]);

/**
 * One owner action from preparation to outcome, for the pages that act on the agent's policy (#142, #134): prepared by the
 * server, then signed here (an intent), signed on the platform's confirm page, or filed from a DAO member's wallet, and
 * sent once. After a lost answer it is only read. Its status is followed every few seconds until it is final, and the
 * earlier ones awaiting an outcome are read from the platform's own record, so an action held between a prepare and its
 * outcome holds another of its kind after a reload too. A DAO member may be shown the terms before and after before
 * filing (`reviewDao`).
 */
export function useOwnerFlow({ reads, identity, is, words, reviewDao = false, enabled = true, onFinal }: {
  reads: Reads; identity: Identity; is: (type: string) => boolean;
  /** The words for each stage: what has happened to this kind of action. */
  words: Record<string, string>;
  reviewDao?: boolean;
  /** Whether the platform's records may be read yet (the stop reads them only once the agent is connected). */
  enabled?: boolean;
  /** Called once with the stage an action reached when it is final. */
  onFinal?: (stage: string) => void;
}) {
  const client = useQueryClient();
  const [action, setAction] = useState<OwnerActionPrepared>();
  /** A DAO's prepared action waiting for its member to compare the terms and file it. */
  const [toFile, setToFile] = useState<OwnerActionPrepared>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [polling, setPolling] = useState(false);
  const every = polling ? 10_000 : false;
  const actions = useQuery({ ...reads.ownerActionsGlance, enabled, refetchInterval: every });
  const pending = useQuery({ ...reads.ownerPending, enabled });
  const status = useQuery({
    queryKey: [...reads.ownerActionsGlance.queryKey.slice(0, 2), "owner-action", action?.correlationId],
    queryFn: async () => {
      const read = await reads.agent.ownerActionStatus(action!.correlationId);
      if (!read.ok) throw new Error(failureText(read, "read"));
      return read.value;
    },
    enabled: action !== undefined, retry: false,
    refetchInterval: query => FINAL.has(query.state.data?.stage ?? "") ? false : 5_000,
  });
  const stage = status.data?.stage;
  const waiting: Waiting | undefined = waitingOn(is, { actions: actions.data ?? [], pending: pending.data ?? [], now: Date.now() });
  const inFlight = action !== undefined && !(stage !== undefined && FINAL.has(stage));
  const holding = waiting !== undefined || inFlight || toFile !== undefined;
  useEffect(() => { setPolling(holding); }, [holding]);
  const refresh = () => [reads.overview, reads.ownerActionsGlance, reads.ownerPending, reads.account, reads.policyHistory].forEach(read => void client.invalidateQueries({ queryKey: read.queryKey }));
  useEffect(() => { if (stage !== undefined && FINAL.has(stage)) { refresh(); onFinal?.(stage); } }, [stage]);

  const dao = identity.signer === "dao";
  const sendFiled = async (prepared: OwnerActionPrepared) => {
    try {
      if (prepared.intent) {
        const signedData = await signIntent(prepared.intent, identity.owner);
        const submitted = await reads.agent.submitOwnerAction(prepared.correlationId, signedData);
        // A lost answer may have been submitted: its status says, and nothing is sent again.
        if (!submitted.ok) setError(submitted.kind === "lost" || submitted.kind === "unavailable"
          ? "The answer was lost: it may have been submitted. Its status below says; nothing is sent again." : failureText(submitted, "owner-action"));
      } else if (prepared.dao) {
        const outcome = await file(prepared.dao.transaction, identity.account);
        setNotice(outcome.kind === "succeeded" ? `Filed. The DAO's vote must pass by ${when(prepared.expiresAt)}, or it expires and nothing takes effect.`
          : outcome.kind === "failed" ? "The transaction failed, so nothing was filed. Ask again."
          : "The wallet didn't say whether it was sent. Its status below shows whether the DAO is voting; don't file again meanwhile.");
      }
    } catch (problem) {
      // Nothing was signed or filed, so the platform has no outcome to wait for: let the next one be asked for.
      setAction(undefined);
      setError(problem instanceof WrongAccount ? problem.message : `${dao ? "The wallet didn't send it" : "The wallet didn't sign"}: ${errorMessage(problem)}. Nothing took effect.`);
    } finally {
      setBusy(false);
      void status.refetch();
      refresh();
    }
  };

  /** Prepares the action and, unless a DAO member is to compare the terms first, signs or files it. */
  const start = async (prepare: () => Promise<Result<OwnerActionPrepared>>) => {
    setBusy(true);
    setNotice(undefined);
    setError(undefined);
    const prepared = await prepare();
    if (!prepared.ok) { setBusy(false); setError(failureText(prepared, "owner-action")); refresh(); return; }
    if (dao && reviewDao && prepared.value.dao) { setBusy(false); setToFile(prepared.value); return; }
    setAction(prepared.value);
    await sendFiled(prepared.value);
  };
  /** A DAO member's filing, after comparing the terms. */
  const fileNow = async () => {
    const prepared = toFile;
    if (!prepared) return;
    setToFile(undefined);
    setBusy(true);
    setAction(prepared);
    await sendFiled(prepared);
  };
  const dropFiling = () => setToFile(undefined);

  const progress: ReactNode = <>
    {holding && !toFile && <p role="status" className="text-sm text-muted-foreground">{waiting?.why === "vote" || waiting?.why === "pending" ? "Waiting for the vote or signature on an earlier one." : "An earlier one's outcome isn't known yet."} Nothing more of its kind can be sent until it is.</p>}
    {action?.confirm && <p className="text-sm">Sign it on the platform's own page, which shows exactly what you sign: <a className="underline" href={action.confirm.url} target="_blank" rel="noopener noreferrer">open the confirm page</a>. It expires {when(action.confirm.expiresAt)}.</p>}
    {action && <p role="status" className="text-sm">{!stage ? "Reading its status…" : words[stage] ?? stage}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <ErrorBox error={error} />
  </>;
  return { start, fileNow, dropFiling, toFile, busy, holding, waiting, progress };
}
