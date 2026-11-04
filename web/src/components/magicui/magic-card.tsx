// Magic UI's Magic Card (https://magicui.design/docs/components/magic-card, MIT), gradient mode: a spotlight follows
// the pointer across the card and lights its border. Colours default to Arc's accent and second chart series; the orb
// mode (and its next-themes dependency) is left out.
import { useCallback, useEffect, type ReactNode } from "react";
import { motion, useMotionTemplate, useMotionValue } from "motion/react";
import { cn } from "@/lib/utils";

interface MagicCardProps {
  children?: ReactNode;
  className?: string;
  gradientSize?: number;
  gradientColor?: string;
  gradientOpacity?: number;
  gradientFrom?: string;
  gradientTo?: string;
}

export function MagicCard({
  children,
  className,
  gradientSize = 220,
  gradientColor = "var(--accent-subtle)",
  gradientOpacity = 0.9,
  gradientFrom = "var(--accent)",
  gradientTo = "var(--series-2)",
}: MagicCardProps) {
  const mouseX = useMotionValue(-gradientSize);
  const mouseY = useMotionValue(-gradientSize);
  const reset = useCallback(() => { mouseX.set(-gradientSize); mouseY.set(-gradientSize); }, [mouseX, mouseY, gradientSize]);
  useEffect(() => {
    const out = (e: PointerEvent) => { if (!e.relatedTarget) reset(); };
    window.addEventListener("pointerout", out);
    window.addEventListener("blur", reset);
    return () => { window.removeEventListener("pointerout", out); window.removeEventListener("blur", reset); };
  }, [reset]);
  const border = useMotionTemplate`linear-gradient(var(--color-card) 0 0) padding-box, radial-gradient(${gradientSize}px circle at ${mouseX}px ${mouseY}px, ${gradientFrom}, ${gradientTo}, var(--color-border) 100%) border-box`;
  const glow = useMotionTemplate`radial-gradient(${gradientSize}px circle at ${mouseX}px ${mouseY}px, ${gradientColor}, transparent 100%)`;
  return (
    <motion.div
      className={cn("group relative isolate overflow-hidden rounded-2xl border border-transparent", className)}
      onPointerMove={e => { const rect = e.currentTarget.getBoundingClientRect(); mouseX.set(e.clientX - rect.left); mouseY.set(e.clientY - rect.top); }}
      onPointerLeave={reset}
      style={{ background: border }}
    >
      <div className="absolute inset-px z-0 rounded-[inherit] bg-card" />
      <motion.div aria-hidden="true" className="pointer-events-none absolute inset-px z-10 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover:opacity-100" style={{ background: glow, opacity: gradientOpacity }} />
      <div className="relative z-20">{children}</div>
    </motion.div>
  );
}
