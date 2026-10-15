import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, type LinkProps } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { ASSETS } from "../../../../src/policy";
import { useAgent } from "../../app/agent-context";
import { useCanCall, useViewer } from "../../app/viewer";
import { fromUnits, kindOf, queries, swaps } from "../../shared/lib";
import { Badge, Button, Card, Details, QueryError, Section, Spinner, type Tone } from "../../shared/ui";
import { Activity } from "../activity/activity";
import { ownerName } from "../owner/owner";
import { InvoicePageLink } from "../payables/invoice-link";
import { ManualPayment } from "../payables/payees";
import { Payments } from "../payables/timeline-payment";
import { Rebalance } from "../portfolio/automations";

// An observation is only a UI hint. Every actual action still goes through existing authorization.
const OBSERVATION_MAX_AGE = 60_000;
type Observation = { isSuccess: boolean; isError: boolean; dataUpdatedAt: number };
const observationCurrent = (query: Observation, now: number) =>
  query.isSuccess && !query.isError && query.dataUpdatedAt > 0 && now - query.dataUpdatedAt < OBSERVATION_MAX_AGE;

type Check = {
  label: string;
  status: string;
  detail: string;
  blocked: boolean;
  tone?: Tone;
  link?: { to: LinkProps["to"]; hash?: string; label: string };
};

/** The numbered stages describe a real sequence, never scripted progress or inferred completion. */
function DemoStep({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return <li className="flex min-w-0 flex-col gap-5 border-t pt-6">
    <h3 className="flex items-center gap-3 text-lg font-semibold">
      <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full border border-border-strong text-sm">{number}</span>
      {title}
    </h3>
    {children}
  </li>;
}

/** Poll retained operation records without starting or reconciling an operation. */
function DemoActivity({ planId }: { planId: string }) {
  useQuery({ ...queries.activity, refetchInterval: 5_000, retry: false });
  return <Activity planId={planId} />;
}

/** Private guided actions reuse the area's existing review, submission, and durable outcome views. */
export function LiveDemo() {
  const { setup, data } = useAgent();
  const viewer = useViewer();
  const cache = useQueryClient();
  const treasury = kindOf(data) === "treasury";
  const canPrepare = useCanCall(treasury ? "rebalance" : "pay");
  const canExecute = useCanCall(treasury ? "executePlan" : "pay");
  const setupRead = useQuery({ ...queries.setup, refetchInterval: 30_000, retry: false });
  const overviewRead = useQuery({ ...queries.overview, retry: false });
  const unresolved = useQuery({ ...queries.unresolved, refetchInterval: 5_000, retry: false });
  const [now, setNow] = useState(Date.now);
  const [planId, setPlanId] = useState<string>();
  const [paymentId, setPaymentId] = useState<string>();
  useEffect(() => {
    // Expiry and stale observations change the available actions even without another response.
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const observations = [setupRead, overviewRead, unresolved];
  const current = observations.every(query => observationCurrent(query, now));
  const fetching = observations.some(query => query.isFetching);
  const readFailed = observations.some(query => query.isError);
  const checking = observations.some(query => query.isPending);
  const executor = setup.executor === true;
  const policyKnown = data.notInForce === null && Boolean(data.policy.policy);
  const grant = setup.grant;
  const providerGrant = data.grants.find(record => record.grant_id === grant?.id);
  const expires = grant ? Date.parse(grant.expiresAt) : NaN;
  const expired = Number.isFinite(expires) && expires <= now;
  const liveGrant = Boolean(grant && expires > now && providerGrant && !providerGrant.revoked_at
    && Date.parse(providerGrant.expires_at) > now && providerGrant.label === grant.label);
  const grantPurpose = Boolean(grant && (treasury
    ? grant.label === "treasury" || grant.label.startsWith("treasury:")
    : grant.label === "payout" || grant.label === "invoices"));
  const supported = treasury ? swaps(data) : Boolean(data.policy.policy?.actions.includes("transfer"));
  const funded = data.book.some(holding => treasury
    ? BigInt(holding.public) + BigInt(holding.confidential) > 0n
    : holding.asset === ASSETS.USDC && BigInt(holding.confidential) > 0n);
  const unresolvedCount = unresolved.data?.length;
  const observationDetail = readFailed ? "An observation failed. Check again before preparing a new action."
    : checking ? "Checking this agent’s policy, grant and unresolved operations."
      : "Observations are over a minute old. Refresh them before preparing a new action.";
  const checks: Check[] = [
    ...(!current ? [{ label: "Observations", status: readFailed ? "Unavailable" : checking ? "Checking" : "Refresh needed", detail: observationDetail, blocked: true }] : []),
    {
      label: "Your access", status: canPrepare ? canExecute ? "Can prepare and execute" : "Can prepare" : "Review only", blocked: !canPrepare,
      detail: canPrepare ? canExecute ? "You may prepare and execute this action; each operation still requires authorization." : "You may prepare a preview. Executing it requires execution permission."
        : "Your account cannot prepare this action. You can review records and use the owner approvals available to your account.",
    },
    {
      label: "This instance", status: executor ? "Executor" : setup.executor === false ? "Approve-only" : "Unconfirmed", blocked: !executor,
      tone: !executor && !treasury ? "neutral" : undefined,
      detail: executor ? "This instance submits actions for this agent."
        : treasury ? "Run a rebalance on this agent’s executor. Existing records remain available here."
          : "The payee submits through the configured invoice page. Review the held payout and its owner approval here.",
    },
    {
      label: "Policy", status: !current ? "Unconfirmed" : policyKnown && supported ? "In force at last check" : "Review needed",
      blocked: !policyKnown || !supported,
      detail: !current ? "Refresh observations to confirm the policy."
        : !policyKnown ? data.notInForce ?? "No applied policy was reported."
          : !supported ? `The current policy does not allow ${treasury ? "swaps" : "transfers"}.`
            : "The provider enforces the signed policy. The amount, assets and destinations are checked for each action.",
      link: { to: "/policy", label: "Review policy and limits" },
    },
    {
      label: "Send grant", status: !current ? "Unconfirmed" : expired ? "Expired" : liveGrant && grantPurpose ? "Live at last check" : "Review needed",
      blocked: !liveGrant || !grantPurpose,
      detail: !current ? "Refresh observations to confirm the grant."
        : !grant ? executor ? "No current grant was reported. The owner must authorize one before new sends."
          : "No live send grant was reported here. The agent’s executor needs its own live grant; approving an existing held payout needs no send grant."
          : expired ? "The reported grant has expired. The owner must authorize a new grant."
            : !liveGrant ? "The reported grant could not be matched to a live provider record. Check the grant before proceeding."
              : !grantPurpose ? `The ${grant.label} grant does not permit this demo’s money action.`
                : `${grant.label} · expires ${new Date(expires).toLocaleString()}.`,
      link: treasury ? { to: "/automations", label: "Review strategy and grant" } : { to: "/policy", hash: "grants", label: "Review or renew the grant" },
    },
    {
      label: "Funds", status: !current ? "Unconfirmed" : funded ? "Balance observed" : "Funding needed", blocked: !funded,
      detail: !current ? "Refresh observations to confirm balances."
        : funded ? "Observed balances are shown below. Held payouts can reserve part of a balance; each send checks what remains available."
          : treasury ? "Fund the agent before previewing swaps toward its target allocation."
            : "The payout agent needs confidential USDC. Review funding and sweep public USDC if appropriate.",
      link: { to: "/funding", label: "Balances & funding" },
    },
    ...(!treasury ? [{
      label: "Payees", status: !current ? "Unconfirmed" : data.agreed.length ? `${data.agreed.length} agreed` : "Agreement needed",
      blocked: data.agreed.length === 0,
      detail: "Choose an agreed payee and check the amount ceiling and deadline before requesting a payment.",
      link: { to: "/payees" as const, label: "Review Agreements" },
    }] : []),
    {
      label: "Unresolved operations", status: !current ? "Unconfirmed" : unresolvedCount ? `${unresolvedCount} unresolved` : "None recorded here",
      blocked: unresolvedCount === undefined || unresolvedCount > 0,
      detail: !current ? "Refresh the operation records before sending."
        : unresolvedCount ? "An unknown outcome blocks new sends. Review the existing operation before starting another."
          : "Held payouts remain open for approval and do not block new sends.",
      link: { to: "/activity", label: "Review Activity and recovery" },
    },
  ];
  const firstBlocker = checks.find(check => check.blocked);
  const disabledReason = firstBlocker?.detail;

  return <Section title="Run with real funds" description={treasury
    ? "Preview a rebalance, review its exact swaps, then choose whether to execute on mainnet."
    : "Request a payment, review its owner approval, and follow the provider’s payment outcome."}>
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <Badge tone="warning">Real funds on mainnet</Badge>
      <p>You choose and confirm each money action.</p>
      <Link to="/activity" className="underline">Activity and recovery</Link>
    </div>
    <ol className="flex min-w-0 flex-col gap-8">
      <DemoStep number={1} title="Check this agent">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="max-w-prose text-muted-foreground">{firstBlocker ? "Resolve the check below before a new action." : "Observations checked. The server and provider check authorization again when you act."}</p>
          <Button variant="outline" size="sm" disabled={fetching} onClick={() => { void cache.invalidateQueries(); }}>
            {fetching && <Spinner />} {fetching ? "Checking observations…" : "Check observations"}
          </Button>
        </div>
        {observations.map((query, index) => query.error && <QueryError key={index} error={query.error} retry={() => { void query.refetch(); }} />)}
        {firstBlocker && <div className="flex flex-col items-start gap-2 rounded-xl bg-muted px-4 py-3 text-sm">
          <p className="font-medium">{firstBlocker.label}: {firstBlocker.status}</p>
          <p className="max-w-prose text-muted-foreground">{firstBlocker.detail}</p>
          {firstBlocker.link && <Link to={firstBlocker.link.to} hash={firstBlocker.link.hash} className="underline">{firstBlocker.link.label}</Link>}
        </div>}
        <Details summary="Agent details and prerequisite checks">
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Owner</dt><dd className="break-all">{ownerName(setup)}</dd></div>
          <div><dt className="text-muted-foreground">Agent</dt><dd className="break-all">{data.agentId}</dd></div>
          <div><dt className="text-muted-foreground">Agent wallet</dt><dd className="break-all">{setup.wallet ?? "Not reported"}</dd></div>
          <div><dt className="text-muted-foreground">Your account</dt><dd className="break-all">{viewer?.account ?? "Local session"}</dd></div>
        </dl>
        <p className="text-sm text-muted-foreground">These observations guide your next step. They do not authorize a send.</p>
        <dl className="divide-y">
          {checks.map(check => <div key={check.label} className="grid gap-2 py-4 text-sm sm:grid-cols-[11rem_1fr]">
            <dt className="font-medium">{check.label}</dt>
            <dd className="flex min-w-0 flex-col items-start gap-2">
              <Badge tone={check.tone ?? (check.blocked ? "warning" : "neutral")}>{check.status}</Badge>
              <p className="max-w-prose break-words text-muted-foreground">{check.detail}</p>
              {check.link && <Link to={check.link.to} hash={check.link.hash} className="underline">{check.link.label}</Link>}
            </dd>
          </div>)}
        </dl>
        <Details summary={current ? "Observed balances" : "Previously reported balances · refresh needed"}>
          <ul className="divide-y">
            {data.book.map(holding => <li key={holding.asset} className="flex flex-wrap justify-between gap-2 py-3">
              <span className="font-medium">{holding.symbol}</span>
              <span className="flex flex-wrap gap-x-4 gap-y-1 break-all text-muted-foreground">
                <span>Public {fromUnits(holding.public.toString(), holding.decimals)}</span>
                <span>Confidential {fromUnits(holding.confidential.toString(), holding.decimals)}</span>
              </span>
            </li>)}
          </ul>
          {data.book.length === 0 && <p>No managed balance rows were reported.</p>}
          <p className="text-muted-foreground">Amounts are in each row’s asset. Balances do not establish the amount available after held payouts.</p>
        </Details>
        </Details>
      </DemoStep>
      <DemoStep number={2} title={treasury ? "Preview and execute a rebalance" : "Request a real payment"}>
        {treasury ? <>
          <Link to="/automations" className="self-start text-sm underline">Review the allocation and strategy limits</Link>
          <Rebalance disabledReason={disabledReason} onExecute={setPlanId} />
        </> : <>
          <Card size="sm">
            <h4 className="font-medium">File an invoice as the payee</h4>
            <p className="max-w-prose text-sm text-muted-foreground">The agreed payee signs in on the configured invoice page and enters the actual amount and terms. Invoices require a policy with confidential transfers and owner approval. Return here to review the recorded payment; owner approval and payment completion are separate steps.</p>
            <InvoicePageLink />
            <Link to="/payees" className="self-start text-sm underline">Set up or review an agreement</Link>
            {executor && <>
              <p className="text-sm text-muted-foreground">A manual payment follows the reviewed policy. If owner approval is not required, funds may move immediately after you confirm.</p>
              <ManualPayment listed={new Set(data.agreed)} open disabledReason={disabledReason} onPayment={setPaymentId} />
            </>}
            {!executor && <p className="text-sm text-muted-foreground">{setup.executor === false ? "This instance is approve-only." : "This instance’s executor role is unconfirmed."} New payments are submitted by the invoice page’s executor; existing held payouts can be reviewed below.</p>}
          </Card>
        </>}
      </DemoStep>
      <DemoStep number={3} title="Follow the outcome">
        {treasury ? planId ? <>
          <p className="max-w-prose text-sm text-muted-foreground">Following the exact plan you confirmed. A finished execution stream does not prove every operation settled; earlier actions may have completed if execution stopped.</p>
          <DemoActivity planId={planId} />
        </> : <p className="text-sm text-muted-foreground">No plan selected in this walkthrough. Confirming execution selects that plan’s recorded operations here; opening or reloading this page submits nothing.</p>
          : paymentId ? <Payments title="Your payment" selection={{ payment: paymentId }} />
            : <p className="text-sm text-muted-foreground">No payment selected in this walkthrough. A submitted payment appears here when its response identifies it. For an invoice or earlier payment, choose its recorded entry below.</p>}
        {!treasury && <Details summary="Find an existing payment" open={!executor}>
          <Payments title="Find your payment" compact />
        </Details>}
        <p className="max-w-prose text-sm text-muted-foreground">An unresolved outcome needs review before another send. This walkthrough does not mark a payment or plan complete.</p>
        <Link to="/activity" className="self-start text-sm underline">Review all operations and recovery</Link>
      </DemoStep>
    </ol>
  </Section>;
}
