import { useBlocker } from "@tanstack/react-router";

/** Keep private drafts in memory; warn before router navigation and full-page unloads. */
export function useDirtyDraft(dirty: boolean) {
  useBlocker({
    shouldBlockFn: () => dirty && !confirmDiscard(),
    enableBeforeUnload: dirty,
  });
}

export const confirmDiscard = () => window.confirm("Discard your unsaved changes?");
