import { useId } from "react";

/** The mark, drawn as the favicon is (web/rsbuild.config.ts): a safe in the logo blue, a tick cut from its dial. */
export function Logo() {
  const tick = useId();
  return (
    <svg viewBox="0 0 32 32" className="size-8 shrink-0 sm:size-9 text-logo" fill="currentColor" aria-hidden="true">
      <mask id={tick}>
        <rect width="32" height="32" fill="white" />
        <path d="M13.7 14.6l1.6 1.6 3-3.2" fill="none" stroke="black" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
      </mask>
      <rect x="6" y="5.5" width="20" height="18.5" style={{ opacity: "var(--logo-tint)" }} />
      <path fillRule="evenodd" d="M7.5 3h17a4 4 0 0 1 4 4v15.5a4 4 0 0 1-4 4h-17a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4zM6.5 6v17.5h19V6z" />
      <rect x="20" y="13.5" width="6" height="3" />
      <rect x="6.5" y="25.5" width="4" height="3.5" rx="1.5" />
      <rect x="21.5" y="25.5" width="4" height="3.5" rx="1.5" />
      <circle cx="16" cy="14.8" r="5.2" mask={`url(#${tick})`} />
    </svg>
  );
}

export function TreasuryBrand() {
  return <div className="flex min-w-0 items-center gap-2"><Logo /><span className="font-heading text-sm font-semibold tracking-tight">Agentic<span className="block sm:inline"> Treasury</span></span></div>;
}
