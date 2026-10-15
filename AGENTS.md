# NEAR Intents prototypes — agent guide

An AI agent moves a DAO's or wallet's funds on NEAR Intents mainnet, only inside a policy the owner
signed. The product is **credibility**: a reviewer must be able to check every claim we make. Real
funds move; treat every change near the money path as a change to a bank.

Vocabulary is in `CONTEXT.md`: use its terms in code, tests, docs and conversation (owner, executor,
policy, grant, purpose, authorization, operation, unresolved, held payout, refusal). Read it first.

## Where things are
- `README.md` — what runs, how to start it, the three-idea repository scope, and **Not done yet**.
- `docs/treasury.md` — brief 02 requirements, evidence and gaps.
- `docs/scope.md` — domain responsibilities, implementation status and open topology decisions.
- `docs/legacy/` — retained Payables/workspace evidence and roadmap briefs; ideas 1 and 3 remain in scope.
- `docs/architecture.md` — which files are shared core, facilitator or treasury; the one send site; how
  the money path stays safe on one host (journal, reconciliation, checks before each send, invoices).
- `docs/operations.md` — deployment, executor migration, state preservation, the unattended-run report.
- `docs/enforcement.md` — what the signed policy guarantees today, how each part is known, and what a
  stronger claim needs (threat model, obligations, open cases, provider questions).
- `docs/mainnet-log.md` — every dated mainnet run, with proposal numbers; op ids and tx hashes are in the private release record.
- `DEMO.md` — the hosted walkthrough (kept out of the app so copy edits do not require a deployment).

## The money path
Files: `src/agent.ts` (dispatch), `authorize.ts`, `lock.ts`, `ops.ts`, `plans.ts`, `treasury.ts`, `autopilot.ts`,
`invoices.ts`, `invoice-store.ts`, `payouts.ts`, `payment-approval.ts`, `owner-intents.ts`,
`owner-requests.ts`, `owner.ts`, `recover.ts`, `reconcile.ts`. Invariants every change keeps:
- **One send site.** Every submission (dashboard, CLI, invoice, autopilot) goes through `dispatch`:
  under the money lock, no unresolved operation, write-ahead record, then send.
  `test/send-path.test.ts` enforces it.
- **Fail safe.** An unknown outcome stays unresolved and blocks new sends; it never authorizes
  another send. Ambiguous replay stays blocked. Missing evidence refuses; it is never trusted.
- **Provider-first.** The provider enforces the policy; `authorize.ts` adds only checks the provider
  can't make (policy in force, live grant for the purpose, output asset, duplicate held payout, plan
  binding). It is pure: no fetch, send, record or `Date.now()`. Ask before adding a rule there.
- **One executor per agent.** Any other instance runs `EXECUTOR=off` (approve-only: reads and
  approves, never sends). The lease is single-host, not distributed fencing; say so where relevant.
- **Approvals are verified from provider evidence** and re-checked right before signing; an attempted
  owner signature is poll-only after restart, never resubmitted.
- **Mandate digest** (`src/mandate.ts`) is recorded with every plan and money action.

## Live systems
- Treasury host: https://treasury.multiagency.ai, Railway service `treasury`, one replica, state on `/data`.
  This repo also owns idea 1 at payables.multiagency.ai and idea 3 at invoices.multiagency.ai.
  Proto is the umbrella showcase for all three ideas and must not redirect to Treasury.
  Host/service mappings are recorded in docs/scope.md; intended destinations are not deployment evidence.
- Deploys, restarts and dashboard money actions are the user's. Prepare and verify; let them ship.
- Signed-out destination pages show their ideas and requirement stages, never the evidence,
  and read nothing from the server: no balances, amounts, payees, policies, invoices, roster or
  proposals. `test/public.test.ts` pins the inherited public boundary; Treasury browser fixtures check no private reads.
- `pnpm test:live` moves or touches real funds: run only when asked, never scheduled. `pnpm smoke` checks the Treasury host read-only; legacy invoice checks require an explicit `INVOICES_URL`.
- An unattended run or freeze may be in progress: ask the user before editing money-path files.

## Calibrated claims

`evidence/inventory.ts` is the canonical requirement/evidence inventory. The app imports it;
`pnpm evidence:write` generates the area tables and DEMO verification section. Do not hand-edit
generated sections. Record dated observations in `docs/mainnet-log.md`, reference them in the
inventory, then regenerate. README and walkthroughs link to the canonical presentations.
`pnpm evidence:check` and `pnpm test` reject generated-document drift.

Every sentence in README, DEMO.md and docs states exactly what was shown, and how:
- Mainnet facts cite evidence: date (UTC), proposal number, deployment id. Op ids, tx hashes, amounts,
  payees and the DAO's caps and budget stay in the private release record, never in tracked docs.
- Distinguish *offline-tested*, *mainnet-observed*, *per provider docs/source (pinned commit)*, and
  *unverified*. A deployed provider version is never assumed from its source.
- A newly found gap goes into **Not done yet** or `docs/enforcement.md` in the same change.
- A claim the code no longer supports is fixed or removed in the same change.

## Product focus
- Ordinary builds, development and Docker images use Treasury. `PUBLIC_TREASURY_ONLY=false` selects the shared Payables/Portfolio UI and regressions.
- Payables (idea 1) and Invoicing & Purchase-Order Management (idea 3) are active repo responsibilities. Keep their flows separate from the focused idea-2 Treasury demo; do not expand features during documentation cleanup.
- Steward remains a hidden experimental demo feature at `/steward`; keep it out of navigation and retain explicit plan execution.
- Exact public-payout unshielding is a brief-02 gap, not an implemented Payables flow.
- Shared backend compatibility code is retained deliberately. UI route hiding does not restrict server authorization.

## Working here
- Other sessions edit this repo concurrently. When files change unexpectedly, check which sessions
  are active and ask the likely owner before editing or attributing; agree on file ownership.
- Designs already confirmed with the user (authorize, journal, owner-intents) are built as recorded;
  settled questions stay settled.
- Reproduce before fixing: a failing test, an offline fault test, or recorded mainnet evidence.
  Provider behaviour is a hypothesis until observed or found in pinned source.
- Tests are offline by default (`test/offline.env`). Crash and concurrency tests use real SQLite and
  child processes; keep them that way.

## Done means
- `pnpm typecheck` and `pnpm test` pass; new money-path behaviour has a test that fails without it.
- `CONTEXT.md` updated when a concept is added or renamed.
- README/DEMO/docs claims match the change (see Calibrated claims).
- State-format changes ship with a migration that requires a stopped executor and preserves
  `.ops/`, `.invoices/`, `.owner-intents/`, `.strategy/`, `.plans/`, `.evidence/`, `.inbox/`, `.agreements/`, `.notify/`.
  Additive optional records that need no conversion of existing state (such as run progress) need
  compatibility tests and preservation instructions, not a directory-creation migration.
