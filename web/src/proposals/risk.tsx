import { ShieldCheck } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { PanelTitle } from "@/components/ui/stat";
import { ago } from "../shared/format";
import { Badge, Card, Loading, QueryError } from "../shared/ui";
import { PageLink } from "./nav";
import { agentAddress } from "./pages";
import type { agentReads } from "./queries";
import { levelView, metricRows, recommendationRows, topScenarios } from "./risk-view";
import { when } from "./ui";

type Reads = ReturnType<typeof agentReads>;

/**
 * The stabilization agent's report (#220), from the record a watch tick wrote: its forward level and why, the projection's
 * figures, the top stress scenarios, and what the agent would do. Nothing here acts: a de-risk is a proposal the owner
 * approves on the Proposals page, and a freeze is only ever recommended, because this app can't freeze without the
 * owner's signature (#95). An agent without the risk step has no record, which is said plainly rather than guessed.
 */
function RiskCard({ reads, id, title, description }: { reads: Reads; id: string; title: string; description: string }) {
  const risk = useQuery(reads.risk);
  const report = risk.data;
  const level = report ? levelView(report.level) : null;
  return <section id={id} aria-labelledby={`${id}-title`}>
    <Card className="gap-3">
      <PanelTitle id={`${id}-title`} title={title} description={description} icon={<ShieldCheck weight="duotone" />} tone="brand">
        {level && <Badge tone={level.tone}>{level.label}</Badge>}
      </PanelTitle>
      {risk.isPending ? <Loading label="Reading the last risk assessment…" />
        : risk.isError ? <QueryError error={risk.error} retry={() => risk.refetch()} />
        : !report ? <p role="status" className="text-sm text-muted-foreground">
          No forward risk assessment has been recorded for this agent yet. One is recorded on each watch tick once the
          stabilization agent is configured for it, so there is nothing to report until then.
        </p>
        : <>
          <p className="text-sm"><span className="font-medium">{level!.label}.</span> {level!.explanation}</p>
          <p className="text-sm text-muted-foreground">{report.reason}</p>
          <dl aria-label="Forward risk figures" className="grid gap-2 text-sm sm:grid-cols-2">
            {metricRows(report).map(({ term, value, detail }) => <div key={term} className="rounded-lg border border-border bg-background/40 p-3">
              <dt className="text-xs text-muted-foreground">{term}</dt>
              <dd className="font-medium tabular-nums">{value}</dd>
              <dd className="text-xs text-muted-foreground">{detail}</dd>
            </div>)}
          </dl>
          <div className="flex flex-col gap-1.5">
            <h3 className="text-sm font-medium">Top stress scenarios</h3>
            <ul aria-label="Top stress scenarios" className="flex flex-col gap-1.5 text-sm">
              {topScenarios(report).map(scenario => <li key={scenario.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-lg border border-border bg-background/40 px-3 py-2">
                <span>{scenario.label}</span>
                <span className="text-xs text-muted-foreground">{scenario.drawdown} drawdown · {scenario.runway} runway · {scenario.floor}</span>
              </li>)}
            </ul>
          </div>
          <div className="flex flex-col gap-1.5">
            <h3 className="text-sm font-medium">What the agent would do</h3>
            {report.recommendations.length === 0
              ? <p className="text-sm text-muted-foreground" role="status">Nothing: the projection and every stress scenario are within their steps.</p>
              : <ul aria-label="What the agent would do" className="flex flex-col gap-1.5 text-sm">
                {recommendationRows(report).map(recommendation => <li key={recommendation.action} className="rounded-lg border border-border bg-background/40 px-3 py-2">
                  <span className="font-medium">{recommendation.label}.</span> <span className="text-muted-foreground">{recommendation.text}</span>
                </li>)}
              </ul>}
            {report.proposed && <PageLink to={agentAddress(reads.name, "proposals")} className="self-start text-sm underline underline-offset-2">Review the de-risk proposal</PageLink>}
          </div>
          <p className="text-xs text-muted-foreground">
            Recorded <time dateTime={report.at} title={when(report.at)}>{ago(report.at)}</time>, log record {report.seq}.
            {" "}These are recommendations: the agent proposes a de-risk for your approval, and can't act on a freeze.
          </p>
        </>}
    </Card>
  </section>;
}

/** The Home page's forward risk card: the level, its figures, the top three scenarios and what the agent would do. */
export const ForwardRisk = ({ reads }: { reads: Reads }) =>
  <RiskCard reads={reads} id="forward-risk" title="Forward risk" description="What the stabilization agent projects, and what it would do about it." />;

/** The Strategy page's risk panel: the same record beside the strategy whose trades the level governs. */
export const RiskPanel = ({ reads }: { reads: Reads }) =>
  <RiskCard reads={reads} id="risk-panel" title="Forward risk" description="The level that holds or slows the strategy's trades, beside the strategy itself." />;
