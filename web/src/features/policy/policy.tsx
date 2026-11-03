import { PencilSimple } from "@phosphor-icons/react";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ownerName, useAgent } from "../../app/frame";
import { amountOf, symbolOf, usd } from "../../shared/format";
import { Badge, Button, Details, Section } from "../../shared/ui";
import { OwnerControls, useSigner } from "../owner/owner";
import { SCHEDULE_STOP_SCOPE } from "../owner/task-recovery";
import { Grants } from "./grants";
import { type AgentPolicy, BUDGET, type Window, WINDOWS } from "./policy-draft";
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

/** The policy in force, or its editor. */
function AllowedActions({ policy, editing, setEditing, canSign }: {
  policy: AgentPolicy; editing: boolean; setEditing: (editing: boolean) => void; canSign: boolean;
}) {
  const { data, setup } = useAgent();
  const caps = (window: Window) =>
    Object.entries(policy.limits?.[window] ?? {})
      .map(([asset, raw]) => amountOf(raw, asset, data.book))
      .join(" · ") || "None";
  const budget = BUDGET.flatMap(([key, label]) => (policy.budget[key] ? [`${usd(policy.budget[key])} ${label}`] : [])).join(" · ");
  const rows: [string, string][] = [
    ["Owner", ownerName(setup)],
    ["Actions", policy.actions.join(", ") || "None"],
    ["Owner approval", policy.owner_approval ? "Every payment" : "Not required inside the policy"],
    ["Assets", policy.assets === "any" ? "Any" : policy.assets.map((a) => symbolOf(a, data.book)).join(", ") || "None"],
    ...WINDOWS.map(([window, label]): [string, string] => [`Caps ${label.toLowerCase()}`, caps(window)]),
    ["USD budget", budget || "None"],
    ["Destinations", destinations(policy.destinations)],
  ];
  const more: [string, string][] = [
    ["Rate", policy.max_actions_per_hour ? `${policy.max_actions_per_hour} actions an hour` : "No cap"],
    ["Confidential", policy.confidential ? "Enabled" : "Disabled"],
  ];
  const list = (entries: [string, string][]) => (
    <dl className="grid gap-x-10 gap-y-5 text-sm sm:grid-cols-2">
      {entries.map(([term, detail]) => (
        <div key={term} className="flex flex-col gap-1">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="break-words">{detail}</dd>
        </div>
      ))}
    </dl>
  );
  return (
    <Section
      title="Allowed actions"
      description="Limits in the reported policy. The current-state check above is separate from these terms."
      action={
        <div className="flex flex-wrap items-start gap-3">
          <Badge>
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
          {list(rows)}
          <Details summary="Rate and confidentiality">{list(more)}</Details>
        </>
      )}
    </Section>
  );
}

/**
 * The owner's controls, shown whatever the policy read says: freezing is the emergency stop. When the policy can't be
 * read, freezing is offered, and the page says the current state isn't confirmed.
 */
function OwnerSection({ frozen }: { frozen?: boolean }) {
  const { data, setup } = useAgent();
  return (
    <Section title="Owner controls" description="Stopping the schedule, revoking a grant and freezing the agent have different scopes. None confirms cancellation of operations already submitted.">
      <div className="flex flex-col gap-2 text-sm">
        <h3 className="font-medium">Stop the schedule</h3>
        <p>{SCHEDULE_STOP_SCOPE} It does not revoke a grant or freeze the agent.</p>
        <Link to="/automations" className="self-start underline">Review schedule controls</Link>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-4 text-sm">
        <div className="flex max-w-prose flex-col gap-2">
          <h3 className="font-medium">{frozen ? "Unfreeze the agent" : "Freeze the agent"}</h3>
          <p>Freezing blocks new actions across grants. It does not prove that an operation already committed by the provider will stop.</p>
          {frozen === undefined && <p>The policy isn’t available, so whether the agent is frozen now isn’t confirmed.</p>}
          {frozen && <p>Unfreezing does not establish that the grant, schedule or a particular action is ready.</p>}
        </div>
        <OwnerControls setup={setup} frozen={Boolean(frozen)} />
      </div>
      <div id="grants" className="scroll-mt-48">
        <p className="mb-4 text-sm">Revocation removes that grant’s permission for new actions. Other grants and operations already committed by the provider need separate review.</p>
        <Grants data={data} setup={setup} />
      </div>
    </Section>
  );
}
