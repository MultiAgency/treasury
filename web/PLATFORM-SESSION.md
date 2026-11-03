# Notes for the platform session

What the Treasury owner UI (`web/`) changes for the platform's release candidate and its E2E specs. "A" is the prototype's build (MultiAgency/treasury-prototype `web/` at `d999861`); "B" is this app's build. Each feature PR adds its rows here, in the same change that alters a name.

## Accessible names

Kept, with the same role, name and meaning:

| Name | Role | Specs that query it | Since |
| --- | --- | --- | --- |
| Connect wallet | button | treasury-migration, shared-reader, account-switch | step 1 |
| Wallet: `<account>` | button | account-switch (`/^Wallet: /`) | step 1 |
| Disconnect | menuitem | account-switch | step 1 |
| Treasury owner | region | | step 1 |
| Back to overview | link | | step 1 |
| Treasury unavailable | heading | | step 1 |
| Access unavailable, Check access again, Return to Home | heading, button, link | | step 1 |
| Dashboard unavailable, Retry | heading, button | | step 1 |
| Setup unavailable, Retry setup | alert text, button | | step 1 |
| Skip to main content | link | | step 1 |
| Freeze, Unfreeze, Connect to freeze, Connect to unfreeze, Propose to freeze, Propose to unfreeze | button | | #6 |
| Follow owner action, Review and vote in Trezu | link | | #6 |
| Owner actions, Refresh owner actions | heading, button | | #6 |
| Owner action reference, Copy | disclosure, button | | #6 |
| Schedule, Turn off | heading, button | workspace (`Turn off`) | #6 |
| The review dialog (`ConfirmButton`), its Cancel | dialog, button | workspace (`dialog`) | #6, mounted by #7, #10 and #11 |
| Unresolved operations | heading (and text) | treasury-migration | #8 |
| New sends are blocked by `<n>` unresolved operation(s). | status text | treasury-migration | #8 |
| Resolving it is a separate step that needs the owner’s authorization. This page cannot clear, retry or replay it. | text | treasury-migration | #8 |
| Check operation outcomes | button | | #8 |
| Operation status results | list | | #8 |
| Operation history, Books | heading | | #8 |
| Idempotency key, Operation reference, Recorded policy revision `<n>`, Outcome details, When an outcome stays unknown, Compare balances with records, Export | disclosure summary | | #8 |
| Ledger CSV | button | | #8 |
| Review existing operation records | link (setup unavailable, off Activity) | | #8 |
| Retained records remain available. Current provider outcomes are not confirmed here. | status text | | #8 |
| Treasury overview | heading (level 1) | | #7 PR 1 |
| Schedule status | region | | #7 PR 1 |
| Schedule: `on · every <n> minutes`, `off`, `checking…` or `unavailable` | status | | #7 PR 1 |
| Turn off schedule | button (while the schedule is on or unconfirmed): #6's stop, as "Turn off" sends it, enabled and explained as "Turn off" is ("Your account cannot stop the schedule.", "Checking executor identity…", and so on) | | #7 PR 1 |
| Book value, Budget or `<period>` budget left, Held privately | figure labels | | #7 PR 1 |
| Allocation, Signed limits | heading (level 2) | | #7 PR 1 |
| USD budget windows | table, with row headers Daily, Weekly, Monthly | | #7 PR 1 |
| Edit policy | link | | #7 PR 1 |
| Treasury tools: Set targets and schedule, View treasury runs, Balances and funding | navigation, links | | #7 PR 1 |
| View activity | link | | #7 PR 1 |
| Review recorded refusals | disclosure summary, under Signed limits; its rows are Activity's, with "Refusal code: `<code>`" | | #7 PR 1 |
| Strategy | heading (level 1, the page's title) | workspace | #7 PR 2 |
| Targets and schedule | heading | | #7 PR 2 |
| Schedule on, Schedule off, Schedule unknown; Readiness unknown, Blocked, Ready for scheduled runs, Off · strategy authorized, Needs owner authorization | badge text | | #7 PR 2 |
| Turn off | button (while the schedule is on or unconfirmed): #6's stop, enabled and explained as #6's "Turn off" is | workspace | #7 PR 2 |
| Configuration, authorization and schedule; Swap limits; Grant renewal; Strategy digest | disclosure summary | | #7 PR 2 |
| Strategy setup | list | | #7 PR 2 |
| Saved configuration, Owner authorization, Schedule control | region | | #7 PR 2 |
| Saved configuration or Strategy draft, Owner authorization, Schedule | heading | | #7 PR 2 |
| Edit strategy | button, then heading of the editor | workspace (button) | #7 PR 2 |
| USDC (%), wNEAR (%), ETH (%) (each `<symbol> (%)`), Run every (minutes), Automatic rebalance ceiling (USD), Minimum swap (USD), Maximum swap cost (%) | textbox labels | workspace (the targets and Run every) | #7 PR 2 |
| Target allocation · total 100% | group (fieldset legend) | | #7 PR 2 |
| Cancel, Save with autopilot off | button | workspace (Save with autopilot off) | #7 PR 2 |
| Review against latest strategy | button (after the saved strategy changed under the draft) | | #7 PR 2 |
| Review authorization, Review grant renewal, Cancel review | button | | #7 PR 2 |
| Authorize this saved strategy, Renew the grant for this saved strategy | heading | workspace (Authorize this saved strategy) | #7 PR 2 |
| Authorize in wallet, Renew in wallet, Propose strategy authorization, Propose grant renewal | button | workspace (Authorize in wallet) | #7 PR 2 |
| Review the policy’s caps and budget, Review owner action, Follow treasury runs, Review grants and permissions, Run autopilot once or review recorded runs → | link | | #7 PR 2 |
| Turn on | button, and its review dialog ("Let the agent act on its own?") with Cancel and Turn on | workspace (button, `dialog`) | #7 PR 2 |
| Strategy saved. Schedule off; review authorization before enabling.; Schedule enabled. Operation outcomes are reported separately. | status text | | #7 PR 2 |
| Current state, Allowed actions, Owner controls, Grants, Policy evidence | heading (level 2) | | #10 |
| Current policy and grant observations | region | | #10 |
| Edit, Review changes, Sign update, Propose in Trezu, Cancel, Compare draft with current policy | button (the policy editor) | | #10 |
| What the agent may do, Caps per asset | heading (level 3, the policy editor) | | #10 |
| Swap between its assets, Every payment waits for the owner's approval, Allow any asset, `<symbol>` | checkbox | | #10 |
| `<symbol> <window>` cap (window: per payment, per hour, per day, per month), USD budget a day, a week or a month, Actions an hour | textbox; while a field is invalid its error is inside its label, so its name is followed by the error, as in A | | #10 |
| Rate and confidentiality, Issue or renew a grant, Ended grants (`<n>`), Mandate digest and revisions | disclosure summary | | #10 |
| Stop the schedule, Freeze the agent, Unfreeze the agent | heading (level 3, under Owner controls) | | #10 (Freeze the agent and Unfreeze the agent: #6, at level 2 until #10) |
| Review schedule controls, Review strategy authorization | link | | #10 |
| Live grants | list | | #10 |
| Revoke, Connect to revoke, Propose to revoke | button | | #10 |
| Revoke the current grant?, its Revoke | dialog, button | | #10 |

The Activity page's text comes from the prototype's A8 (`send-block`) change, which exists only uncommitted in `dao/treasury`'s working tree, not at `d999861`: `BlockedSummary` and `blockedBy` (`src/shared/send-block.ts`), and its wording of a replacement as an "operation", not a "payment". `/does not establish that nothing was sent/` stays in `Activity`'s per-plan view, which the portfolio's plan outcome uses (#7); the treasury-migration spec asserts it absent after a refusal before sending.

Added: each page has an `<h1>` with its title (Strategy, Runs, and so on), placeholder or ported (Activity: "Operation status"). In A, only the Overview ("Treasury overview", kept) and the guided run had one.

Page titles are unchanged: `Treasury · <page>`, with the prototype's page names (Overview, Strategy, Runs, Balances & funding, Policy & grants, Guided walkthrough, Operation status).

Changed or not present yet:

| Where | A | B | Until |
| --- | --- | --- | --- |
| Signed-out home | Proof flows ("What Treasury does", "What has been demonstrated", "Known limitations"), the "What works today" and "View requirements" disclosures, and the "NEAR Intents resources" region | Brand, the headline ("Your treasury. Your limits."), the "Get started" region and Connect wallet only. The rest was showcase (`public/`), which the brief leaves behind | Permanent |
| Setup unavailable | The retained-records task (operation status, run timeline) below the alert | The alert and "Retry setup"; on `/automations` the "Schedule" section with "Turn off", and on `/activity` the retained records (unresolved operations, owner actions and operation history), as in A; elsewhere a "Review existing operation records" link to `/activity`. Records already loaded stay shown when a later setup read fails | #9 (run): the run timeline on `/follow/run` |
| An agent not yet created | Onboarding | Status text: "This Treasury agent hasn't been created yet." | #12 (creation) |
| A self-service host's root | Treasury creation | A "Your treasuries" heading with a link per treasury agent | #12 (creation) |
| Every page under `/a/<agent>/` but the Overview, Strategy, Activity and Policy & grants | The page | Text: "`<page>` moves here from the Treasury prototype, one feature at a time." So no spec query on those pages passes until its feature lands | Each feature's issue: #7, #9, #11, #12 |
| The frame on a failed read, on `/automations` and `/follow/run` | Those pages' own "Turn off" | Not offered once the page is shown: the frame leaves those two pages to their own control, as in A. Strategy's own "Turn off" is there; `/follow/run` is a placeholder | #7 PR 4 (runs) |
| Strategy's heading levels | The page's "Strategy" (`h2`, a section), "Targets and schedule" (`h3`), its sections and the review's heading (`h4`), and the editor's "Edit strategy" (`h3`) | "Strategy" is the page's `h1`; "Targets and schedule" `h2`, its sections `h3`, and the review's heading and "Edit strategy" `h4`. Names unchanged | Permanent |
| Strategy's "Preview a manual rebalance on the overview" link | Shown | Not shown: the overview has no rebalance yet | #7 PR 3 |
| The frame on a failed read, on the Overview | The frame's "Schedule" section ("Turn off") beside the Overview's "Turn off schedule" | Once the Overview is shown, only its "Turn off schedule"; before the overview first loads, the frame's "Turn off" | Permanent |
| Signed limits' caps | "Per-asset monthly caps": the monthly window only, an asset outside the book in raw units | "Per-asset caps": every window the policy signs (Per transaction, Hourly, Daily, Monthly), each "`<window>`: `<amount>`", where an asset the book doesn't list is in the platform's units if it's one of the platform's assets (wNEAR, USDC, ETH) and otherwise "`<raw>` raw units · `<asset>`"; the description says "Per-asset caps" for "Monthly asset caps". A hid the per-transaction cap the provider enforces first | Permanent |
| An amount of an asset the book doesn't list (Activity's requests, Signed limits' caps) | USDC in its units; any other asset as "`<raw>` `<asset>`" without `nep141:`, which reads as whole tokens | The platform's assets (wNEAR, USDC, ETH) in their units, from the SDK's `PROPOSAL_TOKENS`; any other asset as "`<raw>` raw units · `<asset>`". A swap's destination is named the same way (A: the book's symbol, else the raw id), so "1.5 wNEAR → ETH" on an empty book | Permanent |
| Signed limits, after a failed overview refresh | Its own "Last reported limits and budget; current observations could not be refreshed." | Not shown: the frame's "Refresh failed. Showing previously loaded records; check again before acting." says it once for the page | Permanent |
| `/policy`'s "Evidence and limitations" aside (`TaskEvidence`) | Shown above Allowed actions | Not shown: it comes from `features/evidence` (showcase), which the brief leaves behind | Permanent |
| `/policy`'s "Issue a new grant" and "Propose a new grant" | Rendered for an agent that isn't a Treasury agent; a Treasury agent gets the "Review strategy authorization" link | Not present: every agent in this build is a Treasury agent, whose grant is bound to the saved strategy and signed on the Strategy page (#7 PR 2). `portfolio` refuses a `grant_issue` without the strategy's digest | Permanent |
| An owner action's "Follow the payment outcome" | A link to `/follow/payment?payment=<id>` | A link to `/activity`: this app has no page for one payment | Permanent |
| The Overview's rebalance: the "Quoted rebalance" region (Preview, Execute, the policy's no-swaps note) and the followed plan's outcome ("Follow the outcome") | Shown | Not shown | #7 PR 3 |
| The Overview's "Confidential sweep" region (Shield) | Shown | Not shown | #11 (funding's `sweep.tsx`); its send block with #7 PR 3 |
| The Overview's "Known limitations" section and its "Requirements and evidence" disclosure | Shown | Not shown: both come from `features/evidence` (showcase), which the brief leaves behind | Permanent |
| The frame on a new agent | The setup's next step (`SetupNextStep`) | Not shown | #12 (creation) |

A wallet connected to another account than the session's shows a status note under the wallet button ("This wallet is connected to `<wallet>`, but you're signed in as `<account>`. Owner actions are unavailable until they match."), and owner controls stay disabled; a sign-out the gateway doesn't confirm shows its error there instead of reloading. Neither changes a name the specs query.

"Signed in" and "Sign out" (the `ViewerBadge`) don't render in a Treasury-only build in A either, so shared-reader's and account-switch's queries for them don't concern this build.

Added: a "Sign out" button beside "Connect wallet" while signed in with no wallet connected (disconnected from the wallet itself, or a new browser profile). With a wallet connected, "Disconnect" signs out as before.

Strategy (#7 PR 2):
- The bound grant is #6's owner action (`grant_issue`, label `treasury`, the reviewed strategy's digest): the platform labels it `treasury:<grantSuffix>`, and the overview's grants (what the policy page lists, #10) carry that label.
- A grant already awaiting its outcome blocks a new authorization by #6's rule (`awaitingOutcome`): submitted, or proposed to the DAO and awaiting its vote. A wallet grant only prepared was never signed and doesn't block. A blocked every prepared or submitted `grant_issue`, so a wallet signature declined in the wallet blocked authorizing until the record expired.
- "Turn off" shows unless the schedule's latest read confirms it off, as the Overview's "Turn off schedule" does. A also showed it while only the strategy's read failed, with the schedule read as off.
- A target asset the book doesn't list is named by the platform's symbol (wNEAR, USDC, ETH) in the summary and the editor's labels, as Activity names it (`symbolOf`). A showed its raw id, so an empty book's editor read "nep141:eth.omft.near (%)", not "ETH (%)".
- "Turn off" shows for an account that can't stop the schedule too, disabled with #6's reason ("Your account cannot stop the schedule."), as the Overview's "Turn off schedule" does. A hid it.
- If a grant for the reviewed strategy settled meanwhile (another tab, or the DAO's vote), "Authorize in wallet" signs nothing and says so: "This saved strategy is already authorized: a matching grant is in place. Nothing was signed."
- The editor's "The saved strategy changed" alert isn't raised by the draft's own save. After a save whose outcome is unknown, it says the save may have applied: "The saved strategy changed, and your save’s outcome is unknown: it may have applied. Your draft is preserved. Review the current strategy below before saving again."
- After a review or an edit ends, focus returns to its trigger, or to Turn on after authorizing, only when that control is enabled and visible; otherwise to the "Targets and schedule" heading.
- "Turn off" is disabled only by the stop's own checks, never by another action on the page. A disabled it while any action ran, including a DAO grant vote that can wait for days.
- Before signing, the grant reads the owner's actions, the strategy and the schedule again, and signs only if no grant awaits its outcome, the strategy is still the reviewed one and the schedule is confirmed off; otherwise the page's notices say why. A reread only the owner's actions. While the page's own grant is in progress, the "An owner grant action is already …" notice isn't shown, as #6's freeze control does.
- Only the latest action's notice or error shows (a save's, the grant's, Turn on's or the stop's). A could show "Schedule enabled…" beside a later "Strategy saved…", and an earlier authorization error beside a later success.
- An invalid field inside the collapsed "Swap limits" disclosure opens it before focus moves there.
- After an `owner/submit` whose outcome is unknown, its status note shows on the page and authorizing isn't offered again until a status read settles it, as with #6's freeze.
- Unresolved operations keep Turn on disabled through the strategy's readiness ("`<n>` unresolved operation(s) block new sends."), as in A; `autopilot/enable` refuses them with its readiness reasons, not a typed `unresolved` refusal. Failures show their messages. The send block (`useSendBlock`) and `OutcomeError` land with their first use: Rebalance (#7 PR 3) and the sweep (#11).
- account-switch's `/30% wNEAR \/ 70% USDC/` reads the quote region's Rebalance description ("Swap toward …", A's `automations.tsx`), not the strategy summary, which reads "`<n>`% `<symbol>`" joined by " · ". It passes once Rebalance lands (#7 PR 3).

Added in #6:
- After an `owner/submit` whose outcome is unknown, a status note under the freeze control: "The outcome is unknown: this owner/submit request may have taken effect. Check the recorded operations before any other action; nothing is sent again automatically." The control stays disabled while the action is followed by its `correlationId`. In A, only "Checking the owner action’s outcome…" showed.
- The control also stays disabled after that note until a status read settles the outcome (`submitted`, `expired` or `failed`): a refused status read ends the following but offers no second signature (a lost one is read again).
- While a freeze or unfreeze awaits its outcome, in any page of the session or after a reload, Freeze and Unfreeze (or Propose to freeze, Propose to unfreeze) are disabled, with a status note and a "Follow owner action" link. Recorded as submitted (`owner/actions` stage `submitted`): "An earlier freeze was submitted and its outcome is still being checked. Do not sign again." Proposed to the DAO and awaiting its vote (stage `prepared`, signer `dao`): "An earlier freeze was proposed to `<dao>` and awaits its vote. Do not propose again." In A, a reload offered them again.

Added in #10:
- After the owner's own policy update succeeds, the editor stays closed to a second signature and doesn't say "The policy changed or is unavailable. Your draft is preserved. Compare it with the current policy before signing." while the reads after it refresh. In A, the overview's new revision often arrived before the action returned (it awaits every read's refresh first), so the editor briefly said that of the owner's own change and offered Sign update again.
- An `owner/prepare` whose answer was lost says "Preparing was interrupted. Nothing was signed, so nothing took effect; any intent already prepared expires unsigned. Prepare again.", and the action stays offered: a prepared action takes effect only once signed and submitted. In A (and #6), it said the request "may have taken effect". The `owner/submit` message is unchanged.
- After a revoke or a policy update whose submission's outcome is unknown, the same status note as #6's under the grants or the editor, and Revoke, Review changes and Sign update stay disabled until a status read settles it. In A, only a pending action disabled them.
- Where `owner/prepare` answers `confirm` instead of an `intent` (a NEP-366 action the platform holds for the owner, as `/apps/v1` answers it), nothing is signed in the page: the status reads "Sign it on the platform’s confirm page · `<m:ss>` left" with an "Open the confirm page" link, and the action is followed in `owner/status` until it settles or that page's window closes ("The confirm page's signing window closed with no signature recorded. Review the existing owner action before preparing it again."). The owner session on this host answers an `intent` for every action, so this shows only where the platform holds the intent; A had no such path.

Activity renders once setup has loaded, even while the overview is loading or has failed (under the frame's "Some agent details could not be loaded." and its error); amounts in the books then show in raw units. An interrupted "Check operation outcomes" (`recover` answered `unknown`) says "The check was interrupted. It only reads; check again.", not that it may have taken effect, and the check stays offered.

Activity's "Back to Activity" (`ActivityReturn`) and "Review invoices in Payments" don't render in a Treasury-only build in A either, and aren't ported.

An address under `/a/<agent>/` that isn't a page is titled `Treasury · Page not found` (A: `Treasury · Overview`) and offers "Back to overview".

## Deviations from the brief

- **No component tests.** Instead (the user's decision, 2026-10-31): `node:test` for `src/platform.ts` with a mocked `fetch`, and Playwright on a fresh platform stack (766b3f3 or later) per feature, serving this build with `--frontend`. The stack test also runs axe's WCAG A and AA rules on every page it opens (any violation fails it) and checks the keyboard paths.
- **`contract.json` is checked both ways** (`test/contract.test.ts`): every procedure and gateway route the app calls is covered by a required capability, and every required capability is used, per the SDK's `ownerCapabilities`.
- **`features/workspace` is left behind.** In A's Treasury-only build, `DaoHome` (proposals, cross-agent activity, history) never renders: a signed-in visitor at `/` is sent to `/a/<treasury>/`. Nor does `attention.ts`: it renders only through `DaoHome` and portfolio's `overview.tsx`, and `overview.tsx` only through `legacy/surface.ts` (the `@legacy` alias is `absent.ts` unless `PUBLIC_TREASURY_ONLY` is `"false"`). A's Treasury build serves `TreasuryDesk` at `/`, so B's Overview ports that, without the "Needs attention" list; `overview.tsx` and `attention.ts` stay behind. Step 1 is the session and access instead: sign-in and out, account-switch revalidation, access denials, the Treasury-only redirect, and the agent frame.
- **Treasury creation** (`create-treasury`, `onboarding`, `setup-progress`) is its own issue.
- **`@orpc/tanstack-query` is dropped.** A's data layer wrapped an oRPC proxy client in `@orpc/tanstack-query` (beta.44), a second oRPC beside the SDK's bundled beta.47. `src/platform.ts` builds TanStack Query options for reads itself; actions and streams never go through a query.
- **`contract.json` grows per feature.** Step 1 requires `gateway-session-v1` and `agent-observe-v1`; Activity adds `treasury-observe-v1` (`reconcileBooks`, `ledgerCsv`) and `treasury-recovery-v1` (`recover`); each feature adds the capabilities its procedures need (platform `src/contract/owner-capabilities.ts`).

## Driving the build on the stack

`web/test/stack.e2e.ts` starts `pnpm test:e2e:stack --treasury --frontend web/dist` through `startStack` (`scripts/stack.ts`) and attaches to the stack's browser over CDP. Three things the platform's docs imply but don't spell out:
- The attached connection must accept the local certificate: `Security.setIgnoreCertificateErrors` on a browser CDP session.
- A page that connection creates (`context.newPage()`) doesn't share the owner's session, and `context.pages()[0]` isn't reliably the owner's page. Find the owner's page by its URL (`/a/payout/`).
- A tab opened from the owner's page (`window.open`) shares the session cookie but not the stack's test wallet. Wallet steps run in the owner's page itself.

What the stack (platform 1a7fe98) can't show for `/policy`, so `web/test/stack.e2e.ts` stops short:
- **Revoking a grant.** The simulated provider (`test/e2e/provider.mjs`) has no `grant_revoke`: `owner/prepare` answers 500, an unknown outcome to the SDK. The test reviews the revoke in its dialog, prepares it once, and checks the unknown outcome is shown and the grants are unchanged. A signed revoke needs a `grant_revoke` branch in the simulator.
- **Issuing a grant.** `portfolio` accepts only the strategy-bound grant (`label: "treasury"` with the saved strategy's digest), which the Strategy page signs (#7 PR 2). The test issues it through the `authorizeStrategy` control and checks `/policy` lists it under its label as the current grant.
- **A NEP-366 policy edit.** `onChainPolicyEdits` is off for `portfolio` (`test/e2e/environment.mjs` starts its provider without it), so every policy edit there is NEP-413. The test drafts, reviews, signs and applies one; the NEP-366 path and the confirm page are covered by `test/owner.test.ts` only.
