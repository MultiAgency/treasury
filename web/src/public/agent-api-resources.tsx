import { ArrowSquareOut, BookOpen, Code, Cube, Gauge, Plugs, Sparkle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

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
    <p id="agent-api-resources" className="text-sm text-muted-foreground">Powered by <span className="font-medium text-foreground">NEAR Intents Agent API</span></p>
    <nav aria-label="NEAR Intents resources" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {resources.map(({label, href, icon: Icon}) => <Button key={href} asChild variant="outline" size="sm" className="h-auto min-w-0 justify-start whitespace-normal py-3">
        <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`${label} (opens in a new tab)`}>
          <Icon data-icon="inline-start" aria-hidden="true" /><span className="min-w-0 flex-1 text-left">{label}</span><ArrowSquareOut data-icon="inline-end" aria-hidden="true" />
        </a>
      </Button>)}
    </nav>
  </footer>;
}
