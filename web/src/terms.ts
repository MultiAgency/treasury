import type { ProposalView } from "@multiagency/sdk";
// With its extension: test/proposal-terms.test.ts loads this module under Node, which resolves only explicit `.ts` paths.
import { exactAmountOf } from "./shared/format.ts";

type Leg = ProposalView["legs"][number];

/** A swap as the owner signs it: the amount spent and the floor, exactly, as the proposal's text names them. */
export const legText = (leg: Leg) => `Swap ${exactAmountOf(leg.amount, leg.from, [])} for at least ${exactAmountOf(leg.minAmountOut, leg.to, [])}`;
