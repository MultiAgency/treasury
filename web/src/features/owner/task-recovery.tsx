import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { agent, failureMessage, reads, type OwnerResult } from "../../platform";
import { AGENT } from "../../app/location";
import { useCanCall, useViewer } from "../../app/viewer";
import { Button, ErrorBox, Loading, QueryError, Section } from "../../shared/ui";

/** Schedule admission and an already-started run are separate controls. */
export const SCHEDULE_STOPPED = "Future scheduled runs are off. A run already started can still submit further operations; submitted operations may finish.";
export const SCHEDULE_STOP_SCOPE = "Stopping the schedule prevents future scheduled runs. A run already started can still submit further operations; submitted operations may finish.";

/** Reads a stop changes: the schedule and the strategy it runs. */
const scheduleRead = (key: readonly unknown[]) => typeof key[1] === "string" && /^(autopilot|strategy)\//.test(key[1]);

/** Stopping the schedule, wherever it's offered: sent once per click, and its result kept for the caller to show. */
export function useStopSchedule() {
  const api = useMemo(() => agent(AGENT!), []);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OwnerResult<unknown>>();
  const stop = async () => {
    setBusy(true);
    setResult(undefined);
    const stopped = await api.act("autopilot/stop", undefined);
    setResult(stopped);
    setBusy(false);
    // An unknown outcome may have changed anything: every read is read again, and nothing is sent again.
    await queryClient.invalidateQueries(!stopped.ok && stopped.kind === "unknown" ? undefined : { predicate: query => scheduleRead(query.queryKey) });
  };
  return { stop, busy, result };
}

export function StopSchedule() {
  const viewer = useViewer();
  // Provider-independent identity is an observation, never permission to send.
  const instance = useQuery(reads(AGENT!, viewer?.account ?? null).instance);
  const canStop = useCanCall("autopilot/stop");
  const { stop, busy, result } = useStopSchedule();
  return <Section title="Schedule">
    <p>{SCHEDULE_STOP_SCOPE}</p>
    {!canStop ? <p>Your account cannot stop the schedule.</p>
      : instance.isPending ? <Loading label="Checking executor identity…" />
      : instance.error ? <p>Executor identity is unavailable. Check again before stopping the schedule.</p>
      : instance.data?.executor === false ? <p>Stop the schedule on the executor; this instance is approve-only.</p>
      : !instance.data?.agentId ? <p>No agent is configured on this instance.</p> : null}
    {instance.error && <QueryError error={instance.error} retry={() => instance.refetch()} />}
    <Button variant="outline" disabled={!canStop || !instance.data?.agentId || instance.data.executor !== true || busy}
      onClick={stop}>Turn off</Button>
    {result?.ok && <p role="status">{SCHEDULE_STOPPED}</p>}<ErrorBox error={result && !result.ok ? failureMessage(result) : undefined} />
  </Section>;
}
