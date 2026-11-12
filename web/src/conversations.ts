// The assistant's conversations (#219), one per agent and persona, kept outside the components so they survive moving
// between pages. Signing in or out clears them all: a conversation is the signed-in account's, and the next account in
// this tab must never see the last one's questions, answers or drafts, nor send them back as its history.
import { WHAT_IF_EVENTS, whatIfRequest, whatIfSelection, type WhatIfEventId, type WhatIfRequest } from "./agents-view.ts";
import type { AssistantAnswer, AssistantContext, AssistantPersona, AssistantWhatIf, RiskWhatIf } from "./proposals-api.ts";

export type Entry = { role: "user"; text: string } | { role: "assistant"; answer: AssistantAnswer } | { role: "error"; text: string };

export const conversations = new Map<string, Entry[]>();
export const busyKeys = new Set<string>();
export const toolProgress = new Map<string, Map<string, string>>();
const activeQuestions = new Map<string, symbol>();
/** A revision never repeats, including across sign-out: an old request cannot fill a new account's workspace. */
let workspaceRevision = 0;
export type WhatIfWorkspace = {
  event: WhatIfEventId; value: string; revision: number; selected: boolean;
  /** A combined or targeted scenario from chat, preserved until the owner edits a control. */
  fullRequest?: WhatIfRequest;
  answer?: RiskWhatIf;
};
export const whatIfWorkspaces = new Map<string, WhatIfWorkspace>();
const listeners = new Set<() => void>();
let current = 0;
export const version = () => current;
export const changed = () => { current++; for (const listener of listeners) listener(); };
export const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const conversationKey = (agent: string, persona: AssistantPersona) => `${agent}:${persona}`;
export const NONE: Entry[] = [];

export function beginQuestion(key: string) {
  const request = Symbol(key);
  activeQuestions.set(key, request);
  busyKeys.add(key);
  toolProgress.set(key, new Map());
  return request;
}
export const questionActive = (key: string, request: symbol) => activeQuestions.get(key) === request;
export function finishQuestion(key: string, request: symbol) {
  if (!questionActive(key, request)) return false;
  activeQuestions.delete(key);
  busyKeys.delete(key);
  toolProgress.delete(key);
  return true;
}

/** The form and both conversations use this same per-agent workspace while the app is loaded. */
export function whatIfWorkspace(agent: string): WhatIfWorkspace {
  let workspace = whatIfWorkspaces.get(agent);
  if (!workspace) {
    workspace = { event: "drop", value: WHAT_IF_EVENTS[0].start, revision: ++workspaceRevision, selected: false };
    whatIfWorkspaces.set(agent, workspace);
  }
  return workspace;
}

export function selectWhatIf(agent: string, event: WhatIfEventId, value: string) {
  const next = { event, value, revision: ++workspaceRevision, selected: true };
  whatIfWorkspaces.set(agent, next);
  changed();
  return next;
}

/** The newest question or manual run owns subsequent scenario results, even when the two personas run together. */
export function reserveWhatIf(agent: string, select = false) {
  const previous = whatIfWorkspace(agent);
  const next = { ...previous, selected: previous.selected || select, revision: ++workspaceRevision, ...(select && { answer: undefined }) };
  whatIfWorkspaces.set(agent, next);
  return next;
}

/** Only inputs travel back to the agent; numeric results must be read and computed on the server again. */
export function whatIfContext(agent: string): AssistantContext | undefined {
  const workspace = whatIfWorkspace(agent);
  if (!workspace.selected) return undefined;
  const checked = whatIfRequest(workspace.event, workspace.value);
  return checked.ok ? { whatIf: workspace.fullRequest ?? checked.request } : undefined;
}

/** A result cannot replace a scenario the owner edited or ran after the question began. */
export function acceptWhatIf(agent: string, scenario: AssistantWhatIf, revision: number) {
  const workspace = whatIfWorkspaces.get(agent);
  if (!workspace || workspace.revision !== revision) return false;
  const selection = whatIfSelection(scenario.event);
  if (!selection) return false;
  whatIfWorkspaces.set(agent, { event: selection.event, value: selection.value, revision, selected: true,
    ...(selection.combined && { fullRequest: scenario.event }), answer: scenario.answer });
  changed();
  return true;
}

/** Forgets every conversation: on sign-in and sign-out. */
export function clearConversations() {
  conversations.clear();
  busyKeys.clear();
  activeQuestions.clear();
  toolProgress.clear();
  whatIfWorkspaces.clear();
  changed();
}
