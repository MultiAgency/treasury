/*
 * beautifui (beautifului.dev) Flowchart, adapted: the registry item draws a scripted agent graph; this keeps its node
 * cards, hairline connectors and status dots as a left-to-right chain (top-to-bottom on phones) of real steps.
 */
import { Fragment, type ReactNode } from "react";

export type FlowState = "done" | "active" | "idle" | "blocked";

const DOT: Record<FlowState, string> = {
  done: "bg-green",
  active: "bg-[var(--dash-brand)] shadow-[0_0_0_3px_color-mix(in_oklch,var(--dash-brand)_25%,transparent)]",
  idle: "bg-ink-3",
  blocked: "bg-orange",
};

export type FlowNode = { key: string; title: string; value: ReactNode; caption?: ReactNode; state: FlowState; icon?: ReactNode };

export function Flow({ nodes, label }: { nodes: FlowNode[]; label: string }) {
  return <ol aria-label={label} className="flex flex-col items-stretch gap-0 lg:flex-row lg:items-stretch">
    {nodes.map((node, i) => <Fragment key={node.key}>
      {i > 0 && <li aria-hidden="true" className="flex shrink-0 items-center justify-center lg:w-6">
        <span className="h-4 w-px bg-line-strong lg:h-px lg:w-full" />
      </li>}
      <li className="flex min-w-0 flex-1 flex-col gap-2 rounded-card bg-inset p-3 shadow-hairline" style={{ animation: `fade-up 300ms cubic-bezier(0.23,1,0.32,1) ${i * 60}ms both` }}>
        <span className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2 text-[12px] font-medium text-ink-2">{node.icon}<span className="truncate">{node.title}</span></span>
          <span className={`size-2 shrink-0 rounded-full ${DOT[node.state]}`} aria-hidden="true" />
        </span>
        <span className="min-w-0 text-[13.5px] font-medium text-ink">{node.value}</span>
        {node.caption && <span className="text-[12px] text-ink-3">{node.caption}</span>}
      </li>
    </Fragment>)}
  </ol>;
}
