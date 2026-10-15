import { AgentApiResources } from "./agent-api-resources";
import { TreasuryBrand } from "../app/treasury-brand";
import { PrototypeCard } from "../features/evidence/showcase";
import { SignIn } from "../app/session";
import { Details } from "../shared/ui";

/** Public brief only. No balances, private evidence or operation requests. */
export function TreasuryHome({ daos, selfService = false }: { daos: string[]; selfService?: boolean }) {
  return <main id="treasury-main" className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-8 bg-background px-4 py-6 sm:px-8 sm:py-8">
    <header className="flex items-center justify-between gap-2 border-b pb-5"><TreasuryBrand /><SignIn daos={daos} compact create={selfService} /></header>
    <div className="flex flex-col gap-4 border-l-2 border-primary py-4 pl-5">
      <h1 className="font-heading text-4xl font-semibold tracking-tight sm:text-5xl">Your treasury.<br />Your limits.</h1>
      <p className="max-w-xl text-lg leading-relaxed text-muted-foreground">Delegate treasury rebalancing to an agent. You choose the assets, allocations, budget, and schedule.</p>
    </div>
    <ul className="flex flex-col gap-3 text-sm leading-relaxed">
      <li><strong className="font-semibold">Set policy.</strong> Approve allowed assets, per-asset monthly caps, and a shared USD budget.</li>
      <li><strong className="font-semibold">Rebalance.</strong> Quote swaps before execution and track remaining budget.</li>
      <li><strong className="font-semibold">Keep balances confidential.</strong> Sweep supported idle funds and review recorded activity.</li>
    </ul>
    <section aria-label="Get started" className="flex flex-col items-start gap-4">
      <p className="text-sm text-muted-foreground">{selfService ? "Connect your NEAR wallet to create or open a treasury for yourself or an existing DAO." : "Connect your NEAR wallet to open your treasury."}</p>
    </section>
    <Details summary="Prototype progress">
      <PrototypeCard kind="treasury" stagesOnly compact />
    </Details>
    <AgentApiResources />
  </main>;
}
