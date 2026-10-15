import { DownloadSimple } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { client } from "../../shared/lib";
import { Button, Spinner } from "../../shared/ui";
import { inspectRecording } from "./recording-model";
import { RecordingView } from "./recording-view";
import { useId, useState } from "react";

/** Downloads only on request; it neither starts a tick nor invalidates live queries. */
export function RunDownload({ tickId, agentId }: { tickId: string; agentId: string }) {
  const panelId = useId();
  const [inspecting, setInspecting] = useState(false);
  const inspect = useMutation({ mutationFn: async () => inspectRecording(await client.autopilot.log({ tickId }), agentId, tickId) });
  const download = useMutation({ mutationFn: async () => {
    const recording = inspectRecording(await client.autopilot.log({ tickId }), agentId, tickId);
    const href = URL.createObjectURL(new Blob([JSON.stringify(recording)], { type: "application/json" }));
    const link = Object.assign(document.createElement("a"), {
      href, download: `run-${tickId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`,
    });
    document.body.append(link);
    try { link.click(); }
    finally { link.remove(); setTimeout(() => URL.revokeObjectURL(href), 1_000); }
    return recording.gaps.length;
  } });
  const feedback = !inspecting ? "" : [
    inspect.isPending ? "Loading recording…"
      : inspect.error ? `Recording unavailable: ${inspect.error.message}`
        : inspect.data ? "Recording loaded." : "",
    download.isPending ? "Preparing download…"
      : download.error ? `Download unavailable: ${download.error.message}`
        : download.isSuccess ? `Recording prepared${download.data ? ` with ${download.data} source gap${download.data === 1 ? "" : "s"}, listed in the file` : ""}.` : "",
  ].filter(Boolean).join(" ");
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Button variant="outline" size="sm" className="self-start" aria-expanded={inspecting} aria-controls={panelId} onClick={() => {
        if (inspecting) setInspecting(false);
        else {
          setInspecting(true);
          if (!download.isPending) download.reset();
          if (!inspect.isPending) inspect.mutate();
        }
      }}>
        {inspecting ? "Close recording" : "Inspect recording"}
      </Button>
      <p role="status" aria-live="polite" aria-atomic="true" className={feedback ? "text-xs text-muted-foreground" : "sr-only"}>{feedback}</p>
      <div id={panelId} hidden={!inspecting} className="flex min-w-0 flex-col gap-3">
        <p className="text-xs text-muted-foreground">Private JSON with this run's balances and operation details.</p>
        <Button variant="outline" size="sm" className="self-start" disabled={download.isPending} onClick={() => download.mutate()}>
          {download.isPending ? <Spinner /> : <DownloadSimple size={16} aria-hidden="true" />} Download recording
        </Button>
        {inspect.data && !inspect.isPending && !inspect.error && <RecordingView key={`${agentId}:${tickId}:${inspect.data.exportedAt}`} recording={inspect.data} />}
      </div>
    </div>
  );
}
