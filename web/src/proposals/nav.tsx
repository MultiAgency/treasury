import { Link } from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";

type PageLinkProps = { to: string; hash?: string; exact?: boolean; className?: string; children: ReactNode };
/**
 * A link between this build's pages, to an address `pages.ts` builds (`agentAddress`, `proposalAddress`): the links, the
 * navigation and the notifier's link all come from the same functions, which `pages.test.ts` reads back. TanStack's
 * `Link` is typed against the one router the owner UI registers (`app/router.tsx`), which isn't this build's, so this
 * build types its own. The router marks the link of the current page `aria-current="page"`; `exact` keeps a page's
 * section from matching its own sub-addresses (the Home link on every other page).
 */
const RouterLink = Link as unknown as ComponentType<{ to: string; hash?: string; activeOptions?: { exact: boolean }; className?: string; children: ReactNode }>;
export function PageLink({ to, hash, exact, className, children }: PageLinkProps) {
  return <RouterLink to={to} hash={hash} activeOptions={exact ? { exact: true } : undefined} className={className}>{children}</RouterLink>;
}
