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

Added: each page has one `<h1>` with its title (Overview, Strategy, and so on) while it's a placeholder. In A, only the Overview ("Treasury overview") and the guided run had an `<h1>`, so the other pages failed axe's `page-has-heading-one`. A feature that replaces a placeholder keeps one `<h1>` per page, without duplicating a heading a spec queries by name (workspace's `Strategy`).

Page titles are unchanged: `Treasury · <page>`, with the prototype's page names (Overview, Strategy, Runs, Balances & funding, Policy & grants, Guided walkthrough, Operation status).

Changed or not present yet:

| Where | A | B | Until |
| --- | --- | --- | --- |
| Signed-out home | Proof flows ("What Treasury does", "What has been demonstrated", "Known limitations"), the "What works today" and "View requirements" disclosures, and the "NEAR Intents resources" region | Brand, the headline ("Your treasury. Your limits."), the "Get started" region and Connect wallet only. The rest was showcase (`public/`), which the brief leaves behind | Permanent |
| Setup unavailable | The retained-records task (operation status, run timeline) below the alert | Nothing: the alert and "Retry setup" only. The "Review existing operation records" link was removed, since it led back to the same screen. Records already loaded stay shown when a later setup read fails | #8 (activity) |
| An agent not yet created | Onboarding | Status text: "This Treasury agent hasn't been created yet." | #12 (creation) |
| A self-service host's root | Treasury creation | A "Your treasuries" heading with a link per treasury agent | #12 (creation) |
| Every page under `/a/<agent>/` | The page | Text: "`<page>` moves here from the Treasury prototype, one feature at a time." So no spec query on those pages passes until its feature lands | Each feature's issue: #6–#12 |
| The frame on a failed read | Also offered "Turn off" (stop the schedule) | Not offered | #6 (owner actions) |
| The frame on a new agent | The setup's next step (`SetupNextStep`) | Not shown | #12 (creation) |

A wallet connected to another account than the session's shows a status note under the wallet button ("This wallet is connected to `<wallet>`, but you're signed in as `<account>`. Owner actions are unavailable until they match."), and owner controls stay disabled; a sign-out the gateway doesn't confirm shows its error there instead of reloading. Neither changes a name the specs query.

"Signed in" and "Sign out" (the `ViewerBadge`) don't render in a Treasury-only build in A either, so shared-reader's and account-switch's queries for them don't concern this build.

## Deviations from the brief

- **No component tests.** Instead (the user's decision, 2026-10-31): `node:test` for `src/platform.ts` with a mocked `fetch`, and Playwright on a fresh platform stack (766b3f3 or later) per feature, serving this build with `--frontend`. The stack test also runs axe on every page it opens (any violation fails it) and checks the keyboard paths.
- **`contract.json` is checked both ways** (`test/contract.test.ts`): every procedure and gateway route the app calls is covered by a required capability, and every required capability is used, per the SDK's `ownerCapabilities`.
- **`features/workspace` is left behind.** In A's Treasury-only build, `DaoHome` (proposals, cross-agent activity, history) never renders: a signed-in visitor at `/` is sent to `/a/<treasury>/`. Its one live module, `attention.ts`, moves with portfolio. Step 1 is the session and access instead: sign-in and out, account-switch revalidation, access denials, the Treasury-only redirect, and the agent frame.
- **Treasury creation** (`create-treasury`, `onboarding`, `setup-progress`) is its own issue.
- **`@orpc/tanstack-query` is dropped.** A's data layer wrapped an oRPC proxy client in `@orpc/tanstack-query` (beta.44), a second oRPC beside the SDK's bundled beta.47. `src/platform.ts` builds TanStack Query options for reads itself; actions and streams never go through a query.
- **`contract.json` grows per feature.** Step 1 requires `gateway-session-v1` and `agent-observe-v1`; each feature adds the capabilities its procedures need (platform `src/contract/owner-capabilities.ts`).

## Driving the build on the stack

`web/test/stack.e2e.ts` starts `pnpm test:e2e:stack --treasury --frontend web/dist` through `startStack` (`scripts/stack.ts`) and attaches to the stack's browser over CDP. Three things the platform's docs imply but don't spell out:
- The attached connection must accept the local certificate: `Security.setIgnoreCertificateErrors` on a browser CDP session.
- A page that connection creates (`context.newPage()`) doesn't share the owner's session, and `context.pages()[0]` isn't reliably the owner's page. Find the owner's page by its URL (`/a/payout/`).
- A tab opened from the owner's page (`window.open`) shares the session cookie but not the stack's test wallet. Wallet steps run in the owner's page itself.
