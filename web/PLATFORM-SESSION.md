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

The Activity page's text comes from the prototype's A8 (`send-block`) change, which exists only uncommitted in `dao/treasury`'s working tree, not at `d999861`: `BlockedSummary` and `blockedBy` (`src/shared/send-block.ts`), and its wording of a replacement as an "operation", not a "payment". `/does not establish that nothing was sent/` stays in `Activity`'s per-plan view, which the portfolio's plan outcome uses (#7); the treasury-migration spec asserts it absent after a refusal before sending.

Added: each page has an `<h1>` with its title (Overview, Strategy, and so on), placeholder or ported (Activity: "Operation status"). In A, only the Overview ("Treasury overview") and the guided run had one.

Page titles are unchanged: `Treasury · <page>`, with the prototype's page names (Overview, Strategy, Runs, Balances & funding, Policy & grants, Guided walkthrough, Operation status).

Changed or not present yet:

| Where | A | B | Until |
| --- | --- | --- | --- |
| Signed-out home | Proof flows ("What Treasury does", "What has been demonstrated", "Known limitations"), the "What works today" and "View requirements" disclosures, and the "NEAR Intents resources" region | Brand, the headline ("Your treasury. Your limits."), the "Get started" region and Connect wallet only. The rest was showcase (`public/`), which the brief leaves behind | Permanent |
| Setup unavailable | The retained-records task (operation status, run timeline) below the alert | The alert and "Retry setup"; on `/automations` the "Schedule" section with "Turn off", and on `/activity` the retained records (unresolved operations, owner actions and operation history), as in A; elsewhere a "Review existing operation records" link to `/activity`. Records already loaded stay shown when a later setup read fails | #9 (run): the run timeline on `/follow/run` |
| An agent not yet created | Onboarding | Status text: "This Treasury agent hasn't been created yet." | #12 (creation) |
| A self-service host's root | Treasury creation | A "Your treasuries" heading with a link per treasury agent | #12 (creation) |
| Every page under `/a/<agent>/` but Activity | The page | Text: "`<page>` moves here from the Treasury prototype, one feature at a time." So no spec query on those pages passes until its feature lands | Each feature's issue: #7, #9–#12 |
| The frame on a failed read, on `/automations` and `/follow/run` | Those pages' own "Turn off" | Not offered: the frame leaves those two pages to their own control, as in A, and the pages are placeholders | #7 (portfolio) |
| `/policy` | The "Owner controls" section (`h2`), with "Freeze the agent" or "Unfreeze the agent" (`h3`) and Freeze or Unfreeze | Below the placeholder: "Freeze the agent" or "Unfreeze the agent" (`h2`, as no section holds it yet) and Freeze or Unfreeze | #10 (policy) |
| An owner action's "Follow the payment outcome" | A link to `/follow/payment?payment=<id>` | A link to `/activity`: this app has no page for one payment | Permanent |
| The frame on a new agent | The setup's next step (`SetupNextStep`) | Not shown | #12 (creation) |

A wallet connected to another account than the session's shows a status note under the wallet button ("This wallet is connected to `<wallet>`, but you're signed in as `<account>`. Owner actions are unavailable until they match."), and owner controls stay disabled; a sign-out the gateway doesn't confirm shows its error there instead of reloading. Neither changes a name the specs query.

"Signed in" and "Sign out" (the `ViewerBadge`) don't render in a Treasury-only build in A either, so shared-reader's and account-switch's queries for them don't concern this build.

Added: a "Sign out" button beside "Connect wallet" while signed in with no wallet connected (disconnected from the wallet itself, or a new browser profile). With a wallet connected, "Disconnect" signs out as before.

Added in #6:
- After an `owner/submit` whose outcome is unknown, a status note under the freeze control: "The outcome is unknown: this owner/submit request may have taken effect. Check the recorded operations before any other action; nothing is sent again automatically." The control stays disabled while the action is followed by its `correlationId`. In A, only "Checking the owner action’s outcome…" showed.
- The control also stays disabled after that note until a status read settles the outcome (`submitted`, `expired` or `failed`): a refused status read ends the following but offers no second signature (a lost one is read again).
- While a freeze or unfreeze awaits its outcome, in any page of the session or after a reload, Freeze and Unfreeze (or Propose to freeze, Propose to unfreeze) are disabled, with a status note and a "Follow owner action" link. Recorded as submitted (`owner/actions` stage `submitted`): "An earlier freeze was submitted and its outcome is still being checked. Do not sign again." Proposed to the DAO and awaiting its vote (stage `prepared`, signer `dao`): "An earlier freeze was proposed to `<dao>` and awaits its vote. Do not propose again." In A, a reload offered them again.

Activity renders once setup has loaded, even while the overview is loading or has failed (under the frame's "Some agent details could not be loaded." and its error); amounts in the books then show in raw units. An interrupted "Check operation outcomes" (`recover` answered `unknown`) says "The check was interrupted. It only reads; check again.", not that it may have taken effect, and the check stays offered.

Activity's "Back to Activity" (`ActivityReturn`) and "Review invoices in Payments" don't render in a Treasury-only build in A either, and aren't ported.

An address under `/a/<agent>/` that isn't a page is titled `Treasury · Page not found` (A: `Treasury · Overview`) and offers "Back to overview".

## Deviations from the brief

- **No component tests.** Instead (the user's decision, 2026-10-31): `node:test` for `src/platform.ts` with a mocked `fetch`, and Playwright on a fresh platform stack (766b3f3 or later) per feature, serving this build with `--frontend`. The stack test also runs axe's WCAG A and AA rules on every page it opens (any violation fails it) and checks the keyboard paths.
- **`contract.json` is checked both ways** (`test/contract.test.ts`): every procedure and gateway route the app calls is covered by a required capability, and every required capability is used, per the SDK's `ownerCapabilities`.
- **`features/workspace` is left behind.** In A's Treasury-only build, `DaoHome` (proposals, cross-agent activity, history) never renders: a signed-in visitor at `/` is sent to `/a/<treasury>/`. Its one live module, `attention.ts`, moves with portfolio. Step 1 is the session and access instead: sign-in and out, account-switch revalidation, access denials, the Treasury-only redirect, and the agent frame.
- **Treasury creation** (`create-treasury`, `onboarding`, `setup-progress`) is its own issue.
- **`@orpc/tanstack-query` is dropped.** A's data layer wrapped an oRPC proxy client in `@orpc/tanstack-query` (beta.44), a second oRPC beside the SDK's bundled beta.47. `src/platform.ts` builds TanStack Query options for reads itself; actions and streams never go through a query.
- **`contract.json` grows per feature.** Step 1 requires `gateway-session-v1` and `agent-observe-v1`; Activity adds `treasury-observe-v1` (`reconcileBooks`, `ledgerCsv`) and `treasury-recovery-v1` (`recover`); each feature adds the capabilities its procedures need (platform `src/contract/owner-capabilities.ts`).

## Driving the build on the stack

`web/test/stack.e2e.ts` starts `pnpm test:e2e:stack --treasury --frontend web/dist` through `startStack` (`scripts/stack.ts`) and attaches to the stack's browser over CDP. Three things the platform's docs imply but don't spell out:
- The attached connection must accept the local certificate: `Security.setIgnoreCertificateErrors` on a browser CDP session.
- A page that connection creates (`context.newPage()`) doesn't share the owner's session, and `context.pages()[0]` isn't reliably the owner's page. Find the owner's page by its URL (`/a/payout/`).
- A tab opened from the owner's page (`window.open`) shares the session cookie but not the stack's test wallet. Wallet steps run in the owner's page itself.
