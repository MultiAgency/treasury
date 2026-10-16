import { ArrowSquareOut, BookOpen, Code, Cube, Gauge, Plugs, Sparkle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { PROTOTYPES, knownLabel, TREASURY_WITHDRAWAL_OBSERVATION } from "../features/evidence/beats";

const brief = PROTOTYPES.treasury.briefs[0];
const proofFlows = [
  {
    title: "Delegate and rebalance",
    steps: ["Review the policy's spendable assets, monthly spending caps and USD budget.", "Save target allocations and authorize the strategy.", "Inspect the quoted plan, then execute it or enable its schedule.", "Follow each operation to its recorded outcome."],
    requirements: ["Rebalances toward allocation targets on a schedule", "Quotes swaps before sending"],
  },
  {
    title: "Review spending and recorded refusals",
    steps: ["Read the signed limits and available budget headroom.", "Compare the retained before and after observations for a run.", "Inspect recorded refusals alongside any operations that completed earlier in the run."],
    requirements: ["Over-limit requests were refused", "Shows remaining budget", "Over-budget requests were refused", "One simultaneous-request test stayed within budget"],
  },
  {
    title: "Shield public balances",
    steps: ["Review managed public and confidential balances.", "Preview the sweep and explicitly confirm shielding.", "Inspect the resulting balances and retained operation history."],
    requirements: ["Shields public USDC, wNEAR and ETH balances", "Managed balances were confidential when checked"],
  },
];

/** Public workflow descriptions and canonical stages only; never private evidence. */
export function TreasuryProofFlows() {
  return <section aria-labelledby="treasury-proof-flows" className="flex flex-col gap-4">
    <h2 id="treasury-proof-flows" className="font-heading text-2xl font-semibold tracking-tight">Agentic Treasury Management</h2>
    <p className="text-sm leading-relaxed text-muted-foreground">Rebalance, review spending and shield public balances with NEAR Intents Agent API. Connect your wallet to open your Treasury.</p>
    <div className="divide-y">
      {proofFlows.map(flow => <article key={flow.title} className="flex flex-col gap-4 py-6 first:pt-2">
        <h3 className="text-lg font-semibold">{flow.title}</h3>
        <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed">
          {flow.steps.map(step => <li key={step}>{step}</li>)}
        </ol>
        <dl className="flex flex-col gap-3 text-sm">
          {brief.requirements.filter(requirement => flow.requirements.includes(requirement.text)).map(requirement => <div key={requirement.text} className="flex flex-col gap-1">
            <dt>{requirement.text}</dt>
            <dd className="text-muted-foreground">{knownLabel(requirement)}</dd>
          </div>)}
        </dl>
      </article>)}
    </div>
    <p className="text-sm leading-relaxed text-muted-foreground">{TREASURY_WITHDRAWAL_OBSERVATION.publicClaim} <span className="whitespace-nowrap">{TREASURY_WITHDRAWAL_OBSERVATION.when}</span></p>
  </section>;
}

const resources = [
  { label: "Documentation", href: "https://docs-production-7968.up.railway.app/integration/agent-api/overview", icon: BookOpen },
  { label: "Partner dashboard", href: "https://partners.demo.agentsonintents.com/dashboard", icon: Gauge },
  { label: "OpenAPI spec", href: "https://api.demo.agentsonintents.com/openapi.json", icon: Plugs },
  { label: "Examples", href: "https://github.com/NEAR-Intents-Agent-API/examples", icon: Code },
  { label: "Agent skills", href: "https://github.com/NEAR-Intents-Agent-API/skills", icon: Sparkle },
  { label: "TypeScript SDK", href: "https://github.com/NEAR-Intents-Agent-API/sdk-typescript", icon: Cube },
];

export function AgentApiResources() {
  return <footer aria-labelledby="agent-api-resources" className="flex flex-col gap-4 border-t pt-6">
    <h2 id="agent-api-resources" className="text-sm font-medium">NEAR Intents Agent API resources</h2>
    <nav aria-label="NEAR Intents resources" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {resources.map(({label, href, icon: Icon}) => <Button key={href} asChild variant="outline" size="sm" className="h-auto min-w-0 justify-start whitespace-normal py-3">
        <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`${label} (opens in a new tab)`}>
          <Icon data-icon="inline-start" aria-hidden="true" /><span className="min-w-0 flex-1 text-left">{label}</span><ArrowSquareOut data-icon="inline-end" aria-hidden="true" />
        </a>
      </Button>)}
    </nav>
  </footer>;
}
