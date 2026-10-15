import { useId, type InputHTMLAttributes } from "react";
import { Field as FieldPrimitive, FieldLabel, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export { FieldGroup } from "@/components/ui/field";

/** A persistent label and a field-local error, linked for keyboard and screen-reader use. */
export function Field({ label, error, className, id: suppliedId, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string }) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const invalid = Boolean(error) || props["aria-invalid"];
  const invalidState = Boolean(invalid && invalid !== "false");
  const description = [props["aria-describedby"], error ? `${id}-error` : undefined].filter(Boolean).join(" ") || undefined;
  return <FieldPrimitive className={cn("min-w-0", className)} data-invalid={invalidState} data-disabled={props.disabled}>
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
    <Input {...props} id={id} aria-invalid={invalid} aria-describedby={description} />
    {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
  </FieldPrimitive>;
}

/** React commits field errors before focus is moved; don't steal focus while someone is typing. */
export function focusInvalid(form: HTMLFormElement) {
  requestAnimationFrame(() => form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
}
