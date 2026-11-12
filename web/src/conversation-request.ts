import { acceptWhatIf, beginQuestion, busyKeys, changed, conversationKey, conversations, finishQuestion, NONE, questionActive,
  reserveWhatIf, toolProgress, whatIfContext } from "./conversations.ts";
import type { AssistantAnswer, AssistantPersona, ServerApi, Result } from "./server-api.ts";
import { failureText } from "./words.ts";

type Turn = { role: "user" | "assistant"; text: string };
type AskStream = ReturnType<ServerApi["agent"]>["askStream"];

/** One live question, shared by the sheet and Agents page. Every callback belongs to this request and signed-in session. */
export async function askConversation(agent: string, persona: AssistantPersona, askStream: AskStream, text: string) {
  const key = conversationKey(agent, persona);
  const asked = text.trim();
  if (!asked || busyKeys.has(key)) return;
  const current = conversations.get(key) ?? NONE;
  const history = current.flatMap((entry): Turn[] => entry.role === "user" ? [{ role: "user", text: entry.text.slice(0, 1_200) }]
    : entry.role === "assistant" ? [{ role: "assistant", text: entry.answer.answer.slice(0, 1_200) }] : []).slice(-8);
  const context = whatIfContext(agent);
  const revision = reserveWhatIf(agent).revision;
  conversations.set(key, [...current, { role: "user", text: asked }]);
  const request = beginQuestion(key);
  changed();
  let answer: Result<AssistantAnswer>;
  try {
    answer = await askStream(asked, history, persona, { context, onEvent: event => {
      if (!questionActive(key, request)) return;
      if (event.type === "TOOL_CALL_START") toolProgress.get(key)?.set(event.toolCallId, event.toolCallName);
      if (event.type === "TOOL_CALL_RESULT") toolProgress.get(key)?.delete(event.toolCallId);
      if (event.type === "STATE_SNAPSHOT" && event.snapshot.whatIf) acceptWhatIf(agent, event.snapshot.whatIf, revision);
      changed();
    } });
  } catch { answer = { ok: false, kind: "lost" }; }
  // Sign-out invalidates the whole request, including callbacks already queued by a stream reader.
  if (!finishQuestion(key, request)) return;
  if (answer.ok && answer.value.whatIf) acceptWhatIf(agent, answer.value.whatIf, revision);
  conversations.set(key, [...(conversations.get(key) ?? NONE), answer.ok ? { role: "assistant", answer: answer.value } : { role: "error",
    text: answer.kind === "refused" && answer.code === "rate_limited" ? "You've asked the most questions an hour allows. Try again later."
      : answer.kind === "refused" && answer.code === "platform_budget" ? "The assistant has used its share of the platform's reads for this hour. Try again later, or read the page directly."
      : answer.kind === "refused" && answer.code === "assistant_not_configured" ? "The assistant isn't set up on this server."
      : answer.kind === "lost" ? "The answer was lost. Asking again is safe: a question sends nothing."
      : failureText(answer, "read") }]);
  changed();
}
