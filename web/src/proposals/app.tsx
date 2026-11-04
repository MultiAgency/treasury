import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { proposalId } from "@multiagency/sdk";
import { agentName } from "../../../apps/server/src/contract.ts";
import { TreasuryBrand } from "../app/brand";
import { Button, ErrorBox, errorMessage, input, Loading, QueryError } from "../shared/ui";
import { Connection } from "./connection";
import { ProposalDetail } from "./proposal-detail";
import { ProposalList } from "./proposal-list";
import { agentReads, api, failureOf } from "./queries";
import { sign } from "./wallet";
import { failureText } from "./words";

/** Where the page is: no agent (`/`), an agent's proposals (`/agents/<agent>`), or one of them (`…/proposals/<id>`). */
function place(pathname: string) {
  const [, agent, , id] = /^\/agents\/([^/]+)(\/proposals\/([^/]+))?\/?$/.exec(pathname) ?? [];
  return agent && agentName.safeParse(agent).success ? { agent, id } : undefined;
}

export function App() {
  const here = useMemo(() => place(location.pathname), []);
  return <>
    <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-background focus:p-3">Skip to main content</a>
    <header className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-8"><TreasuryBrand /></header>
    <main id="main" tabIndex={-1} className="mx-auto flex max-w-4xl flex-col gap-10 px-4 pb-16 sm:px-8">
      {here ? <Agent name={here.agent} id={here.id} /> : <ChooseAgent />}
    </main>
  </>;
}

function ChooseAgent() {
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const open = (event: FormEvent) => {
    event.preventDefault();
    const checked = agentName.safeParse(name);
    if (!checked.success) return setError("An agent's name is lowercase letters, digits and hyphens, at most 32.");
    // Only the checked name, and encoded: never what was typed, so nothing typed can become another address.
    location.assign(`/agents/${encodeURIComponent(checked.data)}`);
  };
  return <>
    <h1 className="text-2xl font-semibold">Treasury proposals</h1>
    <form onSubmit={open} className="flex max-w-md flex-col gap-3">
      <label htmlFor="agent" className="text-sm font-medium">Agent name</label>
      <input id="agent" className={input} value={name} onChange={event => { setName(event.target.value.trim()); setError(undefined); }}
        autoComplete="off" aria-invalid={Boolean(error)} />
      <ErrorBox error={error} />
      <Button type="submit" className="self-start">Open proposals</Button>
    </form>
  </>;
}

/** An agent's page, once the signed-in account is its owner: who's signed in, the connection, then its proposals. */
function Agent({ name, id }: { name: string; id: string | undefined }) {
  const reads = useMemo(() => agentReads(name), [name]);
  const identity = useQuery(reads.identity);
  const failure = failureOf(identity.error);
  const title = id ? "Proposal" : "Treasury proposals";
  const heading = <div className="flex flex-col gap-1">
    <h1 className="text-2xl font-semibold">{title}</h1>
    <p className="text-sm text-muted-foreground">Agent <span className="font-mono">{name}</span></p>
  </div>;
  if (identity.isPending) return <>{heading}<Loading label="Checking your session…" /></>;
  if (failure?.kind === "not_signed_in") return <>{heading}<SignIn /></>;
  if (identity.isError) return <>{heading}
    {failure?.kind === "not_owner" && <SignedIn>{null}</SignedIn>}
    <QueryError error={identity.error} retry={() => identity.refetch()} />
  </>;
  const { owner, host } = identity.data;
  return <>
    {heading}
    <SignedIn>Signed in as <span className="font-mono">{owner}</span></SignedIn>
    <Connection reads={reads} owner={owner} />
    {id === undefined ? <ProposalList reads={reads} />
      : proposalId.safeParse(id).success ? <ProposalDetail reads={reads} id={id} owner={owner} host={host} />
      : <div className="flex flex-col items-start gap-4">
        <a href={`/agents/${name}`} className="text-sm underline">Back to proposals</a>
        <p role="alert">This address doesn't name a proposal: a proposal's ID is 32 lowercase hexadecimal characters.</p>
      </div>}
  </>;
}

/** Signs in to this server: the owner's wallet signs the server's challenge, addressed to this server's own host. */
function SignIn() {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const signIn = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const issued = await api.challenge();
      if (!issued.ok) return setError(failureText(issued, "sign-in"));
      let signed;
      try { signed = await sign(issued.value); } catch (problem) { return setError(`The wallet didn't sign: ${errorMessage(problem)}`); }
      const session = await api.signIn({ accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: issued.value.nonce });
      if (!session.ok) return setError(failureText(session, "sign-in"));
      await client.resetQueries();
    } finally { setBusy(false); }
  };
  return <section aria-labelledby="sign-in" className="flex max-w-md flex-col items-start gap-4">
    <h2 id="sign-in" className="text-xl font-semibold">Sign in</h2>
    <p className="text-sm text-muted-foreground">Sign in with the wallet of the account that owns this agent. Your wallet signs a message addressed to this server; it moves nothing.</p>
    <ErrorBox error={error} />
    <Button disabled={busy} onClick={signIn}>{busy ? "Signing in…" : "Sign in with wallet"}</Button>
  </section>;
}

/** Who is signed in, and signing out, which ends the server's session whatever the wallet does. */
function SignedIn({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const signOut = async () => {
    setBusy(true);
    setError(undefined);
    const ended = await api.signOut();
    setBusy(false);
    if (!ended.ok) return setError("Sign-out didn't complete, so you may still be signed in. Try again.");
    await client.resetQueries();
  };
  return <div className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-3 text-sm">
      {children && <p>{children}</p>}
      <Button variant="outline" size="sm" disabled={busy} onClick={signOut}>{busy ? "Signing out…" : "Sign out"}</Button>
    </div>
    <ErrorBox error={error} />
  </div>;
}
