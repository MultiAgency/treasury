import { LOGO_HEIGHT, LOGO_WIDTH, logoPath } from "./logo";

/**
 * The mark, in the brand's colour. Nine bars read at the sizes of a header or a sidebar; a large mark takes all 22.
 * The favicon is the same ribbon (`rsbuild.config.ts`).
 */
export function Logo({ className = "size-8 sm:size-9", bars = 9 }: { className?: string; bars?: number } = {}) {
  return <svg viewBox={`0 0 ${LOGO_WIDTH} ${LOGO_HEIGHT}`} className={`${className} shrink-0 text-primary`} fill="currentColor" aria-hidden="true">
    <path d={logoPath(bars)} />
  </svg>;
}
