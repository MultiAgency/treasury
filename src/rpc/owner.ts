import { z } from "zod";
import { GRANT_LABELS } from "../grants.js";
import { daoRequests, ownerActions, prepare, status, submit } from "../owner-intents.js";
import { os } from "./base.js";
import { transferAccount, usdAmount, caps, reviewedPolicy } from "./inputs.js";

const ownerAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent_create"),
    owner: z.object({ type: z.literal("near"), account_id: z.string(), public_key: z.string() }).optional(),
    role: z.enum(["treasury", "payout"]).optional(),
    payees: z.array(transferAccount).max(256).optional(),
  }),
  z.object({
    type: z.literal("grant_issue"),
    label: z.enum(GRANT_LABELS).optional(),
    suffix: z.string().min(1).max(64).optional(),
    expectedStrategyDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  }),
  z.object({ type: z.literal("grant_revoke"), grantId: z.string().min(1) }),
  z.object({ type: z.literal("agent_freeze") }),
  z.object({ type: z.literal("agent_unfreeze") }),
  z.object({
    type: z.literal("policy_update"),
    expectedPolicy: reviewedPolicy,
    changes: z.object({
      swap: z.boolean().optional(),
      destinations: z.array(z.object({ address: transferAccount, confidential: z.boolean() })).max(64).optional(),
      assets: z.union([z.literal("any"), z.array(z.string())]).optional(),
      owner_approval: z.boolean().optional(),
      max_actions_per_hour: z.number().int().positive().nullable().optional(),
      budget: z.object({ daily_usd: usdAmount, weekly_usd: usdAmount, monthly_usd: usdAmount }).optional(),
      limits: z
        .object({ per_transaction: caps, hourly: caps, daily: caps, monthly: caps })
        .partial()
        .optional(),
    }),
  }),
  z.object({
    type: z.literal("approval_vote"),
    approvalId: z.uuid(),
    verdict: z.enum(["approve", "reject"]),
    correlationId: z.string(),
  }),
]);

export const ownerRoutes = {
  owner: {
    prepare: os
      .input(z.object({ action: ownerAction, signer: z.enum(["wallet", "dao"]) }))
      .handler(({ input }) => prepare(input.action, input.signer)),
    status: os.input(z.object({ correlationId: z.string() })).handler(({ input }) => status(input.correlationId)),
    /** What this server waits for the DAO to sign, for members to check each proposal before voting. */
    pending: os.handler(() => daoRequests()),
    actions: os.handler(() => ownerActions()),
    submit: os
      .input(z.object({ correlationId: z.string(), signedData: z.record(z.string(), z.unknown()) }))
      .handler(({ input }) => submit(input.correlationId, input.signedData)),
  },
};
