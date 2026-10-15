import { TaskEvidence } from "../evidence/task-evidence";
import { SCHEDULE_STOP_SCOPE } from "../../shared/schedule-copy";
import { PencilSimple } from "@phosphor-icons/react";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { PolicyObservations } from "./policy-observations";
import { Grants } from "./grants";
import { PolicyEvidence } from "./policy-evidence";
import { amountOf, kindOf, usd } from "../../shared/lib";
import { OwnerControls, ownerName, useSigner } from "../owner/owner";
import { BUDGET, type Window, WINDOWS } from "./policy-draft";
import { Editor } from "./policy-editor";
import { useAgent } from "../../app/agent-context";
import { Badge, Button, Details, Section } from "../../shared/ui";

/** The policy the owner signed and the owner's controls over it. */
export function Policy() {
  const { data, setup } = useAgent();
  const { canSign } = useSigner(setup);
  const [editing, setEditing] = useState(false);
  const { policy } = data.policy;
  if (!policy) return <><PolicyObservations /><p className="text-sm text-muted-foreground">No policy available to review.</p></>;
  const caps = (window: Window) =>
    Object.entries(policy.limits?.[window] ?? {})
      .map(([asset, raw]) => amountOf(raw, asset, data.book))
      .join(" · ") || "None";
  const budget = BUDGET.flatMap(([key, label]) => (policy.budget[key] ? [`${usd(policy.budget[key])} ${label}`] : [])).join(" · ");
  const rows: [string, string][] = [
    ["Owner", ownerName(setup)],
    ["Actions", policy.actions.join(", ") || "None"],
    ["Owner approval", policy.owner_approval === true ? "Every payment" : policy.owner_approval === false ? "Not required inside the policy" : "Not reported"],
    ["Assets", policy.assets === "any" ? "Any" : policy.assets.map((a) => data.book.find((h) => h.asset === a)?.symbol ?? a).join(", ")],
    ...WINDOWS.map(([window, label]): [string, string] => [`Caps ${label.toLowerCase()}`, caps(window)]),
    ["USD budget", budget || "None"],
    [
      "Destinations",
      policy.destinations?.mode === "only" && policy.destinations.list.length === 0
        ? "No external destinations allowed by this policy."
        : policy.destinations ? `${policy.destinations.mode}: ${policy.destinations.list.map((d) => d.address).join(", ")}` : "Not reported",
    ],
  ];
  const more: [string, string][] = [
    ["Rate", policy.max_actions_per_hour ? `${policy.max_actions_per_hour} actions an hour` : "No cap"],
    ["Confidential", policy.confidential === true ? "Enabled" : policy.confidential === false ? "Disabled" : "Not reported"],
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
    <>
      <PolicyObservations />
      <TaskEvidence task="policy" />
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
      <Section title="Owner controls" description="Stopping the schedule, revoking a grant and freezing the agent have different scopes. None confirms cancellation of operations already submitted.">
        {kindOf(data) === "treasury" && <div className="flex flex-col gap-2 text-sm">
          <h3 className="font-medium">Stop the schedule</h3>
          <p>{SCHEDULE_STOP_SCOPE} It does not revoke a grant or freeze the agent.</p>
          <Link to="/automations" className="self-start underline">Review schedule controls</Link>
        </div>}
        <div className="flex flex-wrap items-start justify-between gap-4 text-sm">
          <div className="flex max-w-prose flex-col gap-2">
            <h3 className="font-medium">{policy.frozen ? "Unfreeze the agent" : "Freeze the agent"}</h3>
            <p>Freezing blocks new actions across grants. It does not prove that an operation already committed by the provider will stop.</p>
            {policy.frozen && <p>Unfreezing does not establish that the grant, schedule or a particular action is ready.</p>}
          </div>
          <OwnerControls setup={setup} frozen={policy.frozen} />
        </div>
        <div id="grants" className="scroll-mt-48">
          <p className="mb-4 text-sm">Revocation removes that grant’s permission for new actions. Other grants and operations already committed by the provider need separate review.</p>
          <Grants data={data} setup={setup} />
        </div>
      </Section>
      <PolicyEvidence digest={data.digest} />
    </>
  );
}
