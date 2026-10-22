/**
 * The embeddable Treasury: what a host app loads through Module Federation (`./mount`).
 * The host names the treasury's agent and the account it has signed in; the gateway still decides
 * what that account may see, and a different signed-in account shows nothing private. Owner signing and
 * money actions are the app's own explicit steps; this API has no way to start one.
 * The app keeps its own place in memory and never navigates the host: see docs/embedding.md.
 */
import type { MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { setEmbedHost } from "./shared/embed";
import "./styles.css";
import "./treasury-theme.css";

export type TreasuryEmbedOptions = {
  /** The agent's name, as in `/a/<agent>/`. */
  agent: string;
  /** The account the host has signed in. */
  account: string;
};
export type TreasuryEmbed = { unmount: () => void };

let mounted = false;

export async function mount(container: HTMLElement, options: TreasuryEmbedOptions): Promise<TreasuryEmbed> {
  if (!/^[a-z0-9-]+$/.test(options?.agent ?? "")) throw new Error("mount needs the agent's name, for example { agent: \"treasury\", account: \"dao.near\" }");
  if (!options.account) throw new Error("mount needs the account the host has signed in");
  if (mounted) throw new Error("Treasury is already mounted in this page. Unmount it first.");
  setEmbedHost({ agent: options.agent, account: options.account });
  mounted = true;
  // After the host is known: the app reads its agent address when its modules first run.
  const [{ TreasuryRoot, rereadAccess }, { router }, { BASE }, { onEmbeddedRecheck }] = await Promise.all([
    import("./treasury-root"), import("./app/router"), import("./shared/client"), import("./shared/access"),
  ]);
  onEmbeddedRecheck(rereadAccess);

  /** Links inside Treasury move within it; none may navigate the host page. */
  const keepInside = (event: MouseEvent<HTMLDivElement>) => {
    const link = (event.target as Element).closest?.("a[href]");
    // The router's own links have already moved Treasury and prevented the browser's navigation.
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const href = link.getAttribute("href") ?? "";
    if (link.getAttribute("target") === "_blank" || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
    event.preventDefault();
    // Plain anchors under this agent go through the router; any other address (the host's, a sibling agent's) does nothing.
    if (href === BASE || href.startsWith(`${BASE}/`) || href.startsWith(`${BASE}#`) || href.startsWith(`${BASE}?`)) router.history.push(href);
    else if (href.startsWith("#")) router.history.push(`${router.history.location.pathname}${href}`);
  };

  const root = createRoot(container);
  root.render(<div onClick={keepInside}><TreasuryRoot /></div>);
  return { unmount: () => { root.unmount(); mounted = false; } };
}
