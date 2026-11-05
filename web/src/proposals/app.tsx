import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { proposalId } from "@multiagency/sdk";
import { accountId, agentName } from "../../../apps/server/src/contract.ts";
import { TreasuryBrand } from "../app/brand";
import { Loading, QueryError } from "../shared/ui";
import { Connection } from "./connection";
import { Funding } from "./funding";
import { ProposalDetail } from "./proposal-detail";
import { Portfolio } from "./portfolio";
import { ProposalList } from "./proposal-list";
import type { Identity } from "./proposals-api";
import { agentReads, failureOf } from "./queries";
import { SignedIn, SignIn } from "./session";
import { CreateAgent, DaoSetup, Home } from "./setup";

/**
 * Where the page is: the account's treasuries (`/`), a DAO's setup (`/setup/dao/<dao>`), an agent's proposals
 * (`/agents/<agent>`), or one of them (`…/proposals/<id>`).
 */
function place(pathname: string): { agent: string; id: string | undefined } | { dao: string } | undefined {
  const [, dao] = /^\/setup\/dao\/([^/]+)\/?$/.exec(pathname) ?? [];
  if (dao) {
    const decoded = (() => { try { return decodeURIComponent(dao); } catch { return ""; } })();
    return accountId.safeParse(decoded).success ? { dao: decoded } : undefined;
  }
  const [, agent, , id] = /^\/agents\/([^/]+)(\/proposals\/([^/]+))?\/?$/.exec(pathname) ?? [];
  return agent && agentName.safeParse(agent).success ? { agent, id } : undefined;
}

export function App() {
  const here = useMemo(() => place(location.pathname), []);
  return <>
    <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-background focus:p-3">Skip to main content</a>
    <header className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-8"><TreasuryBrand /></header>
    <main id="main" tabIndex={-1} className="mx-auto flex max-w-4xl flex-col gap-10 px-4 pb-16 sm:px-8">
      {!here ? <Home /> : "dao" in here ? <DaoSetup dao={here.dao} /> : <Agent name={here.agent} id={here.id} />}
    </main>
  </>;
}

/**
 * An agent's page, once the signed-in account is its owner or a member of the DAO that owns it: who's signed in, the
 * connection, then its proposals.
 */
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
  const { account, owner, signer, agentId } = identity.data;
  const signedIn = <SignedIn>Signed in as <span className="font-mono">{account}</span>{signer === "dao" && <>, a member of <span className="font-mono">{owner}</span>, which owns this agent</>}</SignedIn>;
  // An agent set up but not created yet: its creation comes first, and nothing else reaches it until then.
  if (agentId === null) return <>{heading}{signedIn}<CreateAgent reads={reads} identity={identity.data} /></>;
  return <>
    {heading}
    {signedIn}
    <Connection reads={reads} identity={identity.data} />
    {id === undefined && <Connected reads={reads} identity={identity.data} />}
    {id === undefined ? <ProposalList reads={reads} />
      : proposalId.safeParse(id).success ? <ProposalDetail reads={reads} id={id} identity={identity.data} />
      : <div className="flex flex-col items-start gap-4">
        <a href={`/agents/${name}`} className="text-sm underline">Back to proposals</a>
        <p role="alert">This address doesn't name a proposal: a proposal's ID is 32 lowercase hexadecimal characters.</p>
      </div>}
  </>;
}

/** The portfolio and funding, once a live consent connects the agent: every owner read and funding call needs it. */
function Connected({ reads, identity }: { reads: ReturnType<typeof agentReads>; identity: Identity }) {
  const consent = useQuery(reads.consent);
  return consent.data?.consent ? <><Portfolio reads={reads} /><Funding reads={reads} identity={identity} /></> : null;
}
