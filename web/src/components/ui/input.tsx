import * as React from "react"
import { cn } from "cn"

/** Shared with native controls until their existing forms adopt Input. */
const inputStyles =
  "h-11 min-w-0 rounded-lg border border-input bg-input-surface px-3 text-sm text-foreground transition-colors placeholder:text-muted-foreground md:h-9 focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        inputStyles,
        "w-full file:inline-flex file:h-9 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Input, inputStyles }
