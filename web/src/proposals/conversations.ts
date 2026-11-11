// The assistant's conversations (#219), one per agent and persona, kept outside the components so they survive moving
// between pages. Signing in or out clears them all: a conversation is the signed-in account's, and the next account in
// this tab must never see the last one's questions, answers or drafts, nor send them back as its history.
import type { AssistantAnswer, AssistantPersona } from "./proposals-api.ts";

export type Entry = { role: "user"; text: string } | { role: "assistant"; answer: AssistantAnswer } | { role: "error"; text: string };

export const conversations = new Map<string, Entry[]>();
export const busyKeys = new Set<string>();
const listeners = new Set<() => void>();
let current = 0;
export const version = () => current;
export const changed = () => { current++; for (const listener of listeners) listener(); };
export const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const conversationKey = (agent: string, persona: AssistantPersona) => `${agent}:${persona}`;
export const NONE: Entry[] = [];

/** Forgets every conversation: on sign-in and sign-out. */
export function clearConversations() {
  conversations.clear();
  busyKeys.clear();
  changed();
}
