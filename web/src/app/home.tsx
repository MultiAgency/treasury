import { ArrowsClockwise, Scales, ShieldCheck } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { AnimatedShinyText } from "@/components/magicui/animated-shiny-text";
import { BlurFade } from "@/components/magicui/blur-fade";
import { MagicCard } from "@/components/magicui/magic-card";
import { TreasuryBrand } from "./brand";
import { Backdrop, ThemeToggle, TopBar } from "./chrome";
import { SignIn } from "./session";

function Feature({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <MagicCard className="h-full">
    <div className="flex h-full flex-col gap-3 p-5">
      <span className="grid size-9 place-items-center rounded-lg border border-[color-mix(in_oklab,var(--accent)_25%,var(--border))] bg-brand-muted text-brand-strong">{icon}</span>
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
    </div>
  </MagicCard>;
}

/** Signed out: what this is and how to sign in. No balances, records or operation requests. */
export function SignedOutHome({ selfService = false }: { selfService?: boolean }) {
  return <>
    <Backdrop />
    <TopBar><TreasuryBrand /><div className="flex items-start gap-1"><ThemeToggle /><SignIn /></div></TopBar>
    <main id="treasury-main" className="mx-auto flex min-h-[calc(100dvh-4.5rem)] max-w-5xl flex-col gap-16 px-4 py-14 sm:px-8 sm:py-20">
      <BlurFade className="flex flex-col items-center gap-6 text-center">
        <span className="inline-flex items-center gap-2 rounded-full border bg-surface/80 px-3.5 py-1.5 text-xs font-medium shadow-resting backdrop-blur">
          <span className="size-1.5 rounded-full bg-brand" aria-hidden="true" />
          <AnimatedShinyText shimmerWidth={80}>An owner-signed treasury agent on NEAR</AnimatedShinyText>
        </span>
        <h1 className="max-w-3xl font-heading text-5xl leading-[1.05] font-semibold text-balance sm:text-7xl" style={{ letterSpacing: "var(--tracking-display)" }}>
          Your treasury.<br />
          <span className="bg-(image:--arc-gradient-ink) bg-clip-text text-transparent">Your limits.</span>
        </h1>
        <p className="max-w-xl text-lg leading-relaxed text-pretty text-muted-foreground">Set allocation targets, sign spending limits and authorize scheduled rebalancing.</p>
      </BlurFade>
      <BlurFade delay={0.08}>
        <section aria-label="Get started" className="mx-auto flex max-w-xl flex-col items-center gap-4 text-center">
          <p className="text-sm leading-relaxed text-muted-foreground">{selfService ? "Connect your NEAR wallet to create or open a Treasury for yourself or an existing DAO." : "Connect your NEAR wallet to open your Treasury. Creation is available only on hosts with registration enabled."}</p>
          <SignIn primary />
          <div className="flex flex-col gap-1 text-sm leading-relaxed text-subtle-foreground">
            <p>Sign-in signs a message. It moves no funds.</p>
            {selfService && <p>Registration signs nothing. Scheduling starts off.</p>}
          </div>
        </section>
      </BlurFade>
      <BlurFade delay={0.16} className="grid gap-4 sm:grid-cols-3">
        <Feature icon={<Scales size={18} aria-hidden="true" />} title="Allocation targets">Say where the book should sit. Previews show the quoted trades before anything is sent.</Feature>
        <Feature icon={<ShieldCheck size={18} aria-hidden="true" />} title="Signed limits">Per-asset caps and USD budgets you sign. Every operation is checked against them again before submission.</Feature>
        <Feature icon={<ArrowsClockwise size={18} aria-hidden="true" />} title="Scheduled rebalancing">Turn the schedule on when you're ready, and off at any time.</Feature>
      </BlurFade>
    </main>
  </>;
}
