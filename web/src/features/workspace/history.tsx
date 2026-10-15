import { useEffect, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import type { GatewayAgent } from "../../app/session";
import { ownersOf } from "../../app/session";
import { gatewayQueries } from "../../app/queries";
import { areaName } from "../../app/workspace";
import { useAccessState, visibleProposals } from "../../shared/access";
import { accessDenied, ReadFailure } from "../../shared/read-failure";
import { Field, FieldGroup } from "../../shared/form";
import { Field as SelectField, FieldLabel } from "@/components/ui/field";
import { Empty, EmptyContent } from "@/components/ui/empty";
import { Button, Loading, Section, input } from "../../shared/ui";
import { AgentHistory, HistoryChecks, historyRecords, useHistory } from "./activity";
import { ProposalRecords } from "./proposals";
import { describeProposal, EMPTY_HISTORY_FILTERS, historyStatusLabel, matchesHistory, type HistoryFilters, type HistoryType } from "./activity-filters";

const types: [HistoryType, string][] = [["money", "Money actions"], ["owner", "Owner actions"], ["run", "Runs"], ["test", "Earlier policy tests"], ["proposal", "DAO proposals"]];

/** Filters act on already returned records. Checks always cover every accessible agent. */
export function WorkspaceHistory({ agents }: { agents: GatewayAgent[] }) {
  const access = useAccessState();
  const history = useHistory(agents);
  const daos = ownersOf(agents.filter(agent => agent.dao));
  const proposalReads = useQueries({ queries: daos.map(dao => gatewayQueries.proposals(dao)) });
  const [area, setArea] = useState("");
  const [filters, setFilters] = useState<HistoryFilters>(EMPTY_HISTORY_FILTERS);
  const selectedArea = agents.some(agent => agent.name === area) ? area : "";
  useEffect(() => { if (area !== selectedArea) setArea(selectedArea); }, [area, selectedArea]);
  const selected = history.filter(item => !selectedArea || item.agent.name === selectedArea);
  const selectedDaos = ownersOf(agents.filter(agent => agent.dao && (!selectedArea || agent.name === selectedArea)));
  const proposals = daos.map((dao, i) => {
    const read = proposalReads[i]!;
    return { dao, read, denied: accessDenied(read.error), rows: accessDenied(read.error) ? [] : visibleProposals(read.data ?? [], access) };
  });
  const selectedProposals = proposals.filter(item => selectedDaos.includes(item.dao));
  const records = [...selected.flatMap(historyRecords), ...selectedProposals.flatMap(item => item.rows.map(describeProposal))];
  const statuses = [...new Set(records.filter(record => !filters.type || record.type === filters.type).map(record => record.status))].sort();
  // Keep a selected status explicit when its last matching record disappears during refresh.
  if (filters.status && !statuses.includes(filters.status)) statuses.push(filters.status);
  const count = records.filter(record => matchesHistory(record, filters)).length;
  const incomplete = selected.some(item => item.incomplete || item.denied) || selectedProposals.some(item => item.read.isPending || item.read.error);
  const moreCount = [filters.type, filters.status, filters.from, filters.to].filter(Boolean).length;
  const active = Boolean(selectedArea || filters.search || moreCount);
  const update = (change: Partial<HistoryFilters>) => setFilters(current => ({ ...current, ...change }));
  const clear = () => { setArea(""); setFilters(EMPTY_HISTORY_FILTERS); };
  const invalidDates = Boolean(filters.from && filters.to && filters.from > filters.to);
  return <>
    <Section title="Recovery and checks" description="Across all areas, regardless of history filters.">
      {history.map(item => <HistoryChecks key={item.agent.name} history={item} />)}
      {proposals.map(({ dao, read, rows }) => <div key={dao} className="flex flex-col gap-3 text-sm">
        {read.error && <ReadFailure label={`DAO proposals · ${dao}`} error={read.error} retry={() => read.refetch()} retained={read.data !== undefined} updatedAt={read.dataUpdatedAt} />}
        {read.isPending && <Loading label={`Checking proposals · ${dao}…`} />}
        {rows.some(row => row.status === "InProgress" && (row.what === "unknown" || row.what === "unchecked" || row.what === "agent" && row.check.kind === "mismatch")) && <>
          <p className="text-warning-muted-foreground">{dao}: some open proposals could not be verified. Review their checks before voting.</p>
          <Button variant="outline" className="h-auto max-w-full self-start whitespace-normal py-3" onClick={() => { setArea(""); setFilters({ ...EMPTY_HISTORY_FILTERS, type: "proposal" }); }}>Show proposal history</Button>
        </>}
      </div>)}
      {!agents.length && <p>No agents are available to this account.</p>}
    </Section>
    <section aria-label="History filters" className="flex min-w-0 flex-col gap-4">
      <FieldGroup className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Field id="history-search" label="Search history" type="search" placeholder="Recipient, action or reference" value={filters.search} onChange={event => update({ search: event.target.value })} />
        <SelectField className="min-w-0"><FieldLabel htmlFor="activity-area">Area</FieldLabel>
          <select id="activity-area" value={selectedArea} onChange={event => setArea(event.target.value)} className={input}>
            <option value="">All areas</option>{agents.map(agent => <option key={agent.name} value={agent.name}>{areaName(agent)} · {agent.owner} · {agent.name}</option>)}
          </select>
        </SelectField>
      </FieldGroup>
      <details className="min-w-0 text-sm">
        <summary className="min-h-11 cursor-pointer py-3">More filters{moreCount > 0 ? ` (${moreCount})` : ""}</summary>
        <FieldGroup className="mt-3 grid gap-4 sm:grid-cols-2">
          <SelectField className="min-w-0"><FieldLabel htmlFor="history-type">Record type</FieldLabel>
            <select id="history-type" className={input} value={filters.type} onChange={event => update({ type: event.target.value as HistoryType | "", status: "" })}>
              <option value="">All record types</option>{types.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </SelectField>
          <SelectField className="min-w-0"><FieldLabel htmlFor="history-status">Recorded status</FieldLabel>
            <select id="history-status" className={input} value={filters.status} onChange={event => update({ status: event.target.value })}>
              <option value="">All recorded statuses</option>{statuses.map(status => <option key={status} value={status}>{historyStatusLabel(status)}</option>)}
            </select>
          </SelectField>
          <Field label="From date" type="date" value={filters.from} onChange={event => update({ from: event.target.value })} aria-describedby="history-date-note" />
          <Field label="Through date" type="date" value={filters.to} onChange={event => update({ to: event.target.value })} aria-describedby="history-date-note" error={invalidDates ? "Choose a date on or after the From date." : undefined} />
        </FieldGroup>
        <p id="history-date-note" className="mt-3 text-muted-foreground">Dates use your local time: operation time, run start or proposal filing. Undated records, including owner actions, remain included.</p>
        <p className="mt-2 text-muted-foreground">Owner actions, run endings and proposal votes do not establish payment settlement.</p>
      </details>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" aria-atomic="true" className="text-sm text-muted-foreground">{count} of {records.length} returned records shown{incomplete ? " · Checks incomplete" : ""}</p>
        {active && <Button variant="outline" size="sm" onClick={clear}>Clear filters</Button>}
      </div>
      {count === 0 && <Empty><EmptyContent>
        <p>{records.length ? "No records match these filters." : incomplete ? "History is not fully available. See recovery and checks above." : "No history records returned for these areas."}</p>
        {records.length > 0 && <p>Change the filters or clear them to show all returned records.</p>}
      </EmptyContent></Empty>}
    </section>
    {selected.map(item => <AgentHistory key={item.agent.name} history={item} filters={filters} />)}
    {selectedProposals.filter(item => !item.denied && item.read.data !== undefined).map(({ dao, rows }) => <Section key={dao} title="DAO proposals" description="DAO-wide history, including requests without an identified agent. Selecting an area selects its owner DAO.">
      <ProposalRecords dao={dao} data={rows} error={null} history filters={filters} />
    </Section>)}
  </>;
}
