/** Pixel vault robot with a vault turning wheel; matched by the favicon in web/rsbuild.config.ts. */
export function Logo() {
  return (
    <svg viewBox="-3 -6 38 38" className="size-8 shrink-0 sm:size-9 text-logo" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="20" height="18" style={{ opacity: "var(--logo-tint)" }}/>
      <path fillRule="evenodd" d="M7 3h18v2h3v20h-3v2H7v-2H4V5h3zM7 6v18h18V6z"/>
      <path d="M7 27h4v3H7zm14 0h4v3h-4zM11-1h2v4h-2zm8 0h2v4h-2zM10-4h4v3h-4zm8 0h4v3h-4z"/>
      <g transform="rotate(20 16 15)">
      <circle cx="16" cy="15" r="5.3" fill="none" stroke="currentColor" strokeWidth={1.1} />
      <path d="M16 8v7m0 0 6.06 3.5M16 15l-6.06 3.5" fill="none" stroke="currentColor" strokeWidth={1.1} />
      <rect x="15" y="7.3" width="2" height="3" rx="0.4" />
      <rect x="15" y="7.3" width="2" height="3" rx="0.4" transform="rotate(120 16 15)" />
      <rect x="15" y="7.3" width="2" height="3" rx="0.4" transform="rotate(240 16 15)" />
      <circle cx="16" cy="15" r="1.8" />
      <circle cx="16" cy="15" r="1.1" fill="none" stroke="var(--background)" strokeWidth={0.3} opacity="0.5" />
      </g>
      <path fillRule="evenodd" d="M2 8h6v4H2zm1 1v2h1V9zm-1 10h6v4H2zm1 1v2h1v-2z" />
      <path d="M23.5 14h2v3h-2z" />
    </svg>
  );
}

export function TreasuryBrand() {
  return <div className="flex min-w-0 items-center gap-2"><Logo /><span className="font-heading text-sm font-semibold tracking-tight">Agentic<span className="block sm:inline"> Treasury</span></span></div>;
}
