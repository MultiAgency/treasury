import * as React from "react"
import { cn } from "cn"

/** Shared with native controls until their existing forms adopt Input. */
const inputStyles =
  "h-11 min-w-0 rounded-4xl border border-input bg-input-surface px-4 text-sm text-foreground transition-[border-color,box-shadow] duration-150 ease-arc placeholder:text-subtle-foreground hover:border-foreground/60 focus-visible:border-foreground focus-visible:outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive"

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
