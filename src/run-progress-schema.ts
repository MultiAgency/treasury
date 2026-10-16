import { z } from "zod";

export const STAGE_LABEL = {
  "balances-before": "Checking balances",
  recovery: "Checking unresolved operations",
  sweep: "Checking and shielding public balances",
  planning: "Planning and quoting swaps",
  execution: "Checking and executing the plan",
  "balances-after": "Checking balances after the run",
} as const;
export const StepNameSchema = z.enum(Object.keys(STAGE_LABEL) as [keyof typeof STAGE_LABEL, ...(keyof typeof STAGE_LABEL)[]]);
export const SubmissionSchema = z.strictObject({ stage: z.literal("submission"), method: z.enum(["swap", "shield", "transfer", "unshield", "withdraw"]), correlationId: z.string().min(1).max(200) });
export const ProgressEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("STEP_STARTED"), stepName: StepNameSchema }),
  z.strictObject({ type: z.literal("STEP_FINISHED"), stepName: StepNameSchema }),
  z.strictObject({ type: z.literal("CUSTOM"), name: z.literal("treasury.observation"), value: SubmissionSchema }),
]);
export const ProgressRecordSchema = z.strictObject({
  version: z.literal(1), agentId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/), tickId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  sequence: z.number().int().positive().max(2000), at: z.iso.datetime({ offset: true }), event: ProgressEventSchema,
});
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;
export type ProgressRecord = z.infer<typeof ProgressRecordSchema>;
