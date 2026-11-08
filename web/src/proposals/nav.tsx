import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

type PageLinkProps = { to: string; hash?: string; exact?: boolean; className?: string; children: ReactNode };
/**
 * A link between this build's pages, to an address `pages.ts` builds (`agentAddress`, `proposalAddress`): the links, the
 * navigation and the notifier's link all come from the same functions, which `pages.test.ts` reads back. The router marks the link of the current page `aria-current="page"`; `exact` keeps a page's
 * section from matching its own sub-addresses (the Home link on every other page).
 */
export function PageLink({ to, hash, exact, className, children }: PageLinkProps) {
  return <Link to={to} hash={hash} activeOptions={exact ? { exact: true } : undefined} className={className}>{children}</Link>;
}
