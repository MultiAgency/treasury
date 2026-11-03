import { RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";
import { isTreasury, type Gateway } from "../platform";
import { GatewayContext } from "./gateway-context";
import { AGENT } from "./location";
import { router } from "./router";
import { ViewerContext, viewerOf } from "./viewer";

/** Signed in: the Treasury agent's pages. At the host's root, open the account's treasury. */
export function AuthenticatedApp({ gateway }: { gateway: Gateway }) {
  const treasury = gateway.agents.find(isTreasury);
  useEffect(() => {
    if (gateway.viewer && treasury && !AGENT && !gateway.selfServiceTreasury) location.replace(`/a/${treasury.name}/`);
  }, [gateway.viewer, gateway.selfServiceTreasury, treasury?.name]);
  if (AGENT && !gateway.agents.some(agent => agent.name === AGENT && isTreasury(agent)))
    return <main className="mx-auto flex max-w-xl flex-col gap-4 p-8"><h1 className="text-xl font-semibold">Treasury unavailable</h1><p>This workspace contains Treasury agents only.</p><a href="/" className="underline">Open your treasuries</a></main>;
  // A self-service host's root lists the account's treasuries; setting one up moves here from the prototype later.
  if (!AGENT && gateway.selfServiceTreasury) return <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
    <h1 className="text-xl font-semibold">Your treasuries</h1>
    {gateway.agents.some(isTreasury)
      ? <ul className="flex flex-col gap-2">{gateway.agents.filter(isTreasury).map(agent => <li key={agent.name}><a href={`/a/${agent.name}/`} className="underline">{agent.name} · {agent.owner}</a></li>)}</ul>
      : <p>No Treasury agent is available to this account.</p>}
  </main>;
  if (!AGENT) return <main className="mx-auto max-w-xl p-8"><p role="status">{treasury ? "Opening treasury…" : "No Treasury agent is available to this account."}</p></main>;
  return <ViewerContext.Provider value={gateway.viewer ? viewerOf(gateway.viewer, AGENT) : null}>
    <GatewayContext.Provider value={gateway}><RouterProvider router={router} /></GatewayContext.Provider>
  </ViewerContext.Provider>;
}
