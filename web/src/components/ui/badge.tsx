import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const badgeVariants = cva(
  "group/badge inline-flex min-h-[22px] w-fit shrink-0 items-center justify-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&>svg]:pointer-events-none [&>svg]:shrink-0 [&>svg]:size-3",
  {
    variants: {
      /* A status is its colour at 14% behind and in full in front, with a dot of it; neutral stays grey. */
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        neutral: "bg-secondary text-muted-foreground",
        success: "bg-success-muted text-success-muted-foreground before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:content-['']",
        warning: "bg-warning-muted text-warning-muted-foreground before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:content-['']",
        info: "bg-info-muted text-info-muted-foreground before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:content-['']",
        brand: "bg-brand-muted text-brand before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:content-['']",
        destructive:
          "bg-destructive-muted text-destructive-muted-foreground before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:content-['']",
        outline:
          "border border-border-strong text-foreground [a]:hover:bg-muted",
        ghost:
          "hover:bg-muted hover:text-muted-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
