import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

// Arc UI's button (https://uiarc.dev/components/button): solid foreground primary, surface secondary with a hairline,
// quiet ghost; a short press scale and Arc's standard easing. Shared controls keep a 44px minimum.
const buttonVariants = cva(
  "group/button relative inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-4xl border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,opacity,scale] duration-150 ease-arc select-none active:not-disabled:scale-[.97] aria-haspopup:active:scale-100 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "border-foreground bg-foreground text-background shadow-resting hover:opacity-90 hover:shadow-raised",
        brand: "border-brand bg-brand text-[var(--accent-foreground)] shadow-resting hover:shadow-raised hover:brightness-105",
        outline:
          "border-border bg-surface text-foreground shadow-resting hover:border-border-strong hover:bg-muted aria-expanded:bg-muted",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-muted aria-expanded:bg-muted",
        ghost:
          "bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        destructive:
          "border-border bg-surface text-destructive-muted-foreground shadow-resting hover:border-destructive-muted-foreground/60 hover:bg-destructive-muted",
        link: "text-foreground underline underline-offset-4 decoration-border-strong hover:decoration-foreground",
      },
      size: {
        default:
          "h-11 gap-2 px-5",
        xs: "h-11 gap-1 px-3 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "gap-2 px-4",
        lg: "h-12 gap-2 px-6 text-base",
        icon: "size-11",
        "icon-xs": "size-11 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-11",
        "icon-lg": "size-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  type = "button",
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      type={type}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
