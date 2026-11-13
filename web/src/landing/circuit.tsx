import { type ReactNode, useEffect, useRef, useState } from "react";
import { NEAR_MARK } from "./near-mark";

/**
 * Hairline traces from the vault to its three token chips, routed like a board: straight runs, one radius per
 * corner, on an 8px grid, with terminal dots and light travelling toward the vault. Laid out in pixels from the
 * hero's size so the corners stay round at any aspect ratio. Desktop only.
 */

const CHIP_W = 188;
const CHIP_H = 54;
const RADIUS = 16;
const snap = (value: number) => Math.round(value / 8) * 8;

type Chip = { name: string; mark: ReactNode; value: string; x: number; y: number; path: string; start: [number, number]; end: [number, number] };

function layout(w: number, h: number, cyRatio: number): Chip[] {
  const cy = snap(h * cyRatio);
  const reach = snap(h * 0.4); // just outside the coins' orbit, so a coin never crosses a trace
  const gap = snap(h * 0.11); // the spacing between the left chips and the centre line
  const pad = snap(Math.max(48, w * 0.05));
  const leftEnd = snap(w / 2 - reach);
  const rightEnd = snap(w / 2 + reach);
  const chipRight = pad + CHIP_W;
  const bus = snap(chipRight + (leftEnd - chipRight) * 0.5);
  const fork = (y: number) => {
    const down = y < cy ? 1 : -1;
    return `M ${chipRight} ${y} H ${bus - RADIUS} Q ${bus} ${y} ${bus} ${y + down * RADIUS} V ${cy - down * RADIUS} Q ${bus} ${cy} ${bus + RADIUS} ${cy} H ${leftEnd}`;
  };
  const rightStart = w - pad - CHIP_W;
  return [
    { name: "wNEAR", mark: <svg viewBox="36 36 90 90" className="size-4" fill="currentColor" aria-hidden="true"><path d={NEAR_MARK} /></svg>, value: "Allocation target", x: pad, y: cy - gap, path: fork(cy - gap), start: [chipRight, cy - gap], end: [leftEnd, cy] },
    { name: "USDC", mark: "$", value: "Budget in USD", x: pad, y: cy + gap, path: fork(cy + gap), start: [chipRight, cy + gap], end: [leftEnd, cy] },
    { name: "ETH", mark: "Ξ", value: "Per-asset cap", x: rightStart, y: cy, path: `M ${rightStart} ${cy} H ${rightEnd}`, start: [rightStart, cy], end: [rightEnd, cy] },
  ];
}

export function Circuit({ cyRatio }: { cyRatio: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<[number, number] | null>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => entry && setSize([entry.contentRect.width, entry.contentRect.height]));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const chips = size ? layout(size[0], size[1], cyRatio) : [];
  return <div ref={host} className="lp-circuit" aria-hidden="true">
    {size && <svg width={size[0]} height={size[1]} className="absolute inset-0">
      <defs>
        {chips.map(chip => <linearGradient key={chip.name} id={`lp-fade-${chip.name}`} gradientUnits="userSpaceOnUse" x1={chip.start[0]} y1={chip.start[1]} x2={chip.end[0]} y2={chip.end[1]}>
          <stop offset="0" stopColor="#fff7d6" stopOpacity="0.55" />
          <stop offset="0.7" stopColor="#fff7d6" stopOpacity="0.28" />
          <stop offset="1" stopColor="#fff7d6" stopOpacity="0.06" />
        </linearGradient>)}
      </defs>
      {chips.map((chip, i) => <g key={chip.name}>
        <path d={chip.path} className="lp-trace" stroke={`url(#lp-fade-${chip.name})`} />
        <path d={chip.path} pathLength={100} className="lp-trace-pulse" style={{ animationDelay: `${1.6 + i * 1.1}s` }} />
        <circle cx={chip.start[0]} cy={chip.start[1]} r="2.5" className="lp-trace-dot" />
      </g>)}
      {/* One terminal per side where the traces meet the vault. */}
      <circle cx={chips[0]!.end[0]} cy={chips[0]!.end[1]} r="2.5" className="lp-trace-dot lp-trace-dot-end" />
      <circle cx={chips[2]!.end[0]} cy={chips[2]!.end[1]} r="2.5" className="lp-trace-dot lp-trace-dot-end" />
    </svg>}
    {chips.map((chip, i) => <div key={chip.name} className="lp-chip" style={{ left: chip.x, top: chip.y - CHIP_H / 2, width: CHIP_W, height: CHIP_H, animationDelay: `${300 + i * 120}ms` }}>
      <span className="lp-chip-mark">{chip.mark}</span>
      <span className="flex min-w-0 flex-col">
        <span className="text-[13.5px] font-medium leading-tight text-white">{chip.name}</span>
        <span className="font-mono text-[10.5px] leading-tight tracking-wide text-white/60">{chip.value}</span>
      </span>
    </div>)}
  </div>;
}
