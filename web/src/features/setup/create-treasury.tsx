import { useEffect, useRef, useState } from "react";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { gateway as platform, isTreasury, treasuryReservation, treasurySetup, type Gateway } from "../../platform";
import { TreasuryBrand } from "../../app/brand";
import { WalletButton } from "../../app/wallet-button";
import { Button, ErrorBox, Spinner, errorMessage } from "../../shared/ui";
import { ACCESS_WAIT_GUARD, ACCESS_WAIT_TIMEOUT, SIGNED_OUT_WAIT, waitForWorkspace } from "./workspace-wait";

type Phase = { step: "form" } | { step: "reserving" } | { step: "waiting"; name: string; account: string }
  | { step: "ended"; name: string; account: string; message: string; retry: boolean };

/**
 * A self-service host's root: the account's treasuries, and reserving a new one for the account itself or for an
 * existing DAO. Reserving signs nothing, creates no agent and moves no funds; the new workspace opens only once this
 * account's session has access to it (the access wait), where the owner then creates the agent.
 */
export function CreateTreasury({ gateway }: { gateway: Gateway }) {
  const [kind, setKind] = useState<"wallet" | "dao">("wallet");
  const [dao, setDao] = useState("");
  const [phase, setPhase] = useState<Phase>({ step: "form" });
  const [error, setError] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const treasuries = gateway.agents.filter(isTreasury);
  const busy = phase.step === "reserving" || phase.step === "waiting";

  /** Waits for access to the reserved workspace, reading discovery only; never reserves again. */
  const wait = async (name: string, account: string) => {
    controller.current?.abort();
    const signal = (controller.current = new AbortController()).signal;
    setPhase({ step: "waiting", name, account });
    try {
      const end = await waitForWorkspace({ me: platform.me, account, name, signal });
      if (end.state === "open") return location.assign(`/a/${name}/`);
      setPhase({ step: "ended", name, account, retry: end.state === "timeout",
        message: end.state === "switched" ? `${ACCESS_WAIT_GUARD} Sign in as ${account} to open it.`
          : end.state === "signed-out" ? SIGNED_OUT_WAIT
            : `${ACCESS_WAIT_TIMEOUT}${end.state === "timeout" && end.lastError ? ` The last check failed: ${end.lastError}` : ""}` });
    } catch (e) {
      if (!signal.aborted) setPhase({ step: "ended", name, account, retry: true, message: errorMessage(e) });
    }
  };

  const reserve = async () => {
    if (busy) return;
    setError(undefined);
    const planned = treasuryReservation(gateway, kind === "wallet" ? { kind } : { kind, dao });
    if (!planned.ok) return setError(planned.reason);
    const account = gateway.viewer!.account;
    setPhase({ step: "reserving" });
    let name: string;
    try {
      name = await platform.reserve(planned.request);
    } catch (e) {
      setPhase({ step: "form" });
      return setError(e instanceof TypeError
        ? "The gateway’s answer was lost, so the workspace may or may not be reserved. Reserving signs nothing and moves no funds; reload to see Your treasuries before continuing again."
        : errorMessage(e));
    }
    await wait(name, account);
  };

  return <main id="treasury-main" className="mx-auto flex max-w-xl flex-col gap-8 px-5 py-10">
    <header className="flex flex-wrap items-center justify-between gap-4"><TreasuryBrand /><WalletButton /></header>
    <h1 className="text-2xl font-semibold">Your treasuries</h1>
    {treasuries.length > 0
      ? <nav aria-label="Your treasuries" className="flex flex-col gap-3">{treasuries.map(agent => <Button key={agent.name} asChild variant="outline" className="h-auto justify-start whitespace-normal break-all"><a href={`/a/${agent.name}/`}>{agent.owner}</a></Button>)}</nav>
      : <p className="text-sm text-muted-foreground">No Treasury agent is available to this account yet.</p>}
    {treasurySetup(gateway) !== "shared"
      ? <p className="text-sm">Creating a Treasury isn’t available on this host: it offers only a standalone Treasury setup, which this app doesn’t support.</p>
      : phase.step === "waiting" || phase.step === "ended"
      ? <section aria-label="Opening the new workspace" className="flex flex-col items-start gap-3">
        <h2 className="text-xl font-semibold">Opening your new workspace</h2>
        <p className="text-sm text-muted-foreground">Reserved. Nothing was signed and no agent was created yet: you create it, with your approval, once the workspace opens.</p>
        {phase.step === "waiting"
          ? <p role="status" className="flex items-center gap-3 text-sm"><Spinner /> Waiting for this account’s access to the new workspace…</p>
          : <p role="alert" className="text-sm">{phase.message}</p>}
        {phase.step === "ended" && phase.retry && <Button variant="outline" onClick={() => void wait(phase.name, phase.account)}>Check access again</Button>}
      </section>
      : <form className="flex flex-col gap-6" onSubmit={event => { event.preventDefault(); void reserve(); }}>
        <h2 className="text-xl font-semibold">Create your Treasury</h2>
        <FieldGroup>
          <FieldSet disabled={busy}>
            <FieldLegend variant="label">Owner</FieldLegend>
            <div role="radiogroup" aria-label="Treasury owner" className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2"><input type="radio" name="treasury-owner" checked={kind === "wallet"} onChange={() => setKind("wallet")} /> My NEAR account</label>
              <label className="flex items-center gap-2"><input type="radio" name="treasury-owner" checked={kind === "dao"} onChange={() => setKind("dao")} /> A DAO</label>
            </div>
          </FieldSet>
          {kind === "dao" && <Field><FieldLabel htmlFor="treasury-dao">DAO account</FieldLabel><Input id="treasury-dao" value={dao} onChange={event => setDao(event.target.value)} placeholder="example.sputnik-dao.near" required disabled={busy} autoCapitalize="none" autoCorrect="off" spellCheck={false} /></Field>}
        </FieldGroup>
        <p className="text-sm text-muted-foreground">{kind === "wallet" ? `${gateway.viewer?.account ?? "Your account"} will own it. Your wallet approves creation, policy, and delegation.` : "Use an existing Sputnik DAO where you can submit proposals. Its members approve creation and delegation."}</p>
        <p className="text-sm text-muted-foreground">Continue opens an isolated workspace; it signs nothing and moves no funds. Next, explicitly authorize agent creation and policy, save and authorize your strategy, fund your agent, then enable scheduling. Scheduling starts off.</p>
        <ErrorBox error={error} />
        <Button type="submit" className="self-start" disabled={busy || (kind === "dao" && !dao.trim())}>{busy ? <><Spinner /> Opening…</> : "Continue"}</Button>
      </form>}
  </main>;
}
