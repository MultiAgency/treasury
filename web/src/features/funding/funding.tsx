import { Coins, Eye, HandCoins, ShieldCheck } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { useAgent, useAgentReads } from "../../app/frame";
import { PAGES } from "../../app/pages";
import { Kpis, PageHeader, ShareBar } from "../../dashboard/page";
import { bookValue, units, usd } from "../../shared/format";
import { Details } from "../../shared/ui";
import { Balances } from "./balances";
import { Sweep } from "./sweep";
import { TreasurySection } from "./treasury";

export function Funding() {
  const hash = useLocation({ select: location => location.hash });
  const { data } = useAgent();
  const held = useQuery(useAgentReads().held);
  const total = bookValue(data);
  // Valued at the book's prices; with any price missing, the split isn't shown in dollars.
  const worth = (side: "public" | "confidential") => total === null ? null : data.book.reduce((sum, h) => sum + units(h[side], h.decimals) * (h.price ?? 0), 0);
  const open = worth("public"), shielded = worth("confidential");
  return <>
    <PageHeader title={PAGES["/funding"]} description="What the agent holds, where funds come from, and shielding public balances." />
    <Kpis items={[
      { label: "In public view", value: usd(open), hint: open !== null && total ? `${Math.round((open / total) * 100)}% of the book` : "at API prices", icon: <Eye size={16} />, tone: "tone-warning",
        chip: open !== null && <span className={`dash-chip ${open > 0.005 ? "tone-warning" : "tone-success"}`}>{open > 0.005 ? "To shield" : "None"}</span> },
      { label: "Shielded", value: usd(shielded), icon: <ShieldCheck size={16} />, tone: "tone-eth",
        hint: shielded !== null && total ? <ShareBar parts={[{ key: "c", share: shielded / total, color: "var(--dash-brand)" }]} /> : "at API prices" },
      { label: "Managed assets", value: data.book.length, hint: data.unmanaged.length ? `${data.unmanaged.length} other held` : "no other assets held", icon: <Coins size={16} />, tone: "tone-usdc" },
      { label: "Held payouts", value: held.data ? held.data.length : "—", hint: "awaiting the owner's decision", icon: <HandCoins size={16} />, tone: "tone-other" },
    ]} />
    <div className="dash-span-7 dash-stretch [&>section]:h-full"><Balances /></div>
    <div className="dash-span-5 flex flex-col gap-3"><TreasurySection /></div>
    <section id="sweep" className="dash-card scroll-mt-24 flex flex-col gap-4" aria-label="Shield public funds">
      <Details summary="Shield public funds" open={hash === "sweep"}><Sweep /></Details>
    </section>
  </>;
}
