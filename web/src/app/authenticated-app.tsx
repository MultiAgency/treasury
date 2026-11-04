import { RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";
import { isTreasury, type Gateway } from "../platform";
import { CreateTreasury } from "../features/setup/create-treasury";
import { GatewayContext } from "./gateway-context";
import { AGENT } from "./location";
import { router } from "./router";
import { ViewerContext, viewerOf } from "./viewer";

/** Signed in: the Treasury agent's pages. At the host's root, open the account's treasury. */
export function AuthenticatedApp({ gateway }: { gateway: Gateway }) {
  const treasury = gateway.agents.find(isTreasury);
  useEffect(() => {
    if (gateway.viewer && treasury && !AGENT && !gateway.selfServiceTreasury) location.replace(`/a/${treasury.name}/`);
  }, [gateway.viewer?.account, gateway.selfServiceTreasury, treasury?.name]);
  if (AGENT && !gateway.agents.some(agent => agent.name === AGENT && isTreasury(agent)))
    return <main className="mx-auto flex max-w-xl flex-col gap-4 p-8"><h1 className="text-xl font-semibold">Treasury unavailable</h1><p>This workspace contains Treasury agents only.</p><a href="/" className="underline">Open your treasuries</a></main>;
  // A self-service host's root: the account's treasuries, and reserving a new one.
  if (!AGENT && gateway.selfServiceTreasury)
    return <ViewerContext.Provider value={gateway.viewer ? viewerOf(gateway.viewer, null) : null}><CreateTreasury gateway={gateway} /></ViewerContext.Provider>;
  // Without self-service setup this host can't create a Treasury: say so, rather than offering a form it would refuse.
  if (!AGENT) return <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
    <p role="status">{treasury ? "Opening treasury…" : "No Treasury agent is available to this account."}</p>
    {!treasury && <p className="text-sm text-muted-foreground">Creating a Treasury isn’t available on this host: it doesn’t offer Treasury setup. An existing Treasury opens here once this account owns it or is a member of its DAO.</p>}
  </main>;
  return <ViewerContext.Provider value={gateway.viewer ? viewerOf(gateway.viewer, AGENT) : null}>
    <GatewayContext.Provider value={gateway}><RouterProvider router={router} /></GatewayContext.Provider>
  </ViewerContext.Provider>;
}
