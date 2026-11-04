// Magic UI's Dot Pattern (https://magicui.design/docs/components/dot-pattern, MIT), as an SVG <pattern> so a page-sized
// backdrop draws one tile rather than a circle per dot. The glow variant is left out.
import { useId } from "react";
import { cn } from "@/lib/utils";

interface DotPatternProps extends React.SVGProps<SVGSVGElement> {
  width?: number;
  height?: number;
  cx?: number;
  cy?: number;
  cr?: number;
}

export function DotPattern({ width = 16, height = 16, cx = 1, cy = 1, cr = 1, className, ...props }: DotPatternProps) {
  const id = useId();
  return (
    <svg aria-hidden="true" className={cn("pointer-events-none absolute inset-0 h-full w-full fill-current text-border-strong/60", className)} {...props}>
      <defs>
        <pattern id={id} width={width} height={height} patternUnits="userSpaceOnUse">
          <circle cx={cx} cy={cy} r={cr} />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}
