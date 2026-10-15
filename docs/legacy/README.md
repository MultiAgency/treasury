> Historical shared-workspace documentation. Retained for evidence and compatibility; this is not the Treasury product scope or its current runbook. Start at [README](../../README.md).

# Agentic Treasury

This is the standalone source checkout for **https://treasury.multiagency.ai**, copied from the verified Treasury release on 2026-10-15. It retains shared backend modules and regression tests from `proto`; the deployed interface is Treasury-only.

Quick start:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
PUBLIC_TREASURY_ONLY=true pnpm build:web
pnpm test
```

Use `PUBLIC_TREASURY_ONLY=true pnpm web` for frontend development. Server setup and credentials are described below; no production secrets or agent state are included here. Production uses `deploy/treasury.json` with self-service registration and persistent state on Railway.

Release: `07c31669-3ebe-4cc2-ba93-a87009e16c51`, Railway service `treasury`. Deployment is separate from local builds.

The following documentation also describes the inherited shared workspace.

An AI agent manages a treasury on [NEAR Intents](https://near.org/intents) through the
[NEAR Intents Agent API](https://api.agentsonintents.com/llms.txt), inside a policy its owner signed.
The owner can be a person's wallet or a Sputnik DAO, such as a [Trezu](https://trezu.org) treasury.

> Runs on NEAR mainnet with real funds. Use a low-value account and small amounts.

Two areas, each one agent owned by the same DAO, `agentic.sputnik-dao.near`. Each runs a brief from
the Agent Connect catalog and plans more:

| Area | What it shows | Details |
|---|---|---|
| **Payables** (Confidential Treasury Facilitator) | Anyone asks the DAO to be paid; agreements carry terms (contractor requests, purchase orders, bounty and grant awards); each payment is held for the DAO's vote and paid confidentially | [docs/facilitator.md](../facilitator.md) |
| **Treasury** (Agentic Treasury Management) | An agent rebalances toward a target on its own, quoting every swap, inside per-asset caps and a USD budget the DAO signed; idle funds stay confidential | [docs/treasury.md](../treasury.md) |

Each doc measures its briefs requirement by requirement (complete, tested, live) and lists what isn't covered.
The app shows the two running briefs and their evidence stages; additional roadmap briefs stay in those planning docs.

## How it works

- The **owner** signs a **policy**: allowed actions, assets, caps, budget, and where funds may go.
- The owner issues a **grant** that lets this server act for the **agent** inside that policy.
- The agent swaps, shields and pays through the Agent API and OutLayer, with application checks and
  provider-enforced limits. Output-asset enforcement is local; strict cumulative per-asset enforcement
  and USD-budget atomicity remain unproven. See the [enforcement assessment](../enforcement.md) for
  the evidence and remaining gaps.
- Every policy has a **mandate digest**: sha256 of its canonical JSON (`src/mandate.ts`), which anyone
  holding the policy can recompute. Every plan and every money action records the digest it ran under.
- The **books** compare public balances against the chain's
  `intents.near` transfers (FastNear's Transfers API), confidential ones against the API's recorded
  executions. Differences are unexplained: external credits, incomplete records or observation timing
  can cause them. This is not independent proof of confidential custody. `pnpm books` prints them,
  and `pnpm books --csv` exports the ledger.

How the money path keeps these safe (one send site, the journal, reconciliation, owner intents, invoice
storage and the checks before each send) is in [docs/architecture.md](../architecture.md#how-the-money-path-stays-safe-on-one-host).

## Run it

```sh
pnpm install
cp .env.example .env   # add an API key from https://partners.demo.agentsonintents.com
pnpm demo              # dashboard on http://localhost:8787
```

The dashboard walks you through creating an agent and issuing its grant, and runs every money action.
The command line has only what the dashboard doesn't: owner actions signed with a local key, and checks.

| Owner actions, signed with `AGENT_OWNER_PRIVATE_KEY` instead of a wallet or DAO vote | |
|---|---|
| `pnpm create-agent` | Creates an agent with the policy in `src/policy.ts` and saves `AGENT_ID` |
| `pnpm issue-grant [treasury\|payout\|invoices] [suffix]` | Issues a grant and saves its token |
| `pnpm revoke-grant [grant id]` | Lists live grants, or revokes one |
| `pnpm update-policy [--policy file] [--diff]` | Prints the change from the policy in force, then signs it without asking; `--diff` only prints |
| `pnpm archive` | Freezes, then archives the agent (reversible) |

| Checks | |
|---|---|
| `pnpm inspect [--whoami]` | The agent's policy, balances and grants, as the API returns them |
| `pnpm reconcile [--poll]` | Operations without a proven outcome; `--poll` reads their statuses once, resending nothing |
| `pnpm books [--csv]` | Balances against chain transfers and recorded executions; `--csv` prints the ledger |
| `pnpm smoke` | Read-only check of the hosted dashboard and invoice page |
| `pnpm run-report` | The unattended-run report ([operations](../operations.md#unattended-run-observing-the-treasury-autopilot)) |

## Hosted demo

Two pages run on Railway. Signing in with a NEAR wallet signs a message, never a transaction.

- **Dashboard**, https://proto.multiagency.ai: the treasury executor and a payout approve-only instance.
  Public pages explain the two areas and show requirement stages from the canonical inventory,
  with known limitations visible. The static public overview reads no agent records and
  submit no money actions. Members sign in to inspect their agents and owner actions.
- **Invoices**, https://invoices.multiagency.ai: the payout executor, where payees request agreements,
  file invoices and follow their existing payment identities.

The locally prepared workspace has Home, Payables, Portfolio (the Treasury area), and Activity.
These four destinations form a flat desktop rail and mobile navigation drawer. Area tasks appear in
the content: Payments and Agreements for Payables, Overview and Strategy for Portfolio. Funding and
policy are separate area utilities; Guided walkthrough is under Help. Shared Activity shows each agent's
returned operation, owner-action and run history, with scoped recovery and per-run detail links.
Payments combines invoice and payment discovery, with one selected record;
Agreements groups terms and separate policy inclusion by recipient. Saving a strategy opens its owner
authorization review; signing and enabling the schedule remain explicit actions. Rebalance previews
show estimated and minimum received amounts, with costs in percent. Sweep is in Balances & funding. Area identities and permissions remain
separate; balances are not combined. Payment approval and
payment completion are separate outcomes. Treasury strategy configuration, owner authorization and
schedule enablement remain separate decisions. Existing agent, payment and run URLs are retained.
Offline browser fixtures cover these interfaces; they have not been verified on the deployed hosts.
Overview retains known limitations and expandable evidence; activity history has one shared destination.
Individual run details and **Run now** remain reachable from Overview and Strategy. A selected run
uses one **Run timeline** for its recorded outcome, visible stage observations and later operation
outcomes. The original receipt, recording inspector and automatic-update controls are under
**Run details**. Starting another run follows the selected record.
Home offers **Run with real funds** inside each agent's **Guided walkthrough** disclosure; **Guided walkthrough**
under **Help** opens the same walkthrough. It summarizes prerequisite observations, reuses the real
rebalance or payment review controls, and follows the exact confirmed plan or returned payment. The hosted approve-only payout
instance directs invoice submission to the configured invoice service. Opening the guide submits
nothing; funds move only through the existing explicit actions and required owner approvals.
The landing page's **See how it works** link leads to the area explanations and requirement stages.
Fictional execution, approval and timed playback have been removed. Earlier example-page hashes
remain useful links to the corresponding area's static overview; they read no private records.
See [frontend responsibilities](../architecture.md#frontend-responsibilities-offline-tested) for
query, recovery and navigation behavior, [Payables](../facilitator.md) and [Treasury](../treasury.md)
for requirement evidence, and [DEMO.md](../../DEMO.md) for the walkthrough.

Install the pinned browser once with `pnpm exec playwright install chromium`; `pnpm test:browser`
builds the app and runs the offline browser suites. These intercept requests and start no executor.
`pnpm test:e2e` additionally runs an isolated application stack with simulated provider, chain and wallet boundaries.
`pnpm verify` runs the complete offline verification sequence. See [test boundaries and harnesses](../testing.md)
for credential isolation, live-test submission blocking, fixture contracts and failure artifacts.

Each agent in `deploy/dashboard.json` names its `owner`, and the gateway decides per agent who may see
it, from that owner at most a minute old. A wallet-owned agent admits only its owner account.
A Sputnik DAO's named group members may read private records. Their applicable Group and Everyone
permissions determine proposal and vote capabilities; public proposal rights alone never admit an outsider.
There is no configured operator list. Execution controls require both FunctionCall proposal and approval
permissions; local settings require both policy proposal and approval permissions. These are local
application permissions: they never replace the owner's signature, DAO approval threshold, signed policy
or live grant. The gateway and frontend share the same action checks. This mapping is offline-tested;
see [dashboard access](../architecture.md#dashboard-access-offline-tested) for its exact scope.
Anyone else is refused at sign-in. Signed out, the gateway lists only the DAOs' agents, which their
on-chain proposals already name; a wallet's agent is listed only to those who may see it. None of this
limits whoever runs the host, who can read every agent's state there. Both hosted agents are owned by the DAO; a wallet-owned agent behind the
gateway is tested offline only (`test/gateway-denial.test.ts`). On the invoice page anyone may sign in, but only payees in
the payout agent's policy file invoices; anyone else files an agreement request.

The demo walkthrough is in [DEMO.md](../../DEMO.md).

Deployment, executor migration and state preservation are documented in the
[operations guide](../operations.md#dashboard). Each agent requires one executor host; the local
lease does not enforce that across machines. Other instances use `EXECUTOR=off`.

## Two kinds of agent

- A **treasury agent** swaps between USDC, wNEAR and ETH toward a target, shields anything public,
  and, as an experiment reached only at `/steward`, can be steered by an LLM whose responses are verified
  against its TEE. No vote per action.
- A **payout agent** only transfers USDC, confidentially, to payees the owner agreed to. Every payout
  waits for the owner's approval. Approval verification checks the intended terms against the current
  policy; cumulative enforcement and the final signed artifact retain the provider dependencies
  described in the [enforcement assessment](../enforcement.md).

Each instance of the server runs one agent. To run a second beside the first, give it its own
settings file: `ENV_FILE=.env.payout PORT=8790 pnpm server`. It shares the API keys in `.env` but keeps
its own agent, grant and treasury, and each agent has its own action log in `.ops/`. The payout agent's
executor, which also serves the invoice page, starts with `ENV_FILE=.env.payout pnpm invoices`; any other
instance of an agent runs `EXECUTOR=off` ([operations](../operations.md#payout-executor)).

## Notifications

Each executor can tell the owner on Telegram when something waits for a person: a payment held for
approval, a money action still without a proven outcome after about five minutes (sends are paused
until it's reconciled; one merely in flight settles sooner), or the autopilot's open warnings and
decisions. It reads only the executor's own state, once a minute, and announces each item once while it
stays open, across restarts too (`src/notify.ts`). Messages name the agent and link to the page where the
owner acts on the item; they never carry amounts, payees or balances, since Telegram sees them.
Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (and optionally `NOTIFY_NAME`, `NOTIFY_LINK`) on the
executor's service; without them it does nothing.

## Invoices

The payout executor serves both the private dashboard and public invoice page through the same
grant, money lock and recovery loop. See [payout setup](../operations.md#payout-executor).

Anyone signs in with a full-access NEAR wallet key and files an amount and optional note for their
own account. An agreed payee's filing is an invoice; anyone else's is an **agreement request**, which is
never a payment. Agreements carry terms (an amount per invoice and a deadline), and the DAO can also
offer them first, as a purchase order or an award. Agreeing lists the payee in the policy by vote; the
payee then files the invoice, which is held for its own vote ([facilitator](../facilitator.md)).
The hosted dashboard reads the invoice host's agreements with a shared secret (`AGREEMENTS_URL`,
`AGREEMENTS_SECRET`; [operations](../operations.md#payout-executor)). Sign-in, storage, retries and
recovery are in [docs/architecture.md](../architecture.md#invoice-storage).

## DAO ownership

A DAO has no keys, but it can sign through NEAR's MPC network. The owner is an account whose only
key is derived from the DAO, so every owner action becomes a DAO proposal calling `v1.signer.sign`.
When the vote passes, the server picks up the signature and submits it. The Agent API needs no
changes. See `src/dao-owner.ts`.

The recorded DAO ownership checks and their evidence limits are in the
[demo verification table](../../DEMO.md#what-is-verified).

A confidential Trezu treasury funds its agent with a payment from its confidential balance to
`nearcom:<the agent's wallet account>`, which the Funding page links to. Without the `nearcom:`
prefix, Trezu sends the payment out as a public withdrawal.

## Mainnet evidence

Each area's doc maps every claim to how it is known: [Payables](../facilitator.md),
[Treasury](../treasury.md). Every dated mainnet run, with its DAO proposal numbers, is in
[docs/mainnet-log.md](../mainnet-log.md). Operation ids and amounts are kept in a private record, since the
treasury is confidential; they are available to reviewers on request.

The app and the area tables use one [canonical requirement/evidence inventory](../../evidence/inventory.ts).
Historical deployment checks and their limits are in the generated
[demo verification table](../../DEMO.md#what-is-verified). Edit the inventory, then run
`pnpm evidence:write`; `pnpm evidence:check` and `pnpm test` reject stale generated sections.
Record new mainnet observations in [the dated log](../mainnet-log.md), then reference that evidence
in the inventory. Keep private release details out of both. Walkthroughs link to these records instead
of maintaining separate requirement statuses.

## Not done yet

The isolated Treasury-only candidate adds optional self-service registration for regular NEAR accounts and Sputnik DAOs. It is offline-tested, not deployed or mainnet-verified. Registration prepares a private workspace; creating its agent still requires the owner-signature flow. Capacity, state preservation and rollout are described in [operations](../operations.md#optional-self-service-treasury-registration-isolated-candidate).

The guided walkthroughs are locally implemented and tested with offline browser fixtures, not verified
on the deployed hosts. They depend on existing permissions, configured services and retained records;
they cannot guarantee a swap, immediate owner approval, or settlement.

Sweep covers managed USDC, wNEAR and ETH only; it does not establish that other assets are confidential.
Campaign winner identity and prize validation are not built. The local duplicate check covers only
a manual payout matching an existing held payout; provider replay deduplication remains unverified.

- The local auto-execute ceiling now sums and compares the decimal representations of individual
  numeric USD estimates exactly (offline-tested, not verified on the deployed hosts). Raw-amount
  conversion, individual valuations and the earlier plan-preview total still use floating-point
  arithmetic; their precision limitations remain. Provider-enforced policy caps and USD-budget
  accounting are unchanged; see [enforcement](../enforcement.md).

- Payment recovery reads and owner-action discovery are locally implemented and offline-tested, not
  verified on the deployed hosts. Recent payout discovery scans at most 250 provider records and
  filters to the past day; incomplete scans are explicit. Original terms depend on provider/local
  retention, and owner actions are discoverable only on the instance holding their durable records.
  The dashboard withholds repeat signing while a recorded action is prepared or submitted; this is
  not a new cross-instance lock or a stronger payment-settlement guarantee.
  During setup failure, read-only Activity depends on the gateway continuing to authorize access.
  Unverified ownership after a cold gateway restart remains denied; retained records are not fresh
  provider outcomes. Setup recovery is locally tested, not verified on deployed hosts.

- The inline Treasury strategy workflow is locally implemented and offline/browser-fixture tested,
  not deployed or mainnet-observed. Accounts with settings permission edit allocations and limits, save with the schedule off,
  and explicitly enable only after the owner authorizes the saved strategy. Server controls reject
  stale reviews; stop does not require provider availability and prevents future scheduled ticks. A tick
  already started can submit further operations; submitted operations may finish. Configuration coordination is single-host,
  not distributed fencing; direct file edits and provider changes after a read remain outside it.
- Prepared-invoice continuation is locally implemented and offline-tested (`test/invoice-http.test.ts`),
  but not yet verified on a deployed host. It reuses the authenticated payee’s stored terms and operation
  identity; revised or submission-attempted invoices are refused. It does not resolve unknown outcomes.

- The AG-UI run-log adapter, private dashboard export and read-only recording inspector are offline-tested
  ([Treasury](../treasury.md#run-log-adapter-and-export-offline-tested)). The inspector steps through
  recorded observations, with each recorded stage's start and return grouped together and individual
  observations available on demand; it provides no timed playback or live stream. A missing stage
  return stays unknown even after a run end is recorded. New exports use envelope version 3 with
  AG-UI protocol 1.0 lifecycle validation: an unclosed stage or explicitly failed run ends with
  `RUN_ERROR`, not a fabricated stage completion. Versions 1/2 remain readable as legacy recordings.
  New ticks record intermediate
  stages and provider-accepted submissions for the polling run view; older ticks retain only their
  original evidence. See the [progress rollout](../operations.md#run-progress-rollout) before deployment.
  No real-recording or mainnet validation is claimed for these additions.

The [enforcement assessment](../enforcement.md#status) tracks the current evidence for the signed
spending envelope, including cumulative limits, policy binding and execution-artifact trust.
A provider `FAILED` status is currently treated as terminal locally; it is not independently verified
as proof that a replacement payment is safe. See [recovery guidance](../../DEMO.md#the-live-moment-one-invoice-end-to-end-facilitator).

- The API keeps signing requests open for 5 to 10 minutes, so a slow council misses the window.
- Trezu shows these proposals as a generic "sign on v1.signer", so a member voting there sees only a hash.
  The dashboard's "What am I voting on?" shows what each one does; check it there first.
- DAO delegate preparations sharing owner-intent storage on one host are serialized per owner and
  refuse while an earlier delegate submission is unresolved (offline-tested). Other hosts and signing
  clients are not coordinated; file those actions one at a time. See [enforcement](../enforcement.md).
- The policy's asset list limits what the agent spends, not what it buys: the wallet lets a swap into an
  unlisted asset through. This server refuses one before sending, but the wallet should enforce it.
- The owner can't verify the enforced policy: it is stored encrypted to the custody keystore, and the
  public `store_wallet_policy` takes no `agent_policy_hash`. The mandate digest is this server's own;
  the signed payload isn't shown to commit to it.
- Confidential credits from outside the API can't be attributed: nothing public indexes `intents.far`.
- A refusal says `policy_denied` without naming the rule that refused.
- An agent owned by a person's wallet was created and granted from a local dashboard on mainnet, and its
  autopilot then swapped under that grant on its own (2026-10-13, [mainnet log](../mainnet-log.md));
  behind the hosted gateway it is offline-tested only. Creating one signs a NEAR delegate
  action; the dashboard offers only the wallets HOT's near-connect list declares it for (today HOT, Meteor,
  Intear, Ledger and NEAR Mobile), read live; Meteor has signed through it so far.
- The owner's wallet picker loads HOT's near-connect wallet list from its `main` branch, unpinned, and each
  wallet's code from wherever that list points. The server checks every owner signature against what it
  prepared before relaying it, but a changed wallet could still phish for the owner's keys.
- Agreed terms (an amount per invoice and a deadline) are shown to voters beside each held payout;
  nothing refuses an invoice outside them.
- A DAO or other contract account can be paid, but can't ask to be paid on the invoice page: sign-in
  there needs a full-access key.
- The autopilot (off by default) hasn't yet run unattended for days. Outside the dashboard, its warnings
  reach the owner only through the optional Telegram notices (Notifications, above).
