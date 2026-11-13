import { useEffect, useRef, useState } from "react";

/**
 * The intro while the vault loads: its wireframe draws itself in gold hairlines, the core swells from a point of
 * light, and a readout counts to 100 as the real stages land (code, renderer, first frames). It takes at least
 * MIN_MS so a fast load still reads as an opening, and never waits on anything but the load itself.
 */

const MIN_MS = 1300;

export function Intro({ target, onDone }: { target: number; onDone: () => void }) {
  const [shown, setShown] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const targetRef = useRef(target);
  targetRef.current = target;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    const start = performance.now();
    let value = 0;
    let frame = 0;
    let finished = false;
    let last = start;
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      // The count eases toward the stage reached, and the clock caps it, so it never jumps or finishes early.
      // A frame's timestamp can precede the effect's start: never below 0.
      const cap = Math.max(0, Math.min(100, ((now - start) / MIN_MS) * 100));
      const goal = Math.min(targetRef.current, cap);
      // Time-based easing, so a slow device's long frames don't stretch the count.
      value += (goal - value) * (1 - Math.exp(-dt / 140));
      if (goal - value < 0.4) value = goal;
      setShown(value);
      if (value >= 100 && !finished) {
        finished = true;
        setLeaving(true);
        setTimeout(() => doneRef.current(), 180);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  const s = 100;
  const c = 0.866 * s;
  const hexagon = `M 0 ${-s} L ${c} ${-s / 2} L ${c} ${s / 2} L 0 ${s} L ${-c} ${s / 2} L ${-c} ${-s / 2} Z`;
  const near = `M ${-c} ${-s / 2} L 0 0 L ${c} ${-s / 2} M 0 0 L 0 ${s}`;
  const far = `M ${-c} ${s / 2} L 0 0 L ${c} ${s / 2} M 0 0 L 0 ${-s}`;
  return <div className={`lp-intro${leaving ? " is-leaving" : ""}`} aria-hidden="true">
    <svg className="lp-intro-cube" viewBox="-120 -120 240 240">
      <path d={hexagon} pathLength={1} className="lp-intro-line" />
      <path d={near} pathLength={1} className="lp-intro-line" style={{ animationDelay: "0.35s" }} />
      <path d={far} pathLength={1} className="lp-intro-line lp-intro-hidden" style={{ animationDelay: "0.6s" }} />
      <circle r="9" className="lp-intro-core" />
    </svg>
    <div className="lp-intro-readout">
      <span>Opening the vault</span>
      <span className="lp-intro-bar"><i style={{ transform: `scaleX(${shown / 100})` }} /></span>
      <span className="tabular-nums text-white">{String(Math.round(shown)).padStart(3, "0")}</span>
    </div>
  </div>;
}
