/** Presentation identity only. Policy, grants and role checks still govern every action. */
export type Area = "payables" | "treasury";

/** Absent on legacy/local instances until explicitly configured. Never infer authorization here. */
export function configuredArea(value: string | undefined): Area | undefined {
  if (!value) return undefined;
  if (value === "payables" || value === "treasury") return value;
  throw new Error("DASHBOARD_AREA must be payables or treasury");
}
