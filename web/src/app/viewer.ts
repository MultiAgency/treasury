import { createContext, useContext } from "react";
import type { Access } from "../../../src/gateway/roles.js";
import { mayCall } from "../../../src/gateway/allowlist.js";

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

/** Authority for one RPC on the selected agent. The gateway enforces the same rule. */
export const useCanCall = (path: string) => {
  const viewer = useViewer();
  return viewer === null || (viewer.access !== null && mayCall(viewer.access, path));
};
