import { Link } from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";

type PageLinkProps = { to: string; params?: Record<string, string>; hash?: string; exact?: boolean; className?: string; children: ReactNode };
/**
 * A link between this build's pages. TanStack's `Link` is typed against the one router the owner UI registers
 * (`app/router.tsx`), which isn't this build's, so this build types its own: the addresses are the ones in `pages.ts`.
 * The router marks the link of the current page `aria-current="page"`; `exact` keeps a page's section from matching its
 * own sub-addresses (the Home link on every other page).
 */
const RouterLink = Link as unknown as ComponentType<{ to: string; params?: Record<string, string>; hash?: string; activeOptions?: { exact: boolean }; className?: string; children: ReactNode }>;
export function PageLink({ to, params, hash, exact, className, children }: PageLinkProps) {
  return <RouterLink to={to} params={params} hash={hash} activeOptions={exact ? { exact: true } : undefined} className={className}>{children}</RouterLink>;
}
