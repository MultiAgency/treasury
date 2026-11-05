import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AgentFrame, DaoPage, FundingPage, HomePage, Missing, ProposalPage, ProposalsPage, RootPage, Shell, StrategyPage } from "./app";
import { AGENT_PAGES } from "./pages";

/**
 * This build's routes, from the table in `pages.ts`: the account's treasuries, a DAO's setup, and an agent's pages inside
 * its frame. An address that matches nothing is named as such. The server answers every path outside `/api/` and
 * `static/` with this page (`apps/server/src/page.ts`), so any address here loads when opened directly.
 */
const root = createRootRoute({ component: Shell, notFoundComponent: () => <Missing /> });
const route = (path: string, component: () => React.ReactNode) => createRoute({ getParentRoute: () => root, path, component });

const agent = createRoute({ getParentRoute: () => root, path: "/agents/$agent", component: AgentFrame });
const page = (path: string, component: () => React.ReactNode) => createRoute({ getParentRoute: () => agent, path, component });

export const router = createRouter({
  // The home keeps its trailing slash (`/agents/<agent>/`) and every other address has none: both load.
  trailingSlash: "preserve",
  routeTree: root.addChildren([
    route("/", RootPage),
    route("/setup/dao/$dao", DaoPage),
    agent.addChildren([
      page("/", HomePage),
      page(AGENT_PAGES.proposals.path, ProposalsPage),
      page(`${AGENT_PAGES.proposals.path}/$id`, ProposalPage),
      page(AGENT_PAGES.strategy.path, StrategyPage),
      page(AGENT_PAGES.funding.path, FundingPage),
    ]),
  ]),
});
