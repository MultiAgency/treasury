import { TaskEvidence } from "../evidence/task-evidence";
import { Sweep } from "./sweep";
import { PayablesSchedule } from "../portfolio/automations";
import { useLocation } from "@tanstack/react-router";
import { useAgent } from "../../app/agent-context";
import { Balances } from "./balances";
import { kindOf } from "../../shared/lib";
import { TreasurySection } from "./treasury";
import { legacy } from "@legacy";
import { Details } from "../../shared/ui";

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
    {legacy && <legacy.SendFunds />}
  </>;
}
