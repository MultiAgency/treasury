import type { ReactNode } from "react";
import type { ProcedureUtils } from "@orpc/tanstack-query";
import type { OwnerCallError } from "../shared/client";
import type { OwnerOutput } from "@multiagency/sdk";

type Agreement = OwnerOutput<"agreements/list">[number];

/**
 * What the shared Payables/Portfolio surface supplies to common modules. Neutral types only, so the
 * Treasury build can type-check against it without loading any Payables module.
 */
/** A page component: route components and embedded sections take no props here. */
type Page = (props: Record<string, never>) => ReactNode;

export type Legacy = {
  Overview: Page;
  PayeesSection: Page;
  PaymentTimeline: Page;
  PaymentRecovery: Page;
  SendFunds: Page;
  LiveDemo: Page;
  /** One agent's agreement requests on fleet pages. */
  fleetAgreements: (name: string) => ReturnType<ProcedureUtils<Record<never, never>, undefined, Agreement[], OwnerCallError>["queryOptions"]>;
} | null;
