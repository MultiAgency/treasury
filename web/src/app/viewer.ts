import { createContext, useContext } from "react";
import { useIsFetching } from "@tanstack/react-query";
import type { Access } from "@multiagency/sdk";
import { mayCall } from "@multiagency/sdk";

/**
 * Who is looking, when the dashboard is hosted behind the gateway (src/gateway). Locally there is
 * no gateway and no viewer: the trusted local session can do everything.
 */
export type { Access };
/** The gateway's answer: the signed-in account and its access to each agent it may see. */
export type GatewayViewer = { account: string; access: Record<string, Access> };
/** Identity is shared across the workspace. Authority always belongs to the selected agent. */
export type Viewer = { account: string; access: Access | null };

export function viewerOf({ account, access }: GatewayViewer, agent: string | null): Viewer {
  return { account, access: agent !== null ? access[agent] ?? null : null };
}

/** The hosted viewer; null locally. */
export const ViewerContext = createContext<Viewer | null>(null);
export const useViewer = () => useContext(ViewerContext);

/**
 * Authority for one RPC on the selected agent. The gateway enforces the same rule. While the hosted
 * session is being reread (the tab returned, or another tab signed in or out), no control is offered:
 * the previous account's permissions are not confirmed for whoever is now signed in.
 */
export const useCanCall = (path: string) => {
  const viewer = useViewer();
  const confirming = useIsFetching({ queryKey: ["gateway"], exact: true }) > 0;
  return viewer === null || (!confirming && viewer.access !== null && mayCall(viewer.access, path));
};
