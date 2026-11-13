// The steps of "Your first Treasury transaction" on Home: what is done, what is next, and what the next step needs said.
// Pure, so it is tested without a browser. With its extension: test/first-transaction-view.test.ts loads this module under Node.
import type { AgentPage } from "./pages.ts";
import { fundedStatus } from "./standing-view.ts";

/** `unread`: the step is decided by a read the page can't make until the agent is connected, so it is neither done nor to do. */
export type StepState = "done" | "todo" | "unread";
export type Step = { label: string; state: StepState; page: AgentPage; hash?: "connection"; note?: string };

const AUTOPILOT = "Autopilot is optional and can stay off.";

/** The steps in order. `grantMatches` is null on a host that only approves, which has no strategy to authorize here. */
export function firstSteps({ connected, book, notInForce, grantMatches }: {
  connected: boolean; book: Parameters<typeof fundedStatus>[0] | undefined; notInForce: string | null | undefined; grantMatches: boolean | null | undefined;
}): Step[] {
  const read = (done: boolean | undefined): StepState => !connected || done === undefined ? "unread" : done ? "done" : "todo";
  return [
    { label: "Create the agent", state: "done", page: "home" },
    { label: "Connect Treasury", state: connected ? "done" : "todo", page: "home", hash: "connection" },
    { label: "Fund the agent", state: read(book && fundedStatus(book).funded), page: "funding" },
    { label: "Check the policy", state: read(notInForce === undefined ? undefined : !notInForce), page: "policy" },
    ...(grantMatches === null ? [] : [{ label: "Authorize the strategy", state: read(grantMatches), page: "strategy" as const,
      note: `Authorize the saved strategy on Strategy before creating a proposal. ${AUTOPILOT}` }]),
    { label: "Review a proposal", state: read(false), page: "proposals",
      note: grantMatches === null ? `This host only approves proposals; strategy authorization is managed on the agent’s executor. ${AUTOPILOT}` : AUTOPILOT },
  ];
}

/** The first step not done: the one the card links to, and whose note it shows. The last is never done while the card shows. */
export const nextStep = (steps: readonly Step[]): Step => steps.find(step => step.state !== "done")!;
