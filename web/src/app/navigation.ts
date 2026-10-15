import { TASK_LABELS } from "../shared/task-labels";
import { Bank, ClockCounterClockwise, Lightning, PlayCircle, ShieldCheck, SquaresFour, UsersThree, type Icon } from "@phosphor-icons/react";
import type { Kind } from "../features/evidence/beats";

/** Task names share the existing URLs so saved links and recovery records keep working. */
export const AREA_NAV: Record<Kind, { to: "/" | "/payees" | "/funding" | "/policy" | "/activity" | "/automations" | "/follow/run" | "/demo"; label: string; icon: Icon; utility?: boolean }[]> = {
  facilitator: [
    { to: "/", label: TASK_LABELS.payments, icon: SquaresFour },
    { to: "/payees", label: TASK_LABELS.agreements, icon: UsersThree },
    { to: "/funding", label: TASK_LABELS.funding, icon: Bank, utility: true },
    { to: "/policy", label: TASK_LABELS.policy, icon: ShieldCheck, utility: true },
    { to: "/demo", label: "Guided walkthrough", icon: PlayCircle, utility: true },
    { to: "/activity", label: "Operation status", icon: ClockCounterClockwise },
  ],
  treasury: [
    { to: "/", label: TASK_LABELS.overview, icon: SquaresFour },
    { to: "/automations", label: TASK_LABELS.strategy, icon: Lightning },
    { to: "/follow/run", label: TASK_LABELS.runs, icon: ClockCounterClockwise },
    { to: "/funding", label: TASK_LABELS.funding, icon: Bank, utility: true },
    { to: "/policy", label: TASK_LABELS.policy, icon: ShieldCheck, utility: true },
    { to: "/demo", label: "Guided walkthrough", icon: PlayCircle, utility: true },
    { to: "/activity", label: "Operation status", icon: ClockCounterClockwise },
  ],
};

export function areaPageTitle(kind: Kind, pathname: string) {
  const path = pathname.replace(/\/$/, "");
  if (path.endsWith("/follow/payment")) return "Payment";
  if (path.endsWith("/steward")) return "Steward";
  if (kind === "facilitator" && path.endsWith("/automations")) return "Shield public funds";
  return AREA_NAV[kind].find(item => item.to !== "/" && path.endsWith(item.to))?.label ?? AREA_NAV[kind][0]!.label;
}
