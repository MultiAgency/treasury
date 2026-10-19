import { Link } from "@tanstack/react-router";
import { STAGE_LABEL } from "@multiagency/sdk";
import { Badge } from "../../shared/ui";
import type { RecordedProgressItem } from "./recording-model";

function RecordedTime({ timestamp }: { timestamp?: number }) {
  return timestamp === undefined ? <>Timing unknown</> : <time dateTime={new Date(timestamp).toISOString()}>{new Date(timestamp).toLocaleTimeString()}</time>;
}

/** One row per observed stage, with independent submissions. No inferred progress or settlement. */
export function RecordedProgress({ items }: { items: RecordedProgressItem[] }) {
  if (!items.length) return <p className="text-muted-foreground">This recording has no stage observations.</p>;
  return <div className="flex flex-col gap-2">
    <p className="text-muted-foreground">Stages are listed by recorded start. A return or submission does not establish an operation outcome.</p>
    <ol aria-label="Recorded stages and submissions" className="flex flex-col divide-y">
      {items.map(item => <li key={item.id} className="flex min-w-0 flex-col gap-2 py-3 first:pt-0 last:pb-0">
        {item.kind === "stage" ? <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{STAGE_LABEL[item.stepName]}</span>
            <Badge>{item.returned ? "Return recorded" : "No return recorded"}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">Started <RecordedTime timestamp={item.started.timestamp} />
            {item.returned && <> · Returned <RecordedTime timestamp={item.returned.timestamp} /></>}
          </p>
        </> : <>
          <p className="font-medium">{item.method[0]!.toUpperCase()}{item.method.slice(1)} submitted</p>
          <p className="text-muted-foreground">Outcome not yet established by this observation.</p>
          <p className="text-xs text-muted-foreground"><RecordedTime timestamp={item.timestamp} /></p>
          <Link to="/activity" hash={`operation-${item.correlationId}`} className="inline-flex min-h-11 items-center self-start underline">Inspect submitted {item.method}</Link>
        </>}
      </li>)}
    </ol>
  </div>;
}
