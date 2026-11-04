// Magic UI's Number Ticker (https://magicui.design/docs/components/number-ticker, MIT), adapted: it formats with the
// caller's formatter, says the final value to assistive technology at once (the rolling digits are hidden from it),
// and shows the value without rolling when reduced motion is asked for.
import { useEffect, useRef, type ComponentPropsWithoutRef } from "react";
import { useInView, useMotionValue, useReducedMotion, useSpring } from "motion/react";
import { cn } from "@/lib/utils";

interface NumberTickerProps extends Omit<ComponentPropsWithoutRef<"span">, "children"> {
  value: number;
  format: (value: number) => string;
  startValue?: number;
  delay?: number;
}

export function NumberTicker({ value, format, startValue = 0, delay = 0, className, ...props }: NumberTickerProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();
  const motionValue = useMotionValue(reduced ? value : startValue);
  const springValue = useSpring(motionValue, { damping: 60, stiffness: 100 });
  const inView = useInView(ref, { once: true, margin: "0px" });

  useEffect(() => {
    if (reduced) {
      motionValue.jump(value);
      springValue.jump(value);
      return;
    }
    if (!inView) return;
    const timer = setTimeout(() => motionValue.set(value), delay * 1000);
    return () => clearTimeout(timer);
  }, [motionValue, springValue, inView, delay, value, reduced]);

  useEffect(() => springValue.on("change", latest => {
    if (ref.current) ref.current.textContent = format(latest);
  }), [springValue, format]);

  return <span className={cn("inline-block tabular-nums", className)} {...props}>
    <span ref={ref} aria-hidden="true">{format(reduced ? value : startValue)}</span>
    <span className="sr-only">{format(value)}</span>
  </span>;
}
