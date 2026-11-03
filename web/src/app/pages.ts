/** The Treasury's pages: their addresses (kept from the prototype, so saved links work) and titles. */
export const PAGES = {
  "/": "Overview",
  "/automations": "Strategy",
  "/follow/run": "Runs",
  "/funding": "Balances & funding",
  "/policy": "Policy & grants",
  "/demo": "Guided walkthrough",
  "/activity": "Operation status",
} as const;
export type Page = keyof typeof PAGES;
/** A page's title; an address that isn't a page is named as such, so it isn't mistaken for the overview. */
export const pageTitle = (path: string): string => PAGES[(path.replace(/\/$/, "") || "/") as Page] ?? "Page not found";
