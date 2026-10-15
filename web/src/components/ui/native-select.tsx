import type { ComponentProps } from "react";
import { inputStyles } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Native browser selection with the same target, border and focus as text inputs. */
function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return <select data-slot="native-select" className={cn(inputStyles, "w-full max-w-full pr-8", className)} {...props} />;
}

function NativeSelectOption(props: ComponentProps<"option">) {
  return <option data-slot="native-select-option" {...props} />;
}

function NativeSelectOptGroup(props: ComponentProps<"optgroup">) {
  return <optgroup data-slot="native-select-optgroup" {...props} />;
}

export { NativeSelect, NativeSelectOption, NativeSelectOptGroup };
