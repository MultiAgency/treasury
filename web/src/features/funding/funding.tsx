import { useLocation } from "@tanstack/react-router";
import { PAGES } from "../../app/pages";
import { Details } from "../../shared/ui";
import { Balances } from "./balances";
import { Sweep } from "./sweep";
import { TreasurySection } from "./treasury";

export function Funding() {
  const hash = useLocation({ select: location => location.hash });
  return <>
    <h1 className="page-title">{PAGES["/funding"]}</h1>
    <Balances />
    <TreasurySection />
    <section id="sweep" className="scroll-mt-24 flex flex-col gap-4" aria-label="Shield public funds">
      <Details summary="Shield public funds" open={hash === "sweep"}><Sweep /></Details>
    </section>
  </>;
}
