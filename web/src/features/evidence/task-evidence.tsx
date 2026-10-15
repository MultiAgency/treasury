import { Details } from "../../shared/ui";

const evidence = {
  agreements: {
    summary: "Recorded terms and applied policy answer different questions.",
    detail: "Agreement terms are this server’s record for the voter to review. A payee is agreed only when the applied policy lists the confidential transfer destination. These terms do not automatically refuse an invoice outside its ceiling or deadline.",
  },
  strategy: {
    summary: "Saved strategy, owner authorization and schedule state are observed separately.",
    detail: "The matching grant binds the saved strategy digest. Turning on the schedule does not establish that a run happened or that an operation settled. Runs retains recorded observations; Activity shows operation outcomes.",
  },
  funding: {
    summary: "Reported balances do not establish the amount available for a new payment.",
    detail: "Held payouts, unresolved operations, policy and grant checks can restrict new sends. Deposit instructions identify where to fund; they do not prove that a credit arrived. Review the refreshed balances and operation records separately.",
  },
  policy: {
    summary: "This view presents the policy and grant observations returned by the provider.",
    detail: "The mandate digest identifies the policy recorded with this server’s plans and operations. It is not independent proof of the policy enforced inside custody. Provider-source claims, mainnet observations and remaining limits are distinguished in the area’s evidence summary.",
  },
} as const;
export function TaskEvidence({ task }: { task: keyof typeof evidence }) {
  const { summary, detail } = evidence[task];
  return <aside aria-label="Evidence and limitations" className="flex flex-col gap-2 border-l-2 border-brand pl-4 text-sm">
    <p>{summary}</p>
    <Details summary="Evidence and limitations"><p className="max-w-prose text-muted-foreground">{detail}</p></Details>
  </aside>;
}
