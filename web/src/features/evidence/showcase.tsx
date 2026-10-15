import { ArrowRight, ChartPieSlice, HandCoins, Receipt } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { type Brief, type Kind, type Known, knownLabel, REQUIREMENTS_CONTEXT, PROTOTYPES, AREA_NAMES, type Requirement, STOPPER_LABEL, summarizeRequirements } from "./beats";
import { Card, Details } from "../../shared/ui";

/** How a requirement is known, as one mark: full when seen on mainnet, half when tested offline, empty when deployed behavior is unverified. */
export function KnownMark({ known, size = 14 }: { known: Known; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className={`shrink-0 ${known === "not-yet" ? "text-muted-foreground" : "text-brand-strong"}`}>
      {known === "mainnet" ? (
        <circle cx="8" cy="8" r="7" fill="currentColor" />
      ) : (
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      )}
      {known === "offline" && <path d="M8 1a7 7 0 0 0 0 14z" fill="currentColor" />}
    </svg>
  );
}

const KNOWN_LEGEND: [Known, string][] = [
  ["mainnet", "Observed on mainnet"],
  ["offline", "Tested offline"],
  ["provider-source", "Provider source; deployed behavior unverified"],
  ["not-yet", "Not yet"],
];

/** The key to every mark on the page: how each requirement is known. */
export function KnownLegend() {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground" aria-label="How each requirement is known">
      {KNOWN_LEGEND.map(([known, label]) => (
        <li key={known} className="flex items-center gap-2">
          <KnownMark known={known} /> {label}
        </li>
      ))}
    </ul>
  );
}

/** A row's second line: for a guarantee, who stops it and how that's known; for a capability, how it's known. */
const detail = (r: Requirement) =>
  r.type === "guarantee" && r.stoppedBy
    ? r.stoppedBy === "policy" || r.stoppedBy === "server"
      ? `Control: ${STOPPER_LABEL[r.stoppedBy].toLowerCase()}. ${knownLabel(r)}`
      : STOPPER_LABEL[r.stoppedBy]
    : knownLabel(r);

/** A brief's catalog number and title. */
function BriefTitle({ brief }: { brief: Brief }) {
  return (
    <span className="font-medium text-foreground">
      <span className="mr-2 text-muted-foreground tabular-nums">{brief.catalog}</span>
      {brief.title}
    </span>
  );
}

/** The running brief and its evidence; planned briefs stay in the planning docs. */
export function WhatThisShows({ kind, dao, openRunning = false }: { kind: Kind; dao?: string; openRunning?: boolean }) {
  const { tagline, briefs } = PROTOTYPES[kind];
  const name = AREA_NAMES[kind];
  const [brief] = briefs;
  return (
    <Card>
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">{name}: requirements and evidence</h2>
        <p className="text-sm text-muted-foreground">{tagline}</p>
      </div>
      <p className="text-sm text-muted-foreground">{REQUIREMENTS_CONTEXT}</p>
      <Details open={openRunning} summary={`${brief.catalog} ${brief.title}`}>
        <ul className="flex flex-col divide-y">
          {brief.requirements.map((r) => (
            <li key={r.text} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-foreground">
                  <span className="text-muted-foreground">{r.type === "guarantee" ? "Safety target: " : "Capability target: "}</span>
                  {r.text}
                </span>
                <span className="inline-flex max-w-full items-start gap-1.5 text-xs text-muted-foreground">
                  <KnownMark known={r.known} size={12} /> {detail(r)}
                </span>
              </div>
              <span className="text-muted-foreground">
                {r.evidence}
                {dao &&
                  r.proposals?.map((n) => (
                    <span key={n}>
                      {", "}
                      <a className="underline hover:text-foreground" href={`https://trezu.app/${dao}/requests/${n}`} target="_blank" rel="noreferrer">
                        proposal #{n}
                      </a>
                    </span>
                  ))}
              </span>
            </li>
          ))}
        </ul>
      </Details>
    </Card>
  );
}

const PROTOTYPE_ICON: Record<Kind, typeof HandCoins> = { facilitator: HandCoins, treasury: ChartPieSlice };

/** A list of requirements of one kind, each with its mark and detail. */
function RequirementList({ heading, requirements }: { heading: string; requirements: Requirement[] }) {
  if (requirements.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-medium text-muted-foreground">{heading}</h4>
      <ul className="flex flex-col gap-3">
        {requirements.map((r) => (
          <li key={r.text} className="grid grid-cols-[14px_1fr] gap-x-3">
            <span className="flex h-6 items-center">
              <KnownMark known={r.known} />
            </span>
            <span className="flex flex-col">
              <span className={r.known === "not-yet" ? "text-muted-foreground" : ""}>{r.text}</span>
              <span className="text-sm text-muted-foreground">{detail(r)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A brief's requirements: its capabilities (what the agent does), then its guarantees (what it can't do). */
function Requirements({ requirements }: { requirements: Requirement[] }) {
  return (
    <div className="flex flex-col gap-4">
      <RequirementList heading="Capability targets" requirements={requirements.filter((r) => r.type === "capability")} />
      <RequirementList heading="Safety targets" requirements={requirements.filter((r) => r.type === "guarantee")} />
    </div>
  );
}

/** Public-safe coverage and limitations from the running brief, also visible on compact cards. */
function ProgressSummary({ brief, name }: { brief: Brief; name: string }) {
  const summary = summarizeRequirements(brief.requirements);
  const categories = [
    ["Observed on mainnet", summary.agent + summary.other],
    ["Offline only", summary.offline],
    ["Not yet demonstrated", summary.unverified],
    ["Not supported", summary.unsupported],
  ] as const;
  return (
    <div role="group" aria-label={`Evidence coverage for ${name}`} className="flex flex-col gap-3 border-t pt-4">
      <h3 className="text-sm font-medium">What has been demonstrated <span className="font-normal text-muted-foreground">· {summary.total} requirements</span></h3>
      <p className="text-sm text-muted-foreground">Counts describe recorded observations across our agents, not live checks or proof of every guarantee.</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        {categories.map(([label, count]) => (
          <div key={label} className="flex min-w-0 flex-col gap-1">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className={`text-lg tabular-nums ${count === 0 ? "text-muted-foreground" : "font-medium"}`}>{count}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-col gap-1 text-sm">
        <h4 className="font-medium">Known limitations</h4>
        {brief.limitations?.length ? (
          <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
            {brief.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
          </ul>
        ) : <p className="text-muted-foreground">Limitations have not yet been catalogued.</p>}
      </div>
    </div>
  );
}

/** Static illustrations explain the two workflows without reading agent records. */
export function PublicWorkflows({ invoices }: { invoices: string | null }) {
  const workflows = [
    { kind: "facilitator" as const, title: "Payables", description: "The agent processes invoices. You approve every payout.", steps: [
      ["The payee submits an invoice", "New payees first request an agreement with the owner."],
      ["The payout is held", "The owner reviews the invoice and its agreed terms."],
      ["Approval lets payment proceed", "The payout agent makes the confidential transfer."],
    ] },
    { kind: "treasury" as const, title: "Portfolio", description: "The agent rebalances funds. You set the targets and limits.", steps: [
      ["The owner sets a strategy", "Target allocations and limits define the rebalance."],
      ["The agent prepares a plan", "Each proposed swap is quoted before execution."],
      ["Authorization precedes execution", "Scheduled execution requires a live grant and must fit the strategy’s auto-execute limit."],
    ] },
  ];
  return (
    <section id="workflows" aria-labelledby="workflows-heading" className="scroll-mt-8">
      <div className="mb-8 flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="workflows-heading" className="text-3xl font-semibold tracking-tight">Two agents. Two workflows.</h2>
        <p className="text-sm text-muted-foreground">Illustrative workflows</p>
      </div>
      <div className="grid overflow-hidden rounded-2xl border bg-card lg:grid-cols-2">
        {workflows.map(({ kind, title, description, steps }) => {
          const Icon = PROTOTYPE_ICON[kind];
          return (
            <article key={kind} aria-label={`${title} workflow`} className="flex flex-col gap-6 p-5 first:border-b sm:p-8 lg:p-10 lg:first:border-r lg:first:border-b-0">
              <div className="flex flex-col gap-3">
                <h3 className="flex items-center gap-3 text-3xl font-semibold tracking-tight"><Icon size={28} className="shrink-0 text-brand-strong" aria-hidden="true" />{title}</h3>
                <p className="min-h-18 leading-relaxed text-muted-foreground">{description}</p>
              </div>
              <ol className="flex flex-col gap-4">{steps.map(([step, detail], i) => <li key={step} className="grid grid-cols-[2rem_1fr] gap-3">
                <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-brand-muted text-sm font-semibold text-brand-strong">{i + 1}</span>
                <div><p className="font-medium">{step}</p><p className="mt-1 text-sm text-muted-foreground">{detail}</p></div>
              </li>)}</ol>
              <a href={`#${kind}-requirements`} className="inline-flex min-h-11 items-center justify-center self-start rounded-full border border-border-strong px-4 py-2 text-sm font-medium hover:bg-accent">{title} requirement stages</a>
              <div className="mt-auto flex flex-wrap gap-3 pt-2">
                {kind === "facilitator" && invoices && <a href={invoices} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-5 py-2 font-medium text-primary-foreground hover:bg-primary/90"><Receipt size={18} aria-hidden="true" />Request a payment (opens invoice service)</a>}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/** Public cards disclose requirement stages without private evidence; member cards lead into the area. */
export function PrototypeCard({ kind, open, invoices, status, compact = false, stagesOnly = false }: { kind: Kind; open?: string; invoices?: string | null; status?: ReactNode; compact?: boolean; stagesOnly?: boolean }) {
  const { tagline, briefs, demo } = PROTOTYPES[kind];
  const name = AREA_NAMES[kind];
  const Icon = PROTOTYPE_ICON[kind];
  const [running] = briefs;
  return (
    <Card>
      <div className="flex flex-col gap-3">
        <h2 id={stagesOnly ? `${kind}-requirements` : undefined} className="flex scroll-mt-8 items-center gap-3 font-heading text-2xl font-semibold tracking-tight">
          <Icon size={26} className="shrink-0 text-brand-strong" aria-hidden="true" /> {name}
        </h2>
        {status}
        {!stagesOnly && <p className="max-w-prose text-muted-foreground">{tagline}</p>}
      </div>
      {(open || (kind === "facilitator" && invoices)) && <div className="flex flex-wrap gap-3">
        {open && (
          <a className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 font-medium text-primary-foreground hover:bg-primary/90" href={open}>
            Open {name} <ArrowRight size={16} />
          </a>
        )}
        {kind === "facilitator" && invoices && (
          <a className="inline-flex h-11 items-center gap-2 rounded-full border px-5 font-medium hover:bg-muted" href={invoices}>
            <Receipt size={16} /> Request a payment
          </a>
        )}
      </div>}
      <ProgressSummary brief={running} name={name} />
      {!compact && (
        <>
          <Details summary="View requirements">
            <p className="text-sm text-muted-foreground">{REQUIREMENTS_CONTEXT}</p>
            <KnownLegend />
            <h3><BriefTitle brief={running} /></h3>
            <Requirements requirements={running.requirements} />
          </Details>
          <Details summary={stagesOnly ? "Dashboard walkthrough" : "How it works"}>
            <ol className="flex list-decimal flex-col gap-1 pl-5">
              {demo.map((step) => (
                <li key={step.text}>
                  <span className="text-muted-foreground">{step.on === "invoices" ? "Invoice page" : "Dashboard"}: </span>
                  {step.text}
                </li>
              ))}
            </ol>
          </Details>
        </>
      )}
    </Card>
  );
}
