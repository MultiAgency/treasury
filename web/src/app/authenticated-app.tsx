import { CreateTreasury } from "./create-treasury";
import { useEffect } from "react";
import { TREASURY_ONLY } from "../treasury-surface";
import { GatewayContext } from "./gateway-context";
import { RouterProvider } from "@tanstack/react-router";
import { DaoHome } from "../features/workspace/dao";
import { Workspace } from "./workspace";
import { BASE } from "../shared/client";
import { router } from "./router";
import type { Gateway } from "./session";
import { ViewerContext, viewerOf } from "./viewer";

export function AuthenticatedApp({ gateway, activity }: { gateway: Gateway | null; activity: boolean }) {
  const treasury = gateway?.agents.find(agent => agent.area === "treasury" || agent.name === "treasury");
  useEffect(() => {
    if (TREASURY_ONLY && gateway?.viewer && treasury && !BASE && !gateway.selfServiceTreasury) location.replace(`/a/${treasury.name}/`);
  }, [gateway?.viewer, treasury?.name]);
  if (TREASURY_ONLY && gateway?.viewer && gateway.selfServiceTreasury && !BASE) return <ViewerContext.Provider value={viewerOf(gateway.viewer, null)}><CreateTreasury gateway={gateway} /></ViewerContext.Provider>;
  if (TREASURY_ONLY && gateway && !BASE) return <main className="mx-auto max-w-xl p-8"><p role="status">{treasury ? "Opening treasury…" : "No Treasury agent is available to this account."}</p></main>;
  return <ViewerContext.Provider value={gateway?.viewer ? viewerOf(gateway.viewer, BASE ? BASE.slice("/a/".length) : null) : null}>
    <GatewayContext.Provider value={gateway}>{gateway && !BASE ? <Workspace gateway={gateway} activity={activity}><DaoHome gateway={gateway} activity={activity} /></Workspace> : <RouterProvider router={router} />}</GatewayContext.Provider>
  </ViewerContext.Provider>;
}
