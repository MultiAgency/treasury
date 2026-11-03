import { createContext, useContext } from "react";
import { useIsFetching } from "@tanstack/react-query";
import { gatewayRead, mayCall, type Access, type Gateway } from "../platform";
import { useWallet } from "./wallet";

/** Identity is shared across the host. Authority always belongs to the selected agent. */
export type Viewer = { account: string; access: Access | null };

export function viewerOf({ account, access }: NonNullable<Gateway["viewer"]>, agent: string | null): Viewer {
  return { account, access: agent !== null ? access[agent] ?? null : null };
}

export const ViewerContext = createContext<Viewer | null>(null);
export const useViewer = () => useContext(ViewerContext);

/**
 * Authority for one procedure on the selected agent; the gateway enforces the same rule. While the session is being
 * reread (the tab returned, or another tab signed in or out), no control is offered: the previous account's
 * permissions are not confirmed for whoever is now signed in. Nor while the wallet is connected to another account
 * than the session's: it would sign as someone else.
 */
export const useCanCall = (path: string) => {
  const viewer = useViewer();
  const wallet = useWallet();
  const confirming = useIsFetching({ queryKey: gatewayRead.queryKey, exact: true }) > 0;
  const otherWallet = wallet.status === "connected" && wallet.accountId !== undefined && wallet.accountId !== viewer?.account;
  return viewer !== null && !confirming && !otherWallet && viewer.access !== null && mayCall(viewer.access, path);
};
