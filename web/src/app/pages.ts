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
/** Pages reached by address only, as in the prototype: no link leads to them. */
export const HIDDEN_PAGES = { "/steward": "Steward" } as const;
/** A page's title; an address that isn't a page is named as such, so it isn't mistaken for the overview. */
export const pageTitle = (path: string): string => {
  const page = path.replace(/\/$/, "") || "/";
  return PAGES[page as Page] ?? HIDDEN_PAGES[page as keyof typeof HIDDEN_PAGES] ?? "Page not found";
};
