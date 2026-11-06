import { accountId, agentName } from "../../../apps/server/src/contract.ts";
import { proposalId } from "@multiagency/sdk";

/**
 * The server-served build's pages (#129): one table of addresses and titles, each page's `<h1>`. The routes are built from
 * it (`router.tsx`), and `place` reads an address the same way, so the title, the navigation and the router can't disagree.
 *
 * | Address | Page |
 * | --- | --- |
 * | `/` | Your treasuries |
 * | `/setup/dao/<dao>` | A DAO's Treasury |
 * | `/agents/<agent>/` | Home |
 * | `/agents/<agent>/proposals` | Proposals |
 * | `/agents/<agent>/proposals/<id>` | Proposal |
 * | `/agents/<agent>/strategy` | Strategy |
 * | `/agents/<agent>/funding` | Funding |
 * | `/agents/<agent>/policy` | Policy (#142: grants) |
 * | `/agents/<agent>/activity` | Activity (#136) |
 * | `/agents/<agent>/activity/runs/<id>` | Run |
 */
export const AGENT_PAGES = {
  home: { path: "", title: "Home" },
  proposals: { path: "/proposals", title: "Proposals" },
  strategy: { path: "/strategy", title: "Strategy" },
  funding: { path: "/funding", title: "Funding" },
  policy: { path: "/policy", title: "Policy" },
  activity: { path: "/activity", title: "Activity" },
} as const;
export type AgentPage = keyof typeof AGENT_PAGES;
/** The pages the navigation lists, in order. A page not built yet isn't here. */
export const NAVIGATION: readonly AgentPage[] = ["home", "proposals", "strategy", "funding", "policy", "activity"];

export const ROOT_TITLE = "Your treasuries";
export const DAO_TITLE = "A DAO's Treasury";
export const PROPOSAL_TITLE = "Proposal";
export const RUN_TITLE = "Run";
export const MISSING_TITLE = "Page not found";

/** An agent page's address. The home keeps its trailing slash, as the owner UI's pages do. */
export const agentAddress = (agent: string, page: AgentPage = "home") => `/agents/${agent}${AGENT_PAGES[page].path || "/"}`;
export const proposalAddress = (agent: string, id: string) => `/agents/${agent}/proposals/${id}`;
/** One recorded run of the autopilot, under the agent's Activity. */
export const runAddress = (agent: string, id: string) => `/agents/${agent}/activity/runs/${encodeURIComponent(id)}`;

/** Where an address is. An address that names nothing says what it got wrong, so it isn't mistaken for a page. */
export type Place =
  | { kind: "root"; title: string }
  | { kind: "dao"; title: string; dao: string }
  | { kind: "agent"; title: string; agent: string; page: AgentPage }
  | { kind: "proposal"; title: string; agent: string; id: string }
  | { kind: "run"; title: string; agent: string; id: string }
  | { kind: "missing"; title: string; why: string };

const decode = (text: string) => { try { return decodeURIComponent(text); } catch { return undefined; } };
const missing = (why: string): Place => ({ kind: "missing", title: MISSING_TITLE, why });

export function place(pathname: string): Place {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return { kind: "root", title: ROOT_TITLE };
  if (parts[0] === "setup" && parts[1] === "dao" && parts.length === 3) {
    const dao = decode(parts[2]!);
    return dao !== undefined && accountId.safeParse(dao).success ? { kind: "dao", title: DAO_TITLE, dao } : missing("This address doesn't name a DAO account.");
  }
  if (parts[0] === "agents" && parts[1] !== undefined) {
    const agent = parts[1];
    if (!agentName.safeParse(agent).success) return missing("This address doesn't name an agent: an agent's name is lowercase letters, digits and hyphens, at most 32.");
    if (parts.length === 2) return { kind: "agent", title: AGENT_PAGES.home.title, agent, page: "home" };
    const page = (Object.keys(AGENT_PAGES) as AgentPage[]).find(key => key !== "home" && AGENT_PAGES[key].path === `/${parts[2]}`);
    // Whether the ID is one is for the page to say (`isProposalId`): a bad one is shown as such, inside the agent's page.
    if (page === "proposals" && parts.length === 4) {
      // A malformed escape names nothing, as the router reads it: not a proposal ID that happens to be bad.
      const id = decode(parts[3]!);
      return id === undefined ? missing("This address isn't a page of this app.") : { kind: "proposal", title: PROPOSAL_TITLE, agent, id };
    }
    if (page === "activity" && parts[3] === "runs" && parts.length === 5) {
      const id = decode(parts[4]!);
      return id === undefined ? missing("This address isn't a page of this app.") : { kind: "run", title: RUN_TITLE, agent, id };
    }
    if (page !== undefined && parts.length === 3) return { kind: "agent", title: AGENT_PAGES[page].title, agent, page };
  }
  return missing("This address isn't a page of this app.");
}

/** Whether an address names a proposal: its ID is 32 lowercase hexadecimal characters. */
export const isProposalId = (id: string) => proposalId.safeParse(id).success;

/** Whether an address names a run: a tick's ID, as the server takes one in a path (`readId`). */
export const isRunId = (id: string) => /^[A-Za-z0-9_.:-]{1,128}$/.test(id);
