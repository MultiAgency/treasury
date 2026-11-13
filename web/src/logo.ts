/**
 * The mark's geometry: a ribbon cut into upright bars. The ribbon's top and bottom edges are sampled at the centres of
 * its 22 bars, in a box 100 wide and `LOGO_HEIGHT` tall; `logoPath` cuts the same ribbon into any number of bars, so a
 * small mark takes fewer, wider bars and stays legible. Shared by the page's logo (`brand.tsx`) and the favicon
 * (`rsbuild.config.ts`).
 */
const TOP = [23.7, 18.2, 12.8, 8.1, 4.1, 1.4, 0.2, 0.6, 2.4, 5.8, 10.1, 15.1, 20.3, 25.1, 27.5, 27.2, 25.2, 22.2, 19, 15.8, 12.8, 9.9];
const BOTTOM = [44.8, 41.4, 37.7, 34.3, 31, 28, 25.3, 23.5, 22.4, 22.4, 23.3, 25.3, 28.3, 32, 35.9, 39.7, 43.2, 46, 47.4, 47.3, 45.9, 43];
/** A bar's width as a share of the distance from one bar to the next. */
const BAR = 0.467;
export const LOGO_WIDTH = 100;
export const LOGO_HEIGHT = 47.6;

const pitchOf = (bars: number) => LOGO_WIDTH / (bars - 1 + BAR);

/** An edge's height at `x`: a straight line between the samples either side, carried on past the first and last. */
function edge(samples: readonly number[], x: number): number {
  const pitch = pitchOf(samples.length);
  const at = (x - (BAR * pitch) / 2) / pitch;
  const i = Math.min(Math.max(Math.floor(at), 0), samples.length - 2);
  return samples[i]! + (samples[i + 1]! - samples[i]!) * (at - i);
}

/** The mark as one SVG path of `bars` bars. */
export function logoPath(bars: number): string {
  const pitch = pitchOf(bars), width = BAR * pitch;
  const n = (value: number) => String(Math.round(value * 100) / 100);
  return Array.from({ length: bars }, (_, i) => {
    const left = i * pitch, right = left + width;
    return `M${n(left)} ${n(edge(TOP, left))}L${n(right)} ${n(edge(TOP, right))}V${n(edge(BOTTOM, right))}L${n(left)} ${n(edge(BOTTOM, left))}Z`;
  }).join("");
}
