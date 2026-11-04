// Magic UI's Animated Shiny Text (https://magicui.design/docs/components/animated-shiny-text, MIT). Its keyframes are
// `--animate-shiny-text` in styles.css.
import type { ComponentPropsWithoutRef, CSSProperties, FC } from "react";
import { cn } from "@/lib/utils";

export interface AnimatedShinyTextProps extends ComponentPropsWithoutRef<"span"> {
  shimmerWidth?: number;
}

export const AnimatedShinyText: FC<AnimatedShinyTextProps> = ({ children, className, shimmerWidth = 100, ...props }) => (
  <span
    style={{ "--shiny-width": `${shimmerWidth}px` } as CSSProperties}
    className={cn(
      "text-muted-foreground",
      "animate-shiny-text bg-size-[var(--shiny-width)_100%] bg-clip-text bg-position-[0_0] bg-no-repeat [transition:background-position_1s_cubic-bezier(.6,.6,0,1)_infinite]",
      "bg-linear-to-r from-transparent via-foreground/80 via-50% to-transparent",
      className,
    )}
    {...props}
  >
    {children}
  </span>
);
