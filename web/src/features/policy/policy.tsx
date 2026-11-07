import { PencilSimple } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ownerName, useAgent } from "../../app/frame";
import { amountOf, symbolOf, usd } from "../../shared/format";
import { Badge, Button, Details, Section } from "../../shared/ui";
import { Key, Pause, Snowflake, Sun } from "@phosphor-icons/react";
import { EntityChip, ValuePill } from "@/components/beautifui/atoms";
import { InfoTip } from "../../dashboard/info-tip";
import { assetVar } from "../portfolio/book";
import { OwnerControls, useSigner } from "../owner/owner";
import { SCHEDULE_STOP_SCOPE } from "../owner/task-recovery";
import { Grants } from "./grants";
import { type AgentPolicy, BUDGET, type Window, WINDOWS } from "../../proposals/policy-draft";
import { Editor } from "./policy-editor";
import { PolicyEvidence } from "./policy-evidence";
import { PolicyObservations } from "./policy-observations";

/** The policy the owner signed and the owner's controls over it. */
export function Policy() {
  const { data, setup } = useAgent();
  const { canSign } = useSigner(setup);
  const [editing, setEditing] = useState(false);
  const { policy } = data.policy;
  return (
    <>
      <PolicyObservations />
      {policy ? <AllowedActions policy={policy} editing={editing} setEditing={setEditing} canSign={canSign} />
        : <Section title="Allowed actions"><p className="text-sm text-muted-foreground">No policy available to review.</p></Section>}
      <OwnerSection frozen={policy?.frozen} />
      <PolicyEvidence digest={data.digest} />
    </>
  );
}

/** What an empty destination list means in each mode. */
const destinations = ({ mode, list }: AgentPolicy["destinations"]) => {
  const addresses = list.map((d) => d.address).join(", ");
  if (mode === "only") return addresses ? `Only ${addresses}` : "No external destinations allowed by this policy.";
  if (mode === "except") return addresses ? `Any destination except ${addresses}` : "Any destination (no exceptions)";
  return "Any destination";
};

const PERIOD_OF: Record<(typeof BUDGET)[number][0], string> = { daily_usd: "Daily", weekly_usd: "Weekly", monthly_usd: "Monthly" };

/** The policy in force as a limits table, or its editor. */
function AllowedActions({ policy, editing, setEditing, canSign }: {
  policy: AgentPolicy; editing: boolean; setEditing: (editing: boolean) => void; canSign: boolean;
}) {
  const { data, setup } = useAgent();
  const caps = (window: Window) => Object.entries(policy.limits?.[window] ?? {}).map(([asset, raw]) => ({ asset, text: amountOf(raw, asset, data.book) }));
  const capRows = WINDOWS.map(([window, label]) => ({ window, label, caps: caps(window) }));
  const budgets = BUDGET.map(([key, label]) => ({ key, label, value: policy.budget[key] }));
  const unsetCaps = capRows.filter(r => !r.caps.length).map(r => r.label.toLowerCase());
  const unsetBudgets = budgets.filter(b => !b.value).map(b => PERIOD_OF[b.key].toLowerCase());
  const assets = policy.assets === "any" ? null : policy.assets.map((a) => symbolOf(a, data.book));
  return (
    <Section
      className="dash-span-12"
      title="Allowed actions"
      description="What the agent may do, and how much."
      info="Limits in the reported policy, as the owner signed them. The current-state check above is separate from these terms."
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={data.policy.status === "APPLIED" ? "success" : "warning"}>
            {`Revision ${data.policy.revision ?? "not reported"} · ${data.policy.status?.toLowerCase() ?? "status not reported"}`}
          </Badge>
          {!editing && canSign && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <PencilSimple size={16} /> Edit
            </Button>
          )}
        </div>
      }
    >
      {editing ? (
        <Editor policy={policy} data={data} setup={setup} onDone={() => setEditing(false)} />
      ) : (
        <>
          <dl className="grid gap-px overflow-hidden rounded-lg bg-[var(--line)] text-sm shadow-hairline sm:grid-cols-2 xl:grid-cols-4">
            <Fact term="Owner"><EntityChip name={ownerName(setup)} color="var(--dash-brand)" /></Fact>
            <Fact term="Owner approval"><ValuePill tone={policy.owner_approval ? "orange" : "neutral"}>{policy.owner_approval ? "Every payment" : "Not required inside the policy"}</ValuePill></Fact>
            <Fact term="Actions">{policy.actions.length ? <span className="flex flex-wrap gap-1.5">{policy.actions.map(action => <ValuePill key={action} tone="accent">{action}</ValuePill>)}</span> : <Muted>None</Muted>}</Fact>
            <Fact term="Assets">{assets === null ? <ValuePill>Any asset</ValuePill> : assets.length ? <span className="flex flex-wrap gap-1.5">{assets.map(symbol => <EntityChip key={symbol} name={symbol} color={assetVar(symbol)} />)}</span> : <Muted>None</Muted>}</Fact>
          </dl>
          <div className="overflow-x-auto rounded-lg bg-inset shadow-hairline [&_thead_th]:!bg-[var(--inset)]">
            <table className="w-full min-w-[520px] table-fixed text-left text-sm">
              <colgroup><col className="w-[28%]" /><col className="w-[44%]" /><col className="w-[28%]" /></colgroup>
              <thead><tr><th scope="col" className="px-3 font-medium">Limit</th><th scope="col" className="px-3 font-medium">Value</th><th scope="col" className="px-3 font-medium">Period</th></tr></thead>
              <tbody>
                {capRows.filter(r => r.caps.length).map(r => <tr key={r.window}>
                  <th scope="row" className="px-3 text-left font-normal text-muted-foreground">Asset cap</th>
                  <td className="px-3"><span className="flex flex-wrap gap-1.5">{r.caps.map(c => <ValuePill key={c.asset} tone="info">{c.text}</ValuePill>)}</span></td>
                  <td className="px-3">{r.label}</td>
                </tr>)}
                {budgets.filter(b => b.value).map(b => <tr key={b.key}>
                  <th scope="row" className="px-3 text-left font-normal text-muted-foreground">USD budget</th>
                  <td className="px-3"><ValuePill tone="green">{usd(b.value)}</ValuePill></td>
                  <td className="px-3">{PERIOD_OF[b.key]}</td>
                </tr>)}
                <tr>
                  <th scope="row" className="px-3 text-left font-normal text-muted-foreground">Destinations</th>
                  <td className="px-3" colSpan={2}>{destinations(policy.destinations)}</td>
                </tr>
                {(unsetCaps.length > 0 || unsetBudgets.length > 0) && <tr>
                  <th scope="row" className="px-3 text-left font-normal text-muted-foreground">Not limited</th>
                  <td className="px-3 text-muted-foreground" colSpan={2}>
                    {[unsetCaps.length ? `No ${listOf(unsetCaps)} asset caps` : "", unsetBudgets.length ? `no ${listOf(unsetBudgets)} USD budget` : ""].filter(Boolean).join("; ")}
                  </td>
                </tr>}
              </tbody>
            </table>
          </div>
          <Details summary="Rate and confidentiality">
            <dl className="grid gap-px overflow-hidden rounded-lg bg-[var(--line)] text-sm shadow-hairline sm:grid-cols-2">
              <Fact term="Rate">{policy.max_actions_per_hour ? <ValuePill>{`${policy.max_actions_per_hour} actions an hour`}</ValuePill> : <Muted>No cap</Muted>}</Fact>
              <Fact term="Confidential"><ValuePill tone={policy.confidential ? "green" : "neutral"}>{policy.confidential ? "Enabled" : "Disabled"}</ValuePill></Fact>
            </dl>
          </Details>
        </>
      )}
    </Section>
  );
}

/** "a", "a or b", "a, b or c". */
const listOf = (items: string[]) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;

const Muted = ({ children }: { children: ReactNode }) => <span className="text-ink-3">{children}</span>;

/** One fact in a hairline grid: its label above its value. */
function Fact({ term, children }: { term: string; children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-1.5 bg-inset px-3 py-2.5">
    <dt className="text-xs text-muted-foreground">{term}</dt>
    <dd className="min-w-0 break-words">{children}</dd>
  </div>;
}

/** One owner control: an icon, its title, its one-line effect, its explanation behind an info tip, and its action. */
function ControlRow({ icon, tone, title, effect, info, children }: { icon: ReactNode; tone: string; title: string; effect: ReactNode; info: ReactNode; children: ReactNode }) {
  return <div className="flex h-full flex-wrap items-center gap-3 px-3 py-3 text-sm">
    <span className={`dash-tile ${tone}`} aria-hidden="true">{icon}</span>
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex items-center gap-1.5"><h3 className="font-medium">{title}</h3><InfoTip label={`About: ${title.toLowerCase()}`}>{info}</InfoTip></span>
      <span className="text-xs text-muted-foreground">{effect}</span>
    </div>
    <div className="flex shrink-0 justify-end max-sm:w-full max-sm:pl-11 max-sm:justify-start">{children}</div>
  </div>;
}

/**
 * The owner's controls, shown whatever the policy read says: freezing is the emergency stop. When the policy can't be
 * read, freezing is offered, and the page says the current state isn't confirmed. The grants follow as their own card.
 */
function OwnerSection({ frozen }: { frozen?: boolean }) {
  const { data, setup } = useAgent();
  const live = data.grants.filter((g) => !g.revoked_at && Date.parse(g.expires_at) > Date.now()).length;
  return (
    <>
    <Section title="Owner controls" description="Emergency and schedule controls."
      info="Stopping the schedule, revoking a grant and freezing the agent have different scopes. None confirms cancellation of operations already submitted.">
      <div className="grid divide-y overflow-hidden rounded-lg bg-inset shadow-hairline lg:grid-cols-3 lg:divide-x lg:divide-y-0">
        <ControlRow icon={<Pause size={15} />} tone="tone-info" title="Stop the schedule" effect="Prevents future scheduled runs."
          info={<>{SCHEDULE_STOP_SCOPE} It does not revoke a grant or freeze the agent.</>}>
          <Button asChild variant="outline" size="sm"><Link to="/automations">Review schedule controls</Link></Button>
        </ControlRow>
        <div>
          <ControlRow icon={frozen ? <Sun size={15} /> : <Snowflake size={15} />} tone={frozen ? "tone-success" : "tone-danger"} title={frozen ? "Unfreeze the agent" : "Freeze the agent"}
            effect={frozen ? "Frozen: new actions are blocked." : "Blocks new actions across every grant."}
            info={<>Freezing blocks new actions across grants. It does not prove that an operation already committed by the provider will stop.{frozen ? " Unfreezing does not establish that the grant, schedule or a particular action is ready." : ""}</>}>
            <OwnerControls setup={setup} frozen={Boolean(frozen)} />
          </ControlRow>
          {frozen === undefined && <p className="px-3 pb-3 text-xs text-[var(--status-warning)]">The policy isn’t available, so whether the agent is frozen now isn’t confirmed.</p>}
        </div>
        <ControlRow icon={<Key size={15} />} tone="tone-danger" title="Revoke a grant" effect={`${live} live grant${live === 1 ? "" : "s"}; revoking one stops it at once.`}
          info="Revocation removes that grant’s permission for new actions. Other grants and operations already committed by the provider need separate review.">
          <Button asChild variant="outline" size="sm"><a href="#grants">Go to grants</a></Button>
        </ControlRow>
      </div>
    </Section>
    <div id="grants" className="scroll-mt-24">
      <Grants data={data} setup={setup} />
    </div>
    </>
  );
}
