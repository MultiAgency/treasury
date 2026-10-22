# Treasury machine interface v1

Shared authentication, delegation and access-management UI belong to Proto. This standalone candidate
is a reference for the owning session; see the [Proto handoff](proto-agent-access-handoff.md).

Offline-tested candidate; not deployed. The hosted gateway accepts expiring bearer credentials at
`/machine/v1/a/<treasury-name>/rpc/<procedure>`. This is Treasury's gateway interface to its existing
executor, separate from the upstream NEAR Intents Agent API. It does not expose the provider API key,
provider grant token, owner signatures, or a second executor.

## Provision and revoke

Sign in normally with your wallet at the intended Treasury host. Credential management uses that
browser session, never another machine credential. The configured area must be `treasury`.
A wallet-owned Treasury's credentials are issued by its established wallet owner, with fresh chain
and provider ownership evidence. A DAO-owned Treasury's are issued only on the DAO's own approved
proposal (see [DAO-owned Treasuries](#dao-owned-treasuries)): member permissions are not proof of DAO
consent, however strong. Current managers can list and revoke either kind.

Management endpoints return ordinary JSON:

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/gw/machine-credentials/<name>` | Issue with `label`, `scopes`, and optional `ttlSeconds` |
| GET | `/gw/machine-credentials/<name>` | List metadata, including issuer, scopes, expiry and revocation; no hashes or secrets |
| DELETE | `/gw/machine-credentials/<name>/<id>` | Revoke; any current manager of that Treasury may revoke |

For example, in the developer console of your already signed-in Treasury page:

```javascript
const response = await fetch('/gw/machine-credentials/treasury', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    label: 'Treasury assistant',
    scopes: ['read', 'prepare', 'execute-plan'],
    ttlSeconds: 3600,
  }),
});
if (!response.ok) throw new Error(`Credential issuance failed: ${response.status}`);
const issued = await response.json();
// Transfer issued.token to the machine client's secret store; it is returned only here.
// Retain issued.credential.id to identify or revoke this credential.
```

Select only the scopes the client needs. Default lifetime is one hour; allowed lifetimes are 60 seconds
through 24 hours. Renewal means issuing a new credential and revoking the old one. A bearer credential
authorizes whoever holds it: keep it in the client's secret store, outside prompts, skill files,
repositories and logs. Use HTTPS on hosted systems. Do not export a browser session to the machine.

## DAO-owned Treasuries

A Sputnik DAO consents to a credential by approving a proposal, never through a member's permissions.
Offline-tested; not deployed, and no interface files the proposal for the DAO: it is filed with the
DAO's usual tools.

1. **File a `Vote` proposal** (kind `Vote`, which executes nothing) whose description is the line
   `treasury-machine-credential/v1`, a newline, and one line of JSON naming exactly one credential:

   ```
   treasury-machine-credential/v1
   {"agent":"treasury","agentId":"<the provider agent id>","host":"treasury.multiagency.ai","label":"Treasury assistant","scopes":["read","prepare"],"ttlSeconds":3600,"issueBy":"2026-10-29T12:00:00Z"}
   ```

   `agentId` is the id in the Treasury's `instance`/`ownerIdentity` answer. `ttlSeconds` is the longest
   lifetime (60 to 86400); `issueBy` is the last moment the approval can be used to issue.
2. **The DAO approves it** by its own voting. Only status `Approved` counts; in-progress, rejected, removed,
   expired, moved and failed proposals do not, and neither does any kind other than `Vote`.
3. **A manager of the Treasury issues the credential** from a signed-in session, naming the proposal. The
   request must match the approval exactly: same agent, provider agent id, host, label and scope set, and a
   lifetime no longer than approved:

   ```javascript
   await fetch('/gw/machine-credentials/treasury', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ label: 'Treasury assistant', scopes: ['read', 'prepare'], ttlSeconds: 3600, proposalId: 41 }),
   });
   ```

The gateway reads the proposal from the chain; nothing in the request stands in for it. It refuses (403) a
missing `proposalId`, a proposal it cannot read, one that is not approved, not a `Vote`, older than 30 days,
past `issueBy`, or that differs from the request in any term, and refuses (409) an approval that already
backed a credential. One approval backs one credential, even if that credential is later revoked; another
needs a new proposal. The requester must also manage the Treasury, but that permission only lets them present
an approval, never replaces it.

On every call the gateway checks again, with no cached evidence: the owner is still a DAO, the provider agent
is the one the credential names and answers to the DAO's signing account, and the proposal on chain is still
`Approved`, a `Vote`, with the same description (pinned by a hash). Anything unreadable or different refuses
with 403 before forwarding. A DAO credential's authority is its approved scopes alone; no member's
permissions add to it, and it has no more reach than a wallet owner's with the same scopes. Revoke it like
any credential: `DELETE /gw/machine-credentials/<name>/<id>`, by any current manager. Revocation does not
cancel an operation already forwarded to the executor.

## Call the interface

Use POST with `Authorization: Bearer <token>` and JSON encoded using the existing oRPC wire protocol.
Do not send cookies or an Origin header. Browser-session authentication is not accepted on this path;
machine credentials are not accepted as dashboard sessions. There is no CORS opt-in.

This read-only example uses `TREASURY_MACHINE_TOKEN` from the client environment:

```javascript
const response = await fetch(
  'https://treasury.multiagency.ai/machine/v1/a/treasury/rpc/overview',
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.TREASURY_MACHINE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ json: null }),
  },
);
if (!response.ok) throw new Error(`Treasury read failed: ${response.status}`);
const { json: overview } = await response.json();
```

The host, workspace name and actual provider agent ID must match the credential. The canonical example above is a candidate
URL, not evidence that the interface is deployed. Gateway authentication failures are plain JSON
`{ error }`; upstream replies keep the existing oRPC envelope or event stream. Use the repository's
pinned `@orpc/client` version (`2.0.0-beta.43`) for streaming procedures:

```typescript
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { Router } from '../src/router.js'; // adapt to your checkout

const client: RouterClient<Router> = createORPCClient(new RPCLink({
  origin: 'https://treasury.multiagency.ai',
  url: '/machine/v1/a/treasury/rpc',
  headers: { authorization: `Bearer ${process.env.TREASURY_MACHINE_TOKEN}` },
}));
const preview = await client.rebalance(); // saves a plan; moves no funds
// Review the returned plan before a separately authorized execution call.
// executePlan({ planId }) and sweep({ execute }) return async event streams.
```

## Supported procedures and scopes

| Scope | Procedures |
| --- | --- |
| `read` | `instance`, `overview`, `policyHistory`, `strategy/get`, `autopilot/get`, `activity`, `unresolved`, `autopilot/evidence`, `autopilot/log`, `ledger`, `ledgerCsv` |
| `prepare` | `rebalance` (uses saved allocation targets); `externalPlan` (quotes chosen swaps and saves the complete plan; moves no funds) |
| `execute-plan` | `executePlan` with `{ planId }`, executing an existing saved plan |
| `sweep` | `sweep` with `{ execute: false }` to preview or `{ execute: true }` to shield managed public balances |

Scopes do not imply one another. No owner preparation/submission, policy/grant changes, settings,
schedule controls, arbitrary swaps/transfers, recovery, Payables or Invoices procedures are exposed.
The sweep preview is part of the sweep scope because the same procedure can shield funds.
Plan execution does not authorize sweeps, and sweep authority does not authorize plan execution.
Enabling schedules and manually starting autopilot ticks remain dashboard actions.

The v1 credential and scope contract is explicit; result types and event streams are the existing
Treasury RPC contract, not a separately frozen public SDK. External integrations should pin a
compatible Treasury revision and client version. A standalone public SDK remains a gap. The repository packages a [Treasury skill](../skills/treasury/SKILL.md) with a pinned Node client helper.

## Failure and evidence semantics

- Every call checks expiry/revocation, host, workspace and configured owner, then reads fresh chain
  ownership classification and provider identity after receiving the body. There is no machine fallback
  to the dashboard's cached ownership observations. Failed reads, a missing agent, DAO ownership,
  owner mismatch or a changed provider agent ID refuse forwarding. This is request-time evidence,
  not distributed fencing or a guarantee against changes after the check.
  Expiry and revocation are checked again immediately before attribution and forwarding. Revocation
  does not cancel an operation already forwarded to the executor.
- Successful authentication does not authorize a money operation. Existing policy, purpose, grant,
  plan, money lock and unresolved-operation checks still apply at the executor.
- Every accepted machine call is attributed before forwarding in `.machine-auth/access.jsonl` without
  request bodies or credentials. Preparation and execution also retain the existing intervention
  classification with a machine credential ID. Failure to retain either required record refuses forwarding.
- A saved plan is claimed at most once by the existing executor. A sweep is a fresh action per call,
  not a saved-plan execution. Do not automatically retry execution after a disconnect or unknown response;
  inspect retained activity and unresolved operations first. Ending a stream does not itself prove settlement.
- Authentication failure returns 401, scope/ownership/agent-identity/host-bound workspace denial 403, an unconfigured
  host 421, and unknown machine paths 404. Only POST is accepted for procedures (405 otherwise).
  Each valid credential is limited to 600 procedure requests per hour per gateway process (429).
  Restart resets this request limiter; it is not a spending control.
- Credential-file corruption, audit failure and other internal faults refuse with a sanitized 500.
  RPC requests are bounded to 16 KiB. Invalid issuance input returns 400. Upstream outages can return 502.

## State preservation and rollout

`.machine-auth/` is additive gateway state, created privately on first issuance. DAO credentials add a
`consent` field to their record and one file per used approval under `.machine-auth/consents/`; preserve
that directory too, because deleting a file there would let its approval back a second credential. A gateway
from before DAO consent cannot read records that carry `consent` and refuses their use; revoke or move
those records before rolling back. Existing money state needs no
conversion and no credential is issued automatically. New credential records use storage version 2 with
an actual agent ID and separate execution/sweep scopes. Earlier experimental version-1 records remain
listable and revocable, but authenticate as invalid. They are never upgraded into authority implicitly;
issue replacement credentials after reviewing the narrowed permissions. This compatibility needs no
rewrite of existing records. Preserve this directory along with all existing
state during backup, migration and deployment, with the gateway and executor writers stopped as described
in [operations.md](operations.md). Credential files use mode 0600 in a mode-0700 directory. Restore hashes,
expiry and revocation flags unchanged; restoring an old snapshot can restore a previously revoked credential,
so invalidate affected credentials before accepting requests after such a rollback.

One gateway process owns credential issuance and revocation; this is not distributed credential fencing.
Storage is capped at 1024 credential records. Archive expired/revoked records while stopped if needed;
removing a record invalidates that credential. No migration or cleanup should modify money records.
No deployment, real credential provisioning, or live execution is part of the offline verification.

Tests: `test/machine-auth.test.ts`, `test/dao-consent.test.ts`, the real-process gateway fixture in `test/gateway-denial.test.ts`,
and the legacy-host API boundary in `test/gateway-canonical.test.ts`. They cover credential hashing,
restart compatibility, expiry, revocation, scope/host/workspace isolation, current-permission denial,
owner-action exclusion, secret stripping, and refusal before forwarding on storage/audit failure.

## Verified authorization fixes

Offline regressions reproduced three failures in the initial candidate: a DAO council member could issue
credentials without DAO consent, a warmed ownership cache permitted calls during a failed live identity
read, and replacing the provider agent under the same workspace name retained credential authority.
The candidate now refuses DAO delegation without the DAO's approved proposal, requires fresh identity
evidence, and binds each credential to the actual agent ID. Plan execution and sweep permissions are also independent, with cross-scope
denials tested. These changes do not establish independent review, hosted acceptance, sender-constrained
credentials; those remain open. The DAO approval mechanism is offline-tested only: no DAO has used it, and no
interface files the proposal.

## External-strategy acceptance gates

Autonomous external-strategy execution with meaningful funds is not accepted. The candidate now
accepts an outside agent's chosen swaps through `externalPlan`. The packaged skill helper has completed
a real-gateway/real-executor flow against a simulated provider: prepare, execute the exact saved plan,
inspect its operation, reject repeated execution, and revoke access. This is offline evidence, not
hosted acceptance or proof of the deployed provider's spending guarantees.

| Gate | Required evidence | Current status |
| --- | --- | --- |
| External strategy to saved plan | An outside client submits chosen actions; Treasury validates and quotes every route and returns a plan bound to the agent, mandate and applicable strategy | Offline-tested external planner and skill-helper end-to-end flow |
| Exact authorized execution | The same client executes that plan through the real gateway and executor against an offline simulated provider; changed inputs, expired plans and missing authority refuse | Exact plan execution and replay refusal tested offline through the skill helper; broader fault acceptance outstanding |
| Failure and retry behavior | Lost responses, client/executor restart, duplicate requests and partial execution retain operation identity and block new sends when outcomes are unresolved | Existing executor fault tests; external-client acceptance still required |
| Delegation lifecycle | Outside-client acceptance covers scope isolation, expiry, revocation, ownership changes and credential rotation without replaying execution | Authentication boundaries plus external-client revocation tested offline; complete rotation/fault acceptance outstanding |
| Provider cumulative limits | Authorized isolated mainnet observations exercise per-asset caps and USD budget across concurrent grants/clients, including failure/recovery cases; deployed-version evidence identifies what was tested | Sequential asset-cap refusals and one USD concurrency trial observed; general enforcement unverified |
| Exposure claim | Explicitly distinguish turnover limits from holdings/market exposure; any exposure-bound claim needs its own defined valuation and enforcement mechanism | Spending caps do not bound market exposure; no exposure guarantee claimed |

Offline tests can establish our request ordering, authorization boundaries and failure handling. They
cannot prove that the deployed provider charges budgets atomically. A successful bounded mainnet trial
also establishes only its tested conditions. See [enforcement obligations](enforcement.md) for the
provider questions and existing observations. Additional live tests require explicit authorization;
none are implied by this acceptance plan.

## External chosen swaps

`externalPlan` accepts a strict object with `swaps`, one to eight entries of `{ from, to, amount,
minAmountOut? }`. Use managed USDC, wNEAR or ETH asset IDs, with positive atomic-unit strings of at
most 40 digits. Output assets must be allowed by the observed policy. Extra fields and self-swaps
are refused. A caller-supplied minimum can tighten, never lower, the provider's quote floor and cannot
exceed its quoted output. An unsuitable quote refuses the whole plan; no actions are silently dropped.
The server rechecks feasibility and policy/strategy/balance observations before saving. Execution
requotes and rechecks the saved plan using the existing controls.

External plans have `source: external`, an existing mandate/strategy snapshot, and the same five-minute
expiry and execution claim as other plans. Earlier `rebalance` and `steward` plans remain unchanged
and readable; this additive source needs no record conversion. Preserve `.plans/` and all other state.
The external agent chooses actions rather than adopting the saved allocation targets, but the owner's
cost limit, strategy digest and provider authority still constrain execution. External calls use the
existing Treasury plan-execution semantics, not scheduled autopilot: the schedule's per-run auto-execute
ceiling does not apply. Credentials have no separate per-client spending budget. Owners must understand
that distinction before delegating autonomous execution.

See [the skill's input contract](../skills/treasury/references/api.md) and
`test/external-plan.test.ts`. The real-stack scenario is in `test/e2e/workspace.spec.mjs`; it uses the
actual packaged `skills/treasury/scripts/treasury.mjs` helper against a simulated provider and wallet.
