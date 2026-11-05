import { mayCall } from "@multiagency/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { symbolOf } from "../shared/format";
import { Button, Card, ErrorBox, Loading, QueryError, Spinner } from "../shared/ui";
import type { Identity } from "./proposals-api";
import type { agentReads } from "./queries";
import { Grant } from "./grant";
import { StrategyEditor } from "./strategy-editor";
import { ReviewDialog, when } from "./ui";
import { failureText } from "./words";
import { forgetGrant } from "./kept-outcomes";
import { PageLink } from "./nav";
import { agentAddress } from "./pages";

type Reads = ReturnType<typeof agentReads>;
type Confirm = "enable" | "tick";

/**
 * The agent's saved strategy and its autopilot, under the app's `treasury` consent: what the strategy targets and its
 * limits, whether the held grant binds it, and the schedule. Autopilot is turned on only for the strategy shown (its
 * digest), and Run now only while the grant binds it, since otherwise a run swaps nothing. Each is sent once; after a
 * lost answer the page reads the schedule again, and a Run now may have run.
 */
export function Autopilot({ reads, identity }: { reads: Reads; identity: Identity }) {
  const client = useQueryClient();
  const strategy = useQuery(reads.strategy);
  const schedule = useQuery(reads.autopilot);
  const consent = useQuery(reads.consent);
  const ownerAllowed = consent.data?.consent?.scopes.includes("owner") === true;
  const [confirm, setConfirm] = useState<Confirm>();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"enable" | "stop" | "tick">();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const refresh = () => [reads.strategy, reads.autopilot, reads.runs].forEach(read => void client.invalidateQueries({ queryKey: read.queryKey }));
  const fetching = strategy.isFetching || schedule.isFetching;

  const act = async (what: "enable" | "stop" | "tick") => {
    if (!strategy.data) return;
    setConfirm(undefined);
    setBusy(what);
    setNotice(undefined);
    setError(undefined);
    const answer = what === "enable" ? await reads.agent.enableAutopilot(strategy.data.digest)
      : what === "stop" ? await reads.agent.stopAutopilot() : await reads.agent.runNow();
    setBusy(undefined);
    refresh();
    // Turning it on or off is said by the schedule's own status, read again above: only a run's summary is news.
    if (answer.ok) {
      if (what === "tick" && "summary" in answer.value) setNotice(`Run now: ${answer.value.summary}`);
      return;
    }
    // A Run now whose answer was lost may have run, and swapped: never sent again from here.
    if (what === "tick" && (answer.kind === "lost" || answer.kind === "unavailable"))
      setError("The run's answer was lost: it may have run. Check the autopilot's runs, in Portfolio on the agent's Home page, before running again.");
    else setError(failureText(answer, "autopilot"));
  };

  const s = strategy.data, on = schedule.data?.on === true;
  // Once the grant binds the strategy, the one kept for it (`kept-outcomes.ts`) has done its work: a later unbinding starts afresh.
  const bound = s?.grantMatches === true;
  useEffect(() => { if (bound) forgetGrant(reads.name); }, [bound, reads.name]);
  const canControl = mayCall(identity.access, "autopilot/enable");
  const canSave = mayCall(identity.access, "strategy/save");
  /** Keyboard focus goes back to Edit strategy when the editor closes, so a keyboard user carries on from there. */
  const editButton = useRef<HTMLButtonElement>(null);
  const [returnFocus, setReturnFocus] = useState(false);
  useEffect(() => { if (returnFocus && !editing) { editButton.current?.focus(); setReturnFocus(false); } }, [returnFocus, editing, strategy.data]);
  const doneEditing = (saved: boolean) => {
    setEditing(false);
    setReturnFocus(true);
    refresh();
    if (saved) { setError(undefined); setNotice("Strategy saved. Authorize it next."); }
  };
  return <section id="autopilot" aria-labelledby="autopilot-title" className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="autopilot-title" className="text-xl font-semibold">Autopilot</h2>
      <Button variant="ghost" size="sm" disabled={fetching} onClick={refresh}>{fetching ? "Checking…" : "Check again"}</Button>
    </div>
    <Card>
      {strategy.isPending || schedule.isPending ? <Loading label="Reading the strategy and the schedule…" />
        : strategy.isError ? <QueryError error={strategy.error} retry={() => strategy.refetch()} />
        : schedule.isError ? <QueryError error={schedule.error} retry={() => schedule.refetch()} />
        : editing ? <StrategyEditor reads={reads} strategy={s!} onDone={doneEditing} />
        : <ol aria-label="From strategy to autopilot" className="flex flex-col gap-5 text-sm">
          <li className="flex flex-col gap-3">
            <h3 className="text-base font-semibold">1. Configure the strategy</h3>
            <ul aria-label="Strategy targets" className="flex flex-col gap-1">
              {Object.entries(s!.strategy.targetBps).filter(([, bps]) => bps > 0).map(([asset, bps]) =>
                <li key={asset}>{symbolOf(asset, [])}: {bps / 100}%</li>)}
            </ul>
            <p>Swaps of at least ${s!.strategy.minLegUsd}, costing at most {s!.strategy.maxCostBps / 100}%. On autopilot: every {s!.strategy.autopilot.everyMin} minutes,
              up to ${s!.strategy.autopilot.maxUsd} a run.</p>
            {s!.strategy.autopilot.maxUsd === 0 && <p>With a $0 ceiling, autopilot makes no swaps on its own: swaps are proposed for your approval
              instead. <PageLink to={agentAddress(identity.agent, "proposals")} className="underline">Propose a rebalance</PageLink>.</p>}
            {canSave ? <Button ref={editButton} variant="outline" className="self-start" disabled={busy !== undefined} onClick={() => { setNotice(undefined); setEditing(true); }}>Edit strategy</Button>
              : identity.signer === "dao" && <p>Editing the strategy needs a member who may file and vote on the DAO's policy changes.</p>}
          </li>
          <li className="flex flex-col gap-3">
            <h3 className="text-base font-semibold">2. Authorize it</h3>
            {!s!.executor ? <p>This host only approves: the strategy is authorized on the agent's executor.</p>
              : s!.grantMatches ? <p>Authorized: the agent's grant binds this strategy.</p>
              : <>
                <p>Not authorized: the agent's grant doesn't bind this strategy, so autopilot can't run it, and Run now would swap nothing.
                  {on && " Turn autopilot off to authorize it."}</p>
                {!on && <Grant reads={reads} identity={identity} strategy={s!} ownerAllowed={ownerAllowed} />}
              </>}
          </li>
          <li className="flex flex-col gap-3">
            <h3 className="text-base font-semibold">3. Turn autopilot on</h3>
            <p role="status">{on ? `Autopilot is on${schedule.data!.nextRun ? `; next run ${when(schedule.data!.nextRun)}` : ""}.` : "Autopilot is off."}
              {schedule.data!.lastRun && ` Last run ${when(schedule.data!.lastRun)}.`}</p>
            {!on && s!.readiness.reasons.length > 0 && <ul aria-label="Why autopilot can't be turned on" className="flex flex-col gap-1">
              {s!.readiness.reasons.map(reason => <li key={reason}>{reason}</li>)}
            </ul>}
            {canControl ? <div className="flex flex-wrap gap-3">
              {on ? <Button variant="outline" disabled={busy !== undefined} onClick={() => void act("stop")}>{busy === "stop" && <Spinner />} Turn off</Button>
                : <Button disabled={busy !== undefined || !s!.readiness.canEnable} onClick={() => setConfirm("enable")}>Turn on</Button>}
              {s!.grantMatches && s!.executor && <Button variant="outline" disabled={busy !== undefined} onClick={() => setConfirm("tick")}>{busy === "tick" && <Spinner />} Run now</Button>}
            </div> : <p>Autopilot and Run now need a member who may both file and vote on proposals.</p>}
          </li>
        </ol>}
      <p role="status" className="text-sm">{notice}</p>
      <ErrorBox error={error} />
    </Card>
    {s && <ReviewDialog open={confirm !== undefined} busy={busy !== undefined} onClose={() => setConfirm(undefined)}
      title={confirm === "enable" ? "Let the agent act on its own?" : "Run the strategy once now?"}
      description={confirm === "enable"
        ? `Every ${s.strategy.autopilot.everyMin} minutes the agent may shield public balances and swap toward the targets above, up to $${s.strategy.autopilot.maxUsd} a run, without asking you each time. It acts only under the grant that binds this strategy, within the signed policy.`
        : `The agent rebalances toward the targets above once, up to $${s.strategy.autopilot.maxUsd}, under the grant that binds this strategy. It doesn't ask you for each swap.`}
      actions={<Button disabled={busy !== undefined} onClick={() => void act(confirm === "enable" ? "enable" : "tick")}>{confirm === "enable" ? "Turn on" : "Run now"}</Button>}>{null}</ReviewDialog>}
  </section>;
}
