import { LockSimple } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { PublicWorkflows, PrototypeCard } from "./features/evidence/showcase";
import { SignIn } from "./app/session";

/**
 * The page for anyone not signed in: the two areas, each agent's capabilities and guarantees and how each is known,
 * and sign-in. It reads nothing from the server: no balances, payments or agents, and no roster or
 * proposals either; members see proposals after signing in.
 */
export function PublicHome({ daos, invoices }: { daos: string[]; invoices: string | null }) {
  return (
    <>
    <a href="#public-main" className="sr-only fixed top-2 left-2 z-50 rounded-lg bg-card p-3 text-foreground focus:not-sr-only">Skip to main content</a>
    <main id="public-main" tabIndex={-1} className="mx-auto flex max-w-6xl flex-col gap-16 px-4 py-6 sm:px-8 sm:py-10 lg:gap-20">
      <nav aria-label="Landing page" className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-sm">
        <span className="font-heading text-lg font-semibold">Agentic Treasury</span>
        <SignIn daos={daos} compact />
      </nav>
      <header className="grid items-end gap-8 lg:grid-cols-[1.5fr_1fr] lg:gap-16">
        <div className="flex flex-col items-start gap-7">
        <h1 className="max-w-[16ch] font-heading text-5xl leading-[1.06] font-semibold tracking-tight text-balance sm:text-6xl lg:text-7xl">
          Delegate treasury work. Set the policy.
        </h1>
        <p className="max-w-[48ch] text-lg leading-relaxed text-muted-foreground">
          Two agents for DAO and wallet owners on NEAR Intents: confidential payouts held for owner approval, and treasury rebalancing toward an owner-defined strategy.
        </p>
        <Button asChild size="lg"><a href="#workflows">See how it works</a></Button>
        </div>
        <aside aria-label="Owner control" className="flex flex-col gap-4 border-l pl-6 lg:mb-1">
          <LockSimple size={28} className="text-brand-strong" aria-hidden="true" />
          <h2 className="text-2xl font-semibold tracking-tight">The owner signs the policy.</h2>
          <p className="leading-relaxed text-muted-foreground">The policy defines allowed actions, assets, caps, budget and destinations. Each area below shows what has been demonstrated and what remains unverified.</p>
          <a href="#requirement-stages" className="inline-flex min-h-11 items-center self-start text-sm font-medium underline underline-offset-4 hover:text-brand-strong">See requirement stages and limitations</a>
        </aside>
      </header>

      <PublicWorkflows invoices={invoices} />

      {/* Requirements and their phases, never the evidence. */}
      <section id="requirement-stages" aria-labelledby="stages-heading" className="flex scroll-mt-8 flex-col gap-6">
        <div className="flex max-w-prose flex-col gap-3">
          <h2 id="stages-heading" className="text-3xl font-semibold tracking-tight">What has been demonstrated</h2>
          <p className="text-muted-foreground">Recorded observations, offline tests and open questions, requirement by requirement. Known limitations stay visible.</p>
        </div>
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <PrototypeCard kind="facilitator" stagesOnly />
          <PrototypeCard kind="treasury" stagesOnly />
        </div>
      </section>

      <section id="member-sign-in" aria-label="Member access" className="grid scroll-mt-8 gap-6 border-t pt-8 lg:grid-cols-2 lg:gap-12">
        <div className="flex flex-col gap-3">
          <h2 className="text-2xl font-semibold tracking-tight">Your agents, behind sign-in.</h2>
          <p className="max-w-prose break-words leading-relaxed text-muted-foreground">Members can view balances, payment details and recorded activity. This public page shows the workflows and requirement stages{daos.length > 0 && ` for the agents owned by ${daos.join(" and ")}`}.</p>
        </div>
        <SignIn daos={daos} />
      </section>
    </main>
    </>
  );
}
