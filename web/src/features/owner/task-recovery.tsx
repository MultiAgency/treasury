import { queries } from "../../shared/queries";
import { SCHEDULE_STOPPED, SCHEDULE_STOP_SCOPE } from "../../shared/schedule-copy";
import { useQuery } from "@tanstack/react-query";
import { client, useAttempt } from "../../shared/lib";
import { useCanCall } from "../../app/viewer";
import { Button, ErrorBox, Loading, QueryError, Section } from "../../shared/ui";


export function StopSchedule() {
  // Provider-independent identity is an observation, never permission to send.
  const instance = useQuery(queries.instance);
  const canStop = useCanCall("autopilot/stop");
  const stop = useAttempt([queries.orpc.autopilot.key(), queries.orpc.strategy.key()]);
  return <Section title="Schedule">
    <p>{SCHEDULE_STOP_SCOPE}</p>
    {!canStop ? <p>Your account cannot stop the schedule.</p>
      : instance.isPending ? <Loading label="Checking executor identity…" />
      : instance.error ? <p>Executor identity is unavailable. Check again before stopping the schedule.</p>
      : instance.data?.executor === false ? <p>Stop the schedule on the executor; this instance is approve-only.</p>
      : !instance.data?.agentId ? <p>No agent is configured on this instance.</p> : null}
    {instance.error && <QueryError error={instance.error} retry={() => instance.refetch()} />}
    <Button variant="outline" disabled={!canStop || !instance.data?.agentId || instance.data.executor !== true || stop.busy}
      onClick={() => stop.attempt(async () => { await client.autopilot.stop(); return SCHEDULE_STOPPED; })}>Turn off</Button>
    {stop.message && <p role="status">{stop.message}</p>}<ErrorBox error={stop.error} />
  </Section>;
}
