import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { agent, failureMessage, reads, type OwnerResult } from "../../platform";
import { AGENT } from "../../app/location";
import { useCanCall, useViewer } from "../../app/viewer";
import { Button, ErrorBox, Loading, QueryError, Section } from "../../shared/ui";

/** Schedule admission and an already-started run are separate controls. */
export const SCHEDULE_STOPPED = "Future scheduled runs are off. A run already started can still submit further operations; submitted operations may finish.";
export const SCHEDULE_STOP_SCOPE = "Stopping the schedule prevents future scheduled runs. A run already started can still submit further operations; submitted operations may finish.";

/** Whether to offer stopping the schedule: unless its latest read confirms it off. Who may stop it is `useStopSchedule`'s. */
export const offersStop = (schedule: { data?: { on: boolean }; error: unknown }) => !schedule.data || Boolean(schedule.error) || schedule.data.on;

/** Reads a stop changes: the schedule and the strategy it runs. */
const scheduleRead = (key: readonly unknown[]) => typeof key[1] === "string" && /^(autopilot|strategy)\//.test(key[1]);

/**
 * Stopping the schedule, wherever it's offered: who may stop it here and why not, the stop sent once per click, and its
 * result kept for the caller to show.
 */
export function useStopSchedule() {
  const viewer = useViewer();
  const api = useMemo(() => agent(AGENT!), []);
  const queryClient = useQueryClient();
  // Provider-independent identity is an observation, never permission to send.
  const instance = useQuery(reads(AGENT!, viewer?.account ?? null).instance);
  const canStop = useCanCall("autopilot/stop");
  const checkingIdentity = canStop && instance.isPending;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OwnerResult<unknown>>();
  const reason = !canStop ? "Your account cannot stop the schedule."
    : instance.isPending ? "Checking executor identity…"
    : instance.error ? "Executor identity is unavailable. Check again before stopping the schedule."
    : instance.data?.executor === false ? "Stop the schedule on the executor; this instance is approve-only."
    : !instance.data?.agentId ? "No agent is configured on this instance." : undefined;
  const stop = async () => {
    setBusy(true);
    setResult(undefined);
    const stopped = await api.act("autopilot/stop", undefined);
    setResult(stopped);
    setBusy(false);
    // An unknown outcome may have changed anything: every read is read again, and nothing is sent again.
    await queryClient.invalidateQueries(!stopped.ok && stopped.kind === "unknown" ? undefined : { predicate: query => scheduleRead(query.queryKey) });
  };
  return { stop, busy, result, instance, reason, checkingIdentity, disabled: reason !== undefined || busy };
}

/** Why the schedule can't be stopped here, and a failed identity read with its retry; nothing when it can. */
export function StopBlocked({ control: { instance, reason, checkingIdentity } }: { control: ReturnType<typeof useStopSchedule> }) {
  return <>
    {reason && (checkingIdentity ? <Loading label={reason} /> : <p>{reason}</p>)}
    {instance.error && <QueryError error={instance.error} retry={() => instance.refetch()} />}
  </>;
}

/** The stop's outcome: its status once stopped, or its failure. */
export function StopResult({ control: { result } }: { control: ReturnType<typeof useStopSchedule> }) {
  return <>{result?.ok && <p role="status">{SCHEDULE_STOPPED}</p>}<ErrorBox error={result && !result.ok ? failureMessage(result) : undefined} /></>;
}

export function StopSchedule() {
  const control = useStopSchedule();
  return <Section title="Schedule">
    <p>{SCHEDULE_STOP_SCOPE}</p>
    <StopBlocked control={control} />
    <Button variant="outline" disabled={control.disabled} onClick={control.stop}>Turn off</Button>
    <StopResult control={control} />
  </Section>;
}
