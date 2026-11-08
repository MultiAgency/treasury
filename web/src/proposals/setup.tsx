import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { accountId } from "../../../apps/server/src/contract.ts";
import { Button, Card, ErrorBox, errorMessage, input, Loading, Note, QueryError } from "../shared/ui";
import { DaoRequestView } from "./dao-request";
import type { ConsentText, Creation, CreationStatus, Identity } from "./proposals-api";
import { api, failureOf, setupReads, type agentReads } from "./queries";
import { SignedIn, SignIn } from "./session";
import { ReviewDialog, SignedText, when } from "./ui";
import { filedText, fileLabel, filesAndVotes, filingHeld } from "./dao-filing";
import { file, sign, WrongAccount } from "./wallet";
import type { TransactionOutcome } from "./wallet-transaction";
import { agentAddress, DAO_TITLE, ROOT_TITLE } from "./pages";
import { failureText } from "./words";

const agentLink = (agent: string) => `/agents/${encodeURIComponent(agent)}`;

/**
 * The page's root for a signed-in account: its own treasuries, setting one up when it has none (#12), a DAO's setup for
 * one of its members, and opening an agent by name.
 */
export function Home() {
  const setups = useQuery(setupReads.mine);
  const failure = failureOf(setups.error);
  return <>
    <h1 className="text-2xl font-semibold">{ROOT_TITLE}</h1>
    {setups.isPending ? <Loading label="Checking your session…" />
      : failure?.kind === "not_signed_in" ? <SignIn />
      : setups.isError ? <QueryError error={setups.error} retry={() => setups.refetch()} />
      : <>
        <SignedIn>Signed in as <span className="font-mono">{setups.data.account}</span></SignedIn>
        {setups.data.agents.length
          ? <ul aria-label="Your treasuries" className="flex flex-col gap-2">
            {setups.data.agents.map(agent => <li key={agent}><a className="font-mono underline" href={agentLink(agent)}>{agent}</a></li>)}
          </ul>
          : <SetUp account={setups.data.account} />}
        <ForDao />
      </>}
    <OpenByName />
  </>;
}

type Review = { phase: "reading" } | { phase: "review"; text: ConsentText; notice?: string } | { phase: "signing"; text: ConsentText };

/**
 * Sets up the account's own Treasury: its wallet signs exactly the setup text the server built, for the platform's host.
 * The platform reserves the agent; creating it is the next step, on the agent's page. A lost answer is never sent
 * again from here: the treasuries are read again, and a setup that went through shows there. `again`: the agent was
 * reserved, but its setup lapsed before it was created; the platform finds the same reservation and sets it up anew.
 */
function SetUp({ account, again = false }: { account: string; again?: boolean }) {
  const client = useQueryClient();
  const [review, setReview] = useState<Review>();
  const [error, setError] = useState<string>();

  const prepare = async () => {
    setError(undefined);
    setReview({ phase: "reading" });
    const text = await api.setupText();
    if (text.ok) return setReview({ phase: "review", text: text.value });
    setReview(undefined);
    setError(failureText(text, "setup"));
  };

  const submit = async (text: ConsentText) => {
    setReview({ phase: "signing", text });
    let signed;
    try { signed = await sign(text); } catch (problem) {
      return setReview({ phase: "review", text, notice: `The wallet didn't sign: ${errorMessage(problem)}. Nothing was sent.` });
    }
    if (signed.accountId !== account) {
      return setReview({ phase: "review", text, notice: `Your wallet signed as ${signed.accountId}, but you're signed in as ${account}. Nothing was sent. Sign with ${account}.` });
    }
    const done = await api.setup({ message: text.message, nonce: text.nonce, publicKey: signed.publicKey, signature: signed.signature });
    setReview(undefined);
    if (done.ok) return location.assign(agentLink(done.value.agent));
    setError(failureText(done, "setup"));
    void client.invalidateQueries({ queryKey: setupReads.mine.queryKey });
  };

  return <section aria-labelledby="set-up" className="flex flex-col gap-4">
    <h2 id="set-up" className="text-xl font-semibold">{again ? "Set up your Treasury again" : "Set up your Treasury"}</h2>
    <Card>
      <div className="flex flex-col items-start gap-3">
        <p>{again ? "Setting it up again reserves this agent for another hour; you create it next, here." : "You have no Treasury here yet. Setting one up reserves a Treasury agent for your account; you create it next, on the platform's own page."}</p>
        <Button disabled={review !== undefined} onClick={prepare}>{review?.phase === "reading" ? "Preparing…" : again ? "Set it up again" : "Set up a Treasury"}</Button>
        <ErrorBox error={error} />
      </div>
    </Card>
    <ReviewDialog open={review?.phase === "review" || review?.phase === "signing"} busy={review?.phase === "signing"} onClose={() => setReview(undefined)}
      title="Set up a Treasury for your account?"
      description="Your wallet signs the platform's setup text below, for the platform's host. It's good for an hour, and lets this app ask you to create your Treasury agent, nothing else."
      actions={review && review.phase !== "reading" && <Button disabled={review.phase === "signing"} onClick={() => submit(review.text)}>
        {review.phase === "signing" ? "Waiting for the wallet…" : "Sign and set up"}
      </Button>}>
      {review && review.phase !== "reading" && <>
        {review.phase === "review" && review.notice && <p role="alert" className="text-sm">{review.notice}</p>}
        <SignedText text={review.text.message} />
        <Note>Nothing moves and no agent exists until you create it. Creating it is a separate signature, on the platform's confirm page.</Note>
      </>}
    </ReviewDialog>
  </section>;
}

/** Opens a DAO's setup page for one of its members: the DAO's account, checked before it becomes an address. */
function ForDao() {
  const [dao, setDao] = useState("");
  const [error, setError] = useState<string>();
  const open = (event: FormEvent) => {
    event.preventDefault();
    const checked = accountId.safeParse(dao);
    if (!checked.success) return setError("Enter the DAO's NEAR account, such as example.sputnik-dao.near.");
    location.assign(`/setup/dao/${encodeURIComponent(checked.data)}`);
  };
  return <section aria-labelledby="for-dao" className="flex flex-col gap-3">
    <h2 id="for-dao" className="text-xl font-semibold">A DAO's Treasury</h2>
    <form onSubmit={open} className="flex max-w-md flex-col gap-3">
      <label htmlFor="dao" className="text-sm font-medium">DAO account</label>
      <input id="dao" className={input} value={dao} onChange={event => { setDao(event.target.value.trim()); setError(undefined); }}
        autoComplete="off" aria-invalid={Boolean(error)} />
      <ErrorBox error={error} />
      <Button type="submit" variant="outline" className="self-start">Open the DAO's Treasury</Button>
    </form>
  </section>;
}

/** Opens an agent's page by its name, checked before it becomes an address. */
function OpenByName() {
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const open = (event: FormEvent) => {
    event.preventDefault();
    if (!/^[a-z0-9-]{1,32}$/.test(name)) return setError("An agent's name is lowercase letters, digits and hyphens, at most 32.");
    // The button says proposals, so it opens the agent's Proposals page, not its Home.
    location.assign(agentAddress(name, "proposals"));
  };
  return <section aria-labelledby="by-name" className="flex flex-col gap-3">
    <h2 id="by-name" className="text-xl font-semibold">Open an agent</h2>
    <form onSubmit={open} className="flex max-w-md flex-col gap-3">
      <label htmlFor="agent" className="text-sm font-medium">Agent name</label>
      <input id="agent" className={input} value={name} onChange={event => { setName(event.target.value.trim()); setError(undefined); }}
        autoComplete="off" aria-invalid={Boolean(error)} />
      <ErrorBox error={error} />
      <Button type="submit" variant="outline" className="self-start">Open proposals</Button>
    </form>
  </section>;
}

/**
 * A DAO's Treasury setup, for one of its members: its agents once reserved, and its setup while it waits for the vote,
 * filed from a member's own wallet. A DAO whose vote passed has its agent reserved on the server's next read.
 */
export function DaoSetup({ dao }: { dao: string }) {
  const client = useQueryClient();
  const reads = setupReads.dao(dao);
  const setup = useQuery(reads);
  const failure = failureOf(setup.error);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string>();
  const refresh = () => client.invalidateQueries({ queryKey: reads.queryKey });

  const ask = async () => {
    setAsking(true);
    setError(undefined);
    const filed = await api.fileDaoSetup(dao);
    setAsking(false);
    if (!filed.ok) setError(failureText(filed, "setup"));
    void refresh();
  };

  const heading = <div className="flex flex-col gap-1">
    <h1 className="text-2xl font-semibold">{DAO_TITLE}</h1>
    <p className="text-sm text-muted-foreground">DAO <span className="font-mono">{dao}</span></p>
  </div>;
  if (setup.isPending) return <>{heading}<Loading label="Checking your session…" /></>;
  if (failure?.kind === "not_signed_in") return <>{heading}<SignIn /></>;
  if (setup.isError) return <>{heading}
    {failure?.kind === "not_owner" && <SignedIn>{null}</SignedIn>}
    <p role="alert">{failure?.kind === "not_owner" ? `The signed-in account isn't a member of ${dao}.` : null}</p>
    {failure?.kind !== "not_owner" && <QueryError error={setup.error} retry={() => setup.refetch()} />}
  </>;
  const { account, access, agents, request, ended } = setup.data;
  return <>
    {heading}
    <SignedIn>Signed in as <span className="font-mono">{account}</span>, a member of <span className="font-mono">{dao}</span></SignedIn>
    <section aria-labelledby="dao-setup" className="flex flex-col gap-4">
      <h2 id="dao-setup" className="text-xl font-semibold">Setup</h2>
      <Card>
        {agents.length ? <div className="flex flex-col gap-2">
          <p role="status">The DAO's Treasury is set up. Create it, then connect it, from its page.</p>
          <ul aria-label="The DAO's treasuries">{agents.map(agent => <li key={agent}><a className="font-mono underline" href={agentLink(agent)}>{agent}</a></li>)}</ul>
        </div>
          : request ? <div className="flex flex-col gap-3">
            <p role="status">Waiting for the vote of {dao} to set up its Treasury.</p>
            <DaoRequestView request={request} account={account} onChanged={refresh} />
            <Button variant="ghost" className="self-start" disabled={setup.isFetching} onClick={refresh}>{setup.isFetching ? "Checking…" : "Check again"}</Button>
          </div>
          : <div className="flex flex-col items-start gap-3">
            {ended && <p role="alert">{ended === "expired" ? "The DAO's vote didn't pass in time, so nothing was set up."
              : ended === "rejected" ? "The DAO didn't approve its proposal, so nothing was set up."
              : "The platform didn't set the agent up after the vote: the DAO's Treasury may already exist, or its key changed."}</p>}
            <p>{dao} has no Treasury here yet. It sets one up by its own vote: a member files the proposal, and the DAO's members vote on it.</p>
            {access.canPropose
              ? <Button disabled={asking} onClick={ask}>{asking ? "Asking…" : "Ask the DAO to set up its Treasury"}</Button>
              : <p className="text-sm">A member who may file proposals asks the DAO.</p>}
          </div>}
        <ErrorBox error={error} />
      </Card>
    </section>
  </>;
}

type Reads = ReturnType<typeof agentReads>;

/**
 * Creating a reserved agent, under its setup: a wallet owner signs on the platform's confirm page, which this page
 * links to; a DAO's member files the creation for the DAO's vote, which must pass before it expires, in minutes. Its
 * status is read every few seconds until it's final; once submitted, the agent's identity is read again, and the page
 * moves on to connecting it.
 */
export function CreateAgent({ reads, identity }: { reads: Reads; identity: Identity }) {
  const client = useQueryClient();
  const [created, setCreated] = useState<Creation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  /** The setup consent lapsed: only setting it up again lets the agent be created. */
  const [lapsed, setLapsed] = useState(false);
  /**
   * The wallet's last answer to filing, and the creation it answered. Filed (or it may have been), the button isn't
   * offered again for that creation: a second filing is a second proposal, and the creation's status reads the same
   * before and after filing. Creating it again starts a new one, which may be filed.
   */
  const [last, setLast] = useState<{ outcome: TransactionOutcome["kind"]; correlationId: string }>();
  const held = last !== undefined && last.correlationId === created?.correlationId && filingHeld(last.outcome);
  const status = useQuery({
    queryKey: [...reads.identity.queryKey.slice(0, 2), "creation", created?.correlationId],
    queryFn: async (): Promise<CreationStatus> => {
      const read = await reads.agent.creation(created!.correlationId);
      if (!read.ok) throw new Error(failureText(read, "read"));
      return read.value;
    },
    enabled: created !== undefined, retry: false,
    refetchInterval: query => FINAL.has(query.state.data?.stage ?? "") ? false : 5_000,
  });
  const stage = status.data?.stage;
  useEffect(() => { if (stage === "submitted") void client.invalidateQueries({ queryKey: reads.identity.queryKey }); }, [stage, client, reads]);

  const create = async () => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    const prepared = await reads.agent.create();
    setBusy(false);
    if (prepared.ok) return setCreated(prepared.value);
    setError(failureText(prepared, "setup"));
    setLapsed(prepared.kind === "refused" && prepared.code === "not_set_up");
    if (prepared.kind === "refused" && prepared.code === "already_created") void client.invalidateQueries({ queryKey: reads.identity.queryKey });
  };

  const fileDao = async (filing: Creation) => {
    setBusy(true);
    setNotice(undefined);
    try {
      const outcome = await file(filing.dao!.transaction, identity.account);
      setLast({ outcome: outcome.kind, correlationId: filing.correlationId });
      setNotice(outcome.kind === "succeeded" ? filedText(filing.dao!.transaction, when(filing.expiresAt), "or the creation expires unsigned")
        : outcome.kind === "failed" ? "The transaction failed, so nothing was filed. Create the agent again."
        : "The wallet didn't say whether it was sent. Its status below shows whether the DAO is voting; don't file again meanwhile.");
    } catch (problem) {
      setNotice(problem instanceof WrongAccount ? problem.message : `The wallet didn't send it: ${errorMessage(problem)}. Nothing was filed.`);
    } finally { setBusy(false); }
  };

  const canFile = identity.signer === "wallet" || identity.access.canPropose;
  return <section aria-labelledby="creation-title" className="flex flex-col gap-4">
    <h2 id="creation-title" className="text-xl font-semibold">Create the agent</h2>
    <Card>
      <div className="flex flex-col items-start gap-3">
        {!created ? <>
          <p role="status">This Treasury agent is set up but not created yet. {identity.signer === "dao"
            ? `${identity.owner} creates it by a vote that must pass within minutes of being filed.`
            : "You create it with your wallet, on the platform's confirm page."}</p>
          {canFile ? <Button disabled={busy} onClick={create}>{busy ? "Preparing…" : "Create the agent"}</Button>
            : <p className="text-sm">A member who may file proposals asks the DAO.</p>}
        </>
          : <>
            {created.confirm && <p>Sign the creation on the platform's own page, which shows exactly what you sign: <a className="underline" href={created.confirm.url} target="_blank" rel="noopener noreferrer">open the confirm page</a>. It expires {when(created.confirm.expiresAt)}.</p>}
            {created.dao && <>
              <p>Your wallet files the DAO's proposal to create the agent{filesAndVotes(created.dao.transaction) ? " and casts your approval" : ""}. The vote must pass by {when(created.expiresAt)}, or the creation expires unsigned.</p>
              <p className="text-sm">The DAO's proposal and every vote on it are public and permanent.</p>
              {held ? null : <Button disabled={busy} onClick={() => fileDao(created)}>{busy ? "Waiting for the wallet…" : fileLabel(created.dao.transaction)}</Button>}
            </>}
            <p role="status">{status.isError ? "Its status couldn't be read just now; reading again shortly."
              : !stage ? "Reading its status…" : STAGE_WORDS[stage]}</p>
            {(stage === "expired" || stage === "failed") && <Button variant="outline" disabled={busy} onClick={create}>Create it again</Button>}
          </>}
        {notice && <p role="status" className="text-sm">{notice}</p>}
        <ErrorBox error={error} />
        {lapsed && identity.signer === "dao" && <a className="text-sm underline" href={`/setup/dao/${encodeURIComponent(identity.owner)}`}>Set it up again</a>}
      </div>
    </Card>
    {lapsed && identity.signer === "wallet" && <SetUp account={identity.account} again />}
  </section>;
}

const FINAL = new Set(["submitted", "expired", "failed"]);
const STAGE_WORDS: Record<CreationStatus["stage"], string> = {
  voting: "Waiting for the signature.",
  submitting: "Signed; the platform is submitting it.",
  submitted: "Created. Reading the agent again…",
  expired: "It expired before it was signed. Nothing was created.",
  failed: "The platform couldn't create it. Nothing was created.",
  unknown: "Its outcome isn't known yet. Nothing is sent again from here.",
};
