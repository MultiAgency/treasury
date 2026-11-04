// Magic UI's Blur Fade (https://magicui.design/docs/components/blur-fade, MIT), trimmed to what the app uses: content
// rises in from a soft blur, at full opacity. Under reduced motion it simply appears.
import { useRef } from "react";
import { motion, useReducedMotion, type MotionProps } from "motion/react";

interface BlurFadeProps extends MotionProps {
  children: React.ReactNode;
  className?: string;
  duration?: number;
  delay?: number;
  offset?: number;
  blur?: string;
}

export function BlurFade({ children, className, duration = 0.4, delay = 0, offset = 6, blur = "6px", ...props }: BlurFadeProps) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  return <motion.div
    ref={ref}
    // No opacity: text is never shown, nor measured for contrast, at less than full strength.
    initial={reduced ? false : { y: offset, filter: `blur(${blur})` }}
    animate={reduced ? undefined : { y: 0, filter: "blur(0px)" }}
    transition={{ delay: 0.04 + delay, duration: reduced ? 0.12 : duration, ease: [0.16, 1, 0.3, 1] }}
    // A finished fade leaves no filter or transform behind: either would become the containing block of fixed children.
    onAnimationComplete={() => { if (ref.current) { ref.current.style.filter = ""; ref.current.style.transform = ""; } }}
    className={className}
    {...props}
  >
    {children}
  </motion.div>;
}
