import { TreasuryBrand } from "./treasury-brand";
import { WalletButton } from "../features/owner/owner";
import { useState } from "react";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button, ErrorBox } from "../shared/ui";
import { gw, errorMessage } from "../shared/lib";
import { type Gateway } from "./session";

/** Registers an isolated workspace; the following screen obtains the owner's actual signature. */
export function CreateTreasury({ gateway }: { gateway: Gateway }) {
  const [kind, setKind] = useState<"wallet" | "dao">("wallet");
  const [dao, setDao] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const treasuries = gateway.agents.filter(agent => agent.area === "treasury" || agent.name === "treasury");
  const create = async () => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      const answer = await gw<{ name: string }>("/gw/treasuries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(kind === "wallet" ? {kind} : {kind, dao:dao.trim()}) });
      if (!/^[a-z0-9-]{1,32}$/.test(answer.name)) throw new Error("The server returned an invalid treasury. Refresh before continuing.");
      location.assign(`/a/${answer.name}/`);
    } catch (error) { setError(errorMessage(error)); setBusy(false); }
  };
  return <main className="mx-auto flex max-w-xl flex-col gap-8 px-5 py-10">
    <header className="flex flex-wrap items-center justify-between gap-4"><TreasuryBrand /><WalletButton /></header>
    <h1 className="text-2xl font-semibold">Your treasuries</h1>
    {treasuries.length > 0 && <nav aria-label="Your treasuries" className="flex flex-col gap-3">{treasuries.map(agent => <Button key={agent.name} asChild variant="outline" className="h-auto justify-start whitespace-normal break-all"><a href={`/a/${agent.name}/`}>{agent.owner}</a></Button>)}</nav>}
    <form className="flex flex-col gap-6" onSubmit={event => { event.preventDefault(); void create(); }}>
      <h2 className="text-xl font-semibold">New treasury</h2>
      <FieldGroup>
        <Field><FieldLabel>Owner</FieldLabel><ToggleGroup type="single" value={kind} onValueChange={value => { if (value === "wallet" || value === "dao") setKind(value); }} aria-label="Treasury owner" disabled={busy}>
          <ToggleGroupItem value="wallet">My NEAR account</ToggleGroupItem><ToggleGroupItem value="dao">A DAO</ToggleGroupItem>
        </ToggleGroup></Field>
        {kind === "dao" && <Field><FieldLabel htmlFor="treasury-dao">DAO account</FieldLabel><Input id="treasury-dao" value={dao} onChange={event => setDao(event.target.value)} placeholder="example.sputnik-dao.near" required disabled={busy} autoCapitalize="none" autoCorrect="off" spellCheck={false} /></Field>}
      </FieldGroup>
      <p className="text-sm text-muted-foreground">{kind === "wallet" ? "Your wallet approves creation, policy, and delegation." : "Use an existing Sputnik DAO where you can submit proposals. Its members approve creation and delegation."}</p>
      <ErrorBox error={error} />
      <Button type="submit" className="self-start" disabled={busy || kind === "dao" && !dao.trim()}>{busy ? "Opening…" : "Continue"}</Button>
    </form>
  </main>;
}
