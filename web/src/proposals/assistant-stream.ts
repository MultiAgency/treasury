import * as contract from "../../../apps/server/src/contract.ts";
import type { AssistantAnswer, AssistantStreamEvent, Result } from "./proposals-api.ts";

// A broken proxy or endpoint must not grow an unfinished event without bound.
const MAX_EVENT_CHARS = 1_048_576;
const MAX_STREAM_CHARS = 4 * MAX_EVENT_CHARS;
const lost = { ok: false, kind: "lost" } as const;

/**
 * Reads the assistant's SSE response incrementally. Only a matching RUN_FINISHED with a validated answer proves
 * completion; an interrupted stream is lost, even if it already supplied a useful what-if snapshot. No retry here.
 */
export async function readAssistantStream(response: Response, onEvent?: (event: AssistantStreamEvent) => void): Promise<Result<AssistantAnswer>> {
  if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream") {
    try {
      const body: unknown = await response.json();
      const failure = contract.serverFailure.safeParse(body);
      if (failure.success) return failure.data;
      if (response.ok && typeof body === "object" && body !== null && "ok" in body && body.ok === true && "value" in body) {
        const answer = contract.assistantAnswer.safeParse(body.value);
        if (answer.success) return { ok: true, value: answer.data };
      }
    } catch { /* An unreadable response proves nothing. */ }
    return lost;
  }
  if (!response.ok || !response.body) return lost;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", data: string[] = [], eventChars = 0, totalChars = 0;
  let run: { threadId: string; runId: string } | undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      const chunk = decoder.decode(value, { stream: !done });
      totalChars += chunk.length;
      if (totalChars > MAX_STREAM_CHARS) return lost;
      buffer += chunk;
      if (buffer.length + eventChars > MAX_EVENT_CHARS) return lost;
      while (true) {
        const boundary = buffer.search(/[\r\n]/);
        if (boundary < 0 || (!done && buffer[boundary] === "\r" && boundary === buffer.length - 1)) break;
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + (buffer[boundary] === "\r" && buffer[boundary + 1] === "\n" ? 2 : 1));
        if (line !== "") {
          eventChars += line.length;
          if (eventChars > MAX_EVENT_CHARS) return lost;
          if (line === "data") data.push("");
          else if (line.startsWith("data:")) data.push(line.slice(line[5] === " " ? 6 : 5));
          continue;
        }
        eventChars = 0;
        if (data.length === 0) continue; // SSE comments and keep-alives carry no event.
        const parsed = contract.assistantStreamEvent.safeParse(JSON.parse(data.join("\n")));
        data = [];
        if (!parsed.success) return lost;
        const event = parsed.data;
        if (event.type === "RUN_STARTED") {
          if (run) return lost;
          run = { threadId: event.threadId, runId: event.runId };
        } else if (!run) return lost;
        if (event.type === "RUN_FINISHED" && (event.threadId !== run!.threadId || event.runId !== run!.runId)) return lost;
        onEvent?.(event);
        if (event.type === "RUN_FINISHED") return { ok: true, value: event.result };
        if (event.type === "RUN_ERROR") return event.code === "rate_limited" || event.code === "platform_budget"
          ? { ok: false, kind: "refused", code: event.code } : { ok: false, kind: "unavailable" };
      }
      if (done) return lost;
    }
  } catch {
    return lost;
  } finally {
    try { await reader.cancel(); } catch { /* A broken connection may already be closed. */ }
    reader.releaseLock();
  }
}
