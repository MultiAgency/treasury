import { useMemo, useState } from "react";
import { LockKey } from "@phosphor-icons/react";
import { ConfirmButton } from "../owner/confirm-button";
import { agent, failureMessage, type SweepEvent } from "../../platform";
import { useAgent } from "../../app/frame";
import { AGENT } from "../../app/location";
import { useCanCall } from "../../app/viewer";
import { useRun } from "../../shared/action-hooks";
import { settle } from "../../shared/execution-outcome";
import { amount, fromUnits } from "../../shared/format";
import { OutcomeError } from "../../shared/outcome-error";
import { useSendBlock } from "../../shared/send-block";
import { Button, Card, CardHeader, Dot, Note, Spinner, StatusBadge } from "../../shared/ui";

/**
 * Previews, then shields, the managed public balances. Each sweep is sent once and decided from the shields it reports.
 * After a shield whose outcome is unknown or partly sent, Shield isn't offered again from this page.
 */
export function Sweep() {
  const { setup } = useAgent();
  const canSweep = useCanCall("sweep");
  const executor = setup.executor !== false;
  const grant = setup.grant;
  const canShield = grant?.label === "treasury" || Boolean(grant?.label.startsWith("treasury:"));
  const api = useMemo(() => agent(AGENT!), []);
  const { events, running, input, outcome: settled, error: thrown, run } = useRun(
    (next: { execute: boolean }, onEvent: (event: SweepEvent) => void) => api.stream("sweep", next, onEvent),
    (ended, events, input) => settle({ procedure: "sweep", input, events, ended }));
  const [unsettled, setUnsettled] = useState(false);
  const plan = events.find((e) => e.type === "plan");
  const shields = events.filter((e) => e.type === "shield");
  const exposed = plan?.exposed ?? [];
  /** The preview the dialog reviews: a new one makes an open review no longer current. */
  const reviewed = exposed.map((h) => `${h.asset}:${h.public}`).join();
  const sendBlock = useSendBlock();
  const canPreview = canSweep && executor && canShield;
  const failure = settled && !settled.outcome.ok ? settled.outcome : undefined;
  const error = thrown ?? (failure && failureMessage(failure));
  const kind = failure && failure.kind !== "partial" ? failure.kind : undefined;

  const shield = async () => {
    if (sendBlock || unsettled) return;
    if ((await run({ execute: true }))?.offerAgain === false) setUnsettled(true);
  };

  return (
    <Card>
      <CardHeader
        icon={<LockKey size={20} weight="bold" />}
        title="Sweep"
        description="Shield public USDC, wNEAR and ETH balances. Other assets are not included in this sweep."
      />
      <div className="flex flex-col gap-3 text-sm">
        {!plan && <Note>{running ? "Reading the balances…" : "Preview shows which managed balances are public."}</Note>}
        {plan && exposed.length === 0 && <Note>No public USDC, wNEAR or ETH balances found. Other assets are not checked.</Note>}
        {exposed.map((h) => {
          const sent = shields.find((e) => e.asset === h.asset);
          return (
            <div key={h.asset} className="flex flex-wrap items-center gap-2 tabular-nums">
              <Dot symbol={h.symbol} />
              {amount(h.public, h)} public
              {sent && (
                <StatusBadge status={sent.status} failureCode={sent.failureCode}>
                  Shield{" "}
                </StatusBadge>
              )}
            </div>
          );
        })}
        {canPreview && sendBlock && <Note>{sendBlock}</Note>}
        {!canShield && <Note>Shielding requires a treasury grant. Payout and invoice grants cannot shield funds.</Note>}
        <OutcomeError error={error} kind={kind} />
      </div>
      <div className="mt-auto flex justify-end gap-3">
        <Button variant="outline" size="sm" disabled={running || !canPreview} onClick={() => run({ execute: false })}>
          Preview
        </Button>
        <ConfirmButton
          path="sweep"
          label={running && input?.execute ? <><Spinner /> Shielding</> : "Shield"}
          disabled={!canPreview || exposed.length === 0 || running || input?.execute || unsettled || Boolean(sendBlock)}
          title="Shield these managed balances?"
          description="Moves these public balances into the agent's confidential balance on mainnet: they stay in the account, out of public view. The agent reads its balances again when it runs, and shields each public USDC, wNEAR and ETH balance it then finds, so anything that arrived since this preview is shielded too."
          reviewKey={reviewed}
          summary={<ul aria-label="Public balances to shield" className="text-sm tabular-nums">
            {exposed.map((h) => <li key={h.asset} className="break-all">{fromUnits(h.public.toString(), h.decimals)} {h.symbol}</li>)}
          </ul>}
          confirm="Shield"
          onConfirm={() => void shield()}
        />
      </div>
    </Card>
  );
}
