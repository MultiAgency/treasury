import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "group/button inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-colors select-none md:min-h-9 md:min-w-9 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      /*
       * Compact on a pointer (36px, 32px small), 44px on a phone's touch. The primary action is the brand gold; a
       * destructive one is a red tint, and `danger` its trigger's red outline.
       */
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/88",
        outline:
          "border-border-strong bg-transparent text-foreground hover:bg-accent aria-expanded:bg-accent",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-accent aria-expanded:bg-secondary",
        ghost:
          "bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        destructive:
          "border-destructive/30 bg-destructive-muted text-destructive-muted-foreground hover:bg-destructive-muted/80",
        /** A destructive action's trigger: red outline; the solid red belongs to its confirmation. */
        danger: "border-destructive/45 bg-transparent text-destructive hover:bg-destructive-muted",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 gap-1.5 px-3.5 md:h-9",
        xs: "h-11 gap-1 px-2.5 text-xs md:h-7 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-11 gap-1.5 px-3 text-[13px] md:h-8 md:min-h-8",
        lg: "h-12 gap-2 px-5 md:h-10",
        icon: "size-11 md:size-9",
        "icon-xs": "size-11 md:size-7 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-11 md:size-8 md:min-h-8 md:min-w-8",
        "icon-lg": "size-12 md:size-10",
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
