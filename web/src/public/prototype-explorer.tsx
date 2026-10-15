import { useEffect, useRef } from "react";
import { PrototypeCard } from "../features/evidence/showcase";

const link = "inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4 hover:text-brand-strong";

/** Legacy example links retain a public overview and requirement stages without agent reads. */
export function PrototypeExplorer({ area, page }: { area: "payables" | "treasury"; page: string }) {
  const name = area === "payables" ? "Payables" : "Portfolio";
  const pages = area === "payables"
    ? ["overview", "agreements", "invoices", "activity", "policy"]
    : ["overview", "automations", "activity", "policy"];
  const known = pages.includes(page);
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    main.current?.focus({ preventScroll: true });
  }, [area, page]);

  return <div className="mx-auto max-w-5xl px-4 py-6 sm:p-8">
    <a href="#public-overview-main" className="sr-only focus:not-sr-only" onClick={e => { e.preventDefault(); main.current?.focus(); }}>Skip to main content</a>
    <header className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
      <a className={link} href="/">Back to landing page</a>
      <span className="text-sm text-muted-foreground">Public overview</span>
    </header>
    <main ref={main} id="public-overview-main" tabIndex={-1} className="flex min-w-0 flex-col gap-6 py-6">
      <h1 className="text-3xl font-semibold tracking-tight">{known ? `${name} overview` : "Page not found"}</h1>
      {known ? <>
        <p className="max-w-prose leading-relaxed text-muted-foreground">{area === "payables"
          ? "Payees submit invoices. Each payout is held for owner review; approval lets payment proceed. Follow the payment record to confirm its outcome."
          : "The owner sets target allocations and limits. The agent prepares quoted swaps; scheduled execution requires a live grant and a plan within the strategy’s auto-execute limit."}</p>
        <PrototypeCard kind={area === "payables" ? "facilitator" : "treasury"} stagesOnly />
      </> : <a href={`#/explore/${area}/overview`} className={link}>View {name} overview</a>}
    </main>
    <footer className="border-t pt-4">
      <a className={link} href={`#/explore/${area === "payables" ? "treasury" : "payables"}/overview`}>Explore {area === "payables" ? "Portfolio" : "Payables"}</a>
    </footer>
  </div>;
}
