import { TaskEvidence } from "../evidence/task-evidence";
import { TREASURY_ONLY } from "../../treasury-surface";
import { Sweep } from "./sweep";
import { PayablesSchedule } from "../portfolio/automations";
import { Link, useLocation } from "@tanstack/react-router";
import { useAgent } from "../../app/agent-context";
import { Balances } from "./balances";
import { kindOf } from "../../shared/lib";
import { TreasuryPayees } from "../payables/payees";
import { ReturnFunds, TreasurySection } from "./treasury";
import { Details, Section } from "../../shared/ui";

export function Funding() {
  const { data } = useAgent();
  const hash = useLocation({ select: location => location.hash });
  return <>
    <TaskEvidence task="funding" />
    <Balances />
    <TreasurySection />
    <section id="sweep" className="scroll-mt-24 flex flex-col gap-4" aria-label="Shield public funds">
      {kindOf(data) === "facilitator" && <PayablesSchedule />}
      <Details summary="Shield public funds" open={hash === "sweep"}><Sweep /></Details>
    </section>
    {!TREASURY_ONLY && <Section title="Send funds" description="Outgoing payments use this agent’s policy and grant. Reported balances do not establish how much can be sent.">
      <ReturnFunds />
      {kindOf(data) === "treasury" ? <TreasuryPayees /> : <div className="flex flex-wrap gap-4 text-sm">
        <Link to="/" className="underline">Review held payouts</Link>
        <Link to="/payees" className="underline">Review agreements and payees</Link>
      </div>}
    </Section>}
  </>;
}
