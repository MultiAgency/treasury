# Test boundaries and verification

`pnpm verify` runs type checking, the offline Node suites, the production web build and offline
browser suites, the offline application E2E suites, then generated-evidence drift checks. It does not run live verification. Live checks
remain explicit and owner-authorized; passing fixtures does not establish deployed behavior.

## What earns a test

Each case must identify an important regression and assert its observable consequence. A failure
fixture must establish that the failing request or fault boundary was reached. Assertions over a
collection must establish that the intended controls or records exist; an empty selection is not a pass.

Keep exhaustive input and state combinations in the lowest layer that can prove them. Browser cases
own interaction, focus, rendering and query/cache wiring; E2E cases own real service, storage and
signing integration. Repeating a rule at another layer is justified only when it checks that layer's
distinct wiring or boundary. Preserve real-process crash, locking and restart cases.

Before adding a case, check its task suite for an existing stronger scenario. Extend that scenario
when it owns the same regression. Do not keep an extra browser journey for an assertion already made
there, or multiply behavior by viewport when resizing the resulting state proves the layout requirement.
Close scenario contexts and fail on unexpected browser errors. Test counts and file counts are not
coverage targets; the failure each case detects is the reason to keep it.

## Offline Node tests

`pnpm test` uses `scripts/test.mjs offline`. Discovery excludes the two registered live suites rather
than relying on missing credentials to skip them. The launcher retains basic operating-system
variables, supplies `test/offline.env`, and discards inherited application settings, credentials,
proxies and Node preloads. Its network preload blocks non-loopback Node TCP connections and fetches,
including in Node fixture subprocesses that inherit the environment. Local HTTP servers, Unix sockets,
real SQLite, files and crash/concurrency processes remain available.
For a targeted run, use `pnpm test test/source-analysis.test.ts`; explicit selections cannot include
live suites or files outside the registered offline tests.

This is a test-process guard, not an operating-system network sandbox. Do not introduce native
network clients or subprocesses that discard the guard without adding isolation checks. Per-test
provider mocks remain necessary to state exactly which observations and submissions are expected.

`freshDirectory` gives suites isolated state and removes the directories it owns after the suite.
Fixture builders provide valid starting evidence; scenario overrides must remain visible. Do not
repair missing identity, synchronization, freshness or authorization evidence behind a test's back.

Source-boundary checks parse TypeScript/TSX, including runtime re-exports and literal dynamic imports.
They reject non-literal module loading in inspected dependency graphs and constrain grant-factory
uses outside dispatch to direct, explicit dry quotes. These are structural regression checks, not a
proof against arbitrary program transformations. Money-path behavior is also tested with submission
counters, journals and real crash/restart fixtures.

## Offline browsers

Install the pinned Chromium with `pnpm exec playwright install chromium`, then run
`pnpm test:browser`. To repeat selected suites against an existing build, use
`node test/browser/run.cjs payments.cjs` (substitute the desired suite names).

The task suites group navigation, payment review, agreement terms, funding, invoice filing,
strategy authorization, setup and run-history checks. For example, `payments.cjs` owns queue,
invoice-detail, payment-recovery and owner-decision scenarios; `invoices.cjs` owns the payee's
filing, draft, refresh and session-expiry journey. Access-boundary and harness suites remain separate.

Merged suites share one browser and close all contexts between scenario groups. Workspace routing
and invoice-page rendering are shared fixtures; each scenario retains its explicit response evidence.
Payment, setup, history-filter and run-recording scenarios run at one width. The layout helper
resizes an already loaded state at 320, 390 and 1280 pixels; navigation journeys retain mobile and desktop modes, and the wallet-header checks retain
long account names and enlarged text. New coverage belongs with its task, with extra viewports only
when the interaction or layout depends on width.

The shared browser fixture blocks service workers, unhandled requests and WebSockets. Scenario routes
provide explicit responses; the shared RPC dispatcher rejects undeclared procedures, including writes.
An explicitly declared `undefined` remains valid for a void procedure. A fixture-handler error fails
the process even if the application or scenario catches the resulting request error.

Each run creates `.test-artifacts/browser/run-*/manifest.json` and `results.json`, with the Node version,
asset/source/fixture/lockfile hashes, suite results and durations. Successful suites discard their
traces. Failed suites retain available traces, screenshots and fixture errors; the runner also keeps
its captured source, fixtures and built assets. A hard process timeout may prevent trace finalization.
Artifacts are ignored by Git. The hashes identify what was tested; they do not prove that an existing
build was generated from the current source. Use `pnpm test:browser` to rebuild before verification.

The browser fixtures are UI integration tests with simulated transport. They do not run the deployed
gateway or provider, and their passing results do not establish live authorization or settlement.
Some intentionally partial response fixtures remain scenario-local; the strict dispatcher checks
procedure ownership, not every response's runtime schema.

## Offline application E2E

`pnpm test:e2e` snapshots source and builds it in an isolated artifact directory. It runs the real
gateway, approve-only agent, payout executor and invoice listener against loopback provider/chain
fixtures and an injected test wallet. Application RPC and invoice responses are not intercepted.
The Node network guard and browser request allowlist exclude external services. Its fixture keys,
sessions, SQLite stores and logs belong only to the test environment. It exercises approval versus
settlement, retained invoice identities, restart recovery after an accepted transfer loses its response,
lost owner-signature response recovery, and approve-only refusal. It does not establish real provider,
chain or wallet behavior.

Each run retains source/build/lockfile hashes, Playwright results, traces, screenshots, service logs
and database observations under `.test-artifacts/e2e/`. `pnpm verify` includes this suite once;
its isolated build is separate from the UI fixture build. Both must come from the same fixed revision.

### E2E boundaries and agent-browser exploration

The SDK calls a local HTTP provider simulator; a local NEAR RPC fixture supplies owner classification
and test-key membership. Each case uses fresh storage, a fresh agent identity and a test grant.
The approve-only instance also receives a valid local grant: its refusal must come from executor
enforcement, rather than a missing credential masking a broken guard.
The runner requires OpenSSL on PATH and the installed Playwright Chromium browser.
Two HTTPS origins exercise cookie separation and same-origin writes. Certificates are self-signed
and trusted by the test browser only; this does not test deployed certificate trust or proxy configuration.

The wallet adapter uses near-connect's injected-wallet interface and real NEP-413 signatures from
an unfunded fixture key. The invoice page's CDN connector import is served from the installed package,
and external wallet manifests are replaced with an empty list. Application sign-in challenges,
signature verification, session cookies, permissions, dispatch, owner-intent records and invoice
SQLite transactions run unchanged. This does not verify a real wallet extension, NEP-366 signing,
a DAO vote, provider enforcement, or actual settlement.

The initial cases cover:

- An invoice becoming held, wallet approval through the approve-only dashboard, a distinct processing
  outcome, simulated settlement, reservation release, and record preservation across executor restart.
- A transfer accepted by the simulator with its response dropped: uncertainty and reservation survive
  restart; repeating the same identity does not resend; editing the retained draft requires review;
  a new identity remains blocked; the approve-only instance refuses a money action.
- An owner signature accepted with its response dropped and outcome evidence withheld through reviewer
  restart: the durable action remains submitted, the page warns against signing again, and neither
  the wallet nor provider receives another signature submission. Restoring evidence records approval;
  settlement remains separate until the simulator reports success.
- A retained submission's uncertainty warning stays beside the form after reload. This frontend
  regression was found through agent-browser exploration of the same stack. Draft memory is not
  evidence of a provider outcome, and the notice says so without claiming the payment failed.

The tests compare browser output with read-only SQLite queries, durable owner-intent records and an
independent simulator request log. Restarts here are controlled process restarts after a lost response,
not abrupt termination during a submission. Existing child-process fault tests retain their separate
crash coverage. The simulator deliberately does not deduplicate submissions: any second submission
is observable and fails the test. Its behavior is authored test evidence, not a provider specification.

The runner sanitizes its environment and installs the offline Node network guard in application
children; browser routing blocks unexpected external requests and WebSockets. Unknown simulator
requests fail the suite even when the app catches the response error. This is process-level isolation,
not an operating-system network sandbox. Do not supply live secrets to these workflows.

Results live under `.test-artifacts/e2e/run-*`: the source/build snapshot, manifest, Playwright results,
traces, screenshots, process logs, simulator requests and retained storage. The manifest identifies
source, assets, evidence, tests, lockfile and tool versions; Chromium's version is recorded with each
case. Retries are disabled. Traces from the original attempt are retained even on success. These
artifacts contain only fictional local data but should remain untracked.

`pnpm test:e2e:explore` builds the same isolated stack and keeps Chromium open for agent-browser.
Its `exploration/session.json` prints the loopback CDP endpoint, application URLs, and fixture account.
Attach with `agent-browser --session proto-e2e --cdp <endpoint> snapshot -i`, then use ordinary browser
actions. Pass `--owner` to explore as the wallet owner. This adapter cannot submit chain transactions.
Create `exploration/drop-response` to drop the next simulator transfer response; create
`exploration/stop` to capture the final trace and stop the local processes. These controls are files
outside the application, not test-control HTTP routes. Close the agent-browser session afterward.

This suite does not cover all DAO roles, scheduled tick execution, arbitrary provider outages,
or production canaries end to end. Existing narrower tests cover parts of those behaviors; they must
not be counted as full-stack production observations. Deployed verification and money actions remain
separately owner-run.

### Challenging the E2E assertions

`pnpm test:e2e:challenge` first discovers the complete baseline from its isolated source and requires
every discovered case to pass once without skips or retries. The retained `baseline-list.json` is
matched against the results by case and project identity, so added cases cannot silently be omitted.
It then creates three separate disposable copies of that tested snapshot and deliberately introduces
one fault into each: duplicate transfer submission, a premature Paid invoice label, or removal of the
approve-only dispatch guard. It rebuilds each copy and runs the relevant journey. Working application
files and the baseline snapshot are not edited. This optional command is separate from `pnpm verify`.

A challenge counts as detected only when the named assertion fails and independent simulator/storage
evidence confirms that fault was exercised. Build failures, timeouts, unexpected simulator errors,
skips, and unrelated test failures do not count as detections. The command fails if any fault survives
or the experiment is invalid. Exact mutation anchors must match once; changed source requires review
of the experiment rather than silently choosing another edit.

The run retains `challenge-results.json` plus each fault's `mutation.json` with source hashes, mutated
snapshot, build/test logs, Playwright report and ordinary E2E evidence. These experiments demonstrate
sensitivity to these three particular regressions; they are not exhaustive mutation coverage or
evidence of production correctness.

## Explicit live verification

`pnpm test:live` requires `NEARAI_API_KEY`, `NEAR_INTENTS_AGENT_API_KEY`, `AGENT_ID` and
`AGENT_GRANT_TOKEN` from the configured environment/settings. Missing configuration fails before
tests start. Live files refuse direct execution outside the live launcher and no longer silently skip.

The attestation cases contact NEAR AI Cloud. Plan-refusal cases read current account/provider evidence
and request dry quotes. A test-owned fetch barrier, loaded before the SDK, permits Agent API reads
and exact `dry: true` swap requests, and refuses other Agent API writes before transport. Blocked
attempts fail the process even if their errors are caught. Empty-operation-log assertions remain as
an additional check. The barrier is tested offline against the actual SDK and a fake transport.

These cases do not verify successful money submission or settlement. Any future test intended to
submit requires a separately named, explicitly authorized workflow; do not disable this barrier to
make a refusal test pass. Test results describe the observed run, not the identity of a future provider
deployment. Deployed smoke checks and recorded mainnet observations retain their separate scopes.


## Candidate and deployed verification

`pnpm verify:candidate` captures all Git-visible files, including uncommitted changes, into an isolated
source directory and runs the complete `pnpm verify` pipeline there. The manifest records the base
commit, per-file hashes and modes, and a combined source hash. It rejects edits during capture, checks
that captured source remains unchanged after verification, and reports whether the working tree still
matches. It neither stages changes nor commits, deploys, restarts or changes live settings. Existing
`node_modules` is shared; keep dependencies fixed during the run. The workspace disables pnpm's
automatic pre-script installation; install dependencies explicitly before capturing source. The
dashboard build fixture invokes the bundler directly and checks that shared launchers stay unchanged.
This is a tested source snapshot,
not a frozen Git release: reconcile review findings and identify the final release commit before shipping.
Logs and nested browser/E2E artifacts remain under `.test-artifacts/candidates/candidate-*`.

Release acceptance requires a passing result with both `snapshotUnchanged` and
`workingTreeStillMatches` true. Then run `pnpm test:e2e:challenge` from that candidate's `source/`
directory, with the same dependencies and runtime. Its baseline and disposable fault copies must
descend from that captured source, not the current checkout. Require all baseline cases and all three
designated fault detections, then recheck the candidate files. Any source correction requires a fresh
candidate and challenge run. Match the release commit's complete file set, contents and executable
modes to the manifest, and retain the full commit, source/archive hashes and results privately before
the owner deploys. A passing snapshot whose working tree differs is not a releasable working tree.

The workspace E2E cases use a separate Portfolio executor, provider identity and store alongside the
Payables executor and approve-only server. They cover full-document cross-agent navigation and back,
wallet ownership per agent despite ignored legacy operator configuration, forbidden direct reads and settings writes, strategy save with the
schedule off, stale save/authorization/enable refusal, actual local grant signing, explicit enablement,
and stopping after a declared provider outage. Database/provider records and persisted settings support
browser assertions. They do not establish DAO role coverage or scheduled money execution end to end.

Before calling a candidate deployed-verified, complete this checklist in a private release record:

1. Record the candidate source hash and full pipeline results. Resolve the other review session's
   findings; any source change needs a new candidate. Match the final commit/source archive to the
   tested files. Follow the existing [owner-run rollout](operations.md#owner-run-rollout).
2. Record UTC time, deployment ID and source/image identity separately for `dao` and `invoices`.
   Obtain these from deployment records; `/health` and asset names alone do not identify source.
   Establish that both services use the reviewed candidate. An unknown deployed revision remains unknown.
3. Run `DASHBOARD_URL=https://proto.multiagency.ai INVOICES_URL=https://invoices.multiagency.ai pnpm smoke`.
   Without an authenticated session this covers public health, headers and access boundaries only.
4. In an authenticated browser, inspect existing Payments, Agreements, Strategy, Runs and Activity.
   Check cross-agent navigation/back/reload, retained recovery wording, owner decision versus payment
   outcome, and keyboard/mobile layouts at 320, 390 and 1280 pixels. Record empty views and unavailable
   evidence as such. Do not populate views by creating invoices, approving payments or starting runs.
   Some page reads refresh retained observations; view-only inspection is not a storage-immutability claim.
5. Keep screenshots and account/payment details in restricted private artifacts, separate from offline
   fictional fixtures. Record failures and authentication blockers; a local mock cannot replace a hosted
   observation. Do not export cookies to enable browser access.
6. Money verification is a separate owner-authorized operation. Retain its reviewed policy/strategy
   binding, operation identity, provider correlation, owner action where required, terminal provider
   outcome and durable records. Approval is not settlement. Unknown outcomes remain unresolved; never
   retry with a new identity merely to obtain a passing result. Do not test crash/restart faults live.
