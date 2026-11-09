# Notes for the platform

The accessible names of the app's pages (`web/src/proposals`), which only the app server serves, and how they use the platform. The owner-session build these notes once compared against was removed in #138; the platform's release-candidate specs that queried its names run against frozen builds of the prototype (MultiAgency/platform#22).

## The proposals page (#20)

The build (`src/proposals/`, built to `dist-proposals/`), served only by the app server (`apps/server`, `TREASURY_PAGE_DIR`) from its own origin. It calls only the server's `/api/` routes (`src/proposals/proposals-api.ts`), and the platform's specs don't query it.

| Name | Role | Where |
| --- | --- | --- |
| Treasury proposals · `<page>` | page title (#129): the build's name, then the page's own title (was just "Treasury proposals") | every page |
| Home, Proposals, Strategy, Funding | heading (level 1), one per agent page: `/agents/<agent>/`, `…/proposals`, `…/strategy`, `…/funding` (was "Treasury proposals" on `/agents/<agent>` for all of it) | an agent's pages |
| Agent pages | navigation (landmark): links Home, Proposals, Strategy, Funding, the current one `aria-current="page"` (Proposals also on `…/proposals/<id>`) | an agent's pages, signed in |
| Page not found | heading (level 1), with an alert saying what the address got wrong (a bad agent name, a bad DAO account, a page that isn't one); link Your treasuries | any address that names nothing |
| Your treasuries | heading (level 1) on `/`; list of links, one per agent | `/`, signed in |
| Set up your Treasury, Set up a Treasury | heading (level 2), button | `/`, an account with no Treasury |
| Set up a Treasury for your account?, Text to sign, Cancel, Sign and set up | dialog, the signed text (labelled), buttons | `/` |
| A DAO's Treasury, DAO account, Open the DAO's Treasury | heading (level 2), textbox, button | `/` |
| Open an agent | heading (level 2) | `/` |
| A DAO's Treasury | heading (level 1) on `/setup/dao/<dao>` | |
| Setup; Ask the DAO to set up its Treasury; Waiting for the vote of `<dao>` to set up its Treasury.; The DAO's treasuries | region and heading (level 2); button; status; list | `/setup/dao/<dao>` |
| Create the agent | region and heading (level 2); button | an agent set up but not created |
| open the confirm page; Create it again | link (the platform's confirm page); button | Create the agent |
| Proposal | heading (level 1) on `/agents/<agent>/proposals/<id>` | |
| Skip to main content | link | every page |
| This agent isn't connected to the app. Connect the agent first. | status, with a link to Home's Connection | Strategy and Funding, while not connected (#129) |
| This agent hasn't been created yet. Create it on its home page. | status, with a link to Home | every agent page but Home, while the agent isn't created (#129) |
| Agent name, Open proposals | textbox, button; the button opens the agent's Proposals page (`/agents/<agent>/proposals`, was its one page) | `/`, Open an agent |
| Sign in, Sign in with wallet | heading (level 2), button | signed out |
| Signed in as `<owner>`, Sign out | text, button | signed in |
| Connection | region, heading (level 2) | `/agents/<agent>/` (Home; was `/agents/<agent>`) |
| Connected: `<scopes>`, until `<date>`. or Not connected. … | status | Connection |
| Connect, Disconnect | button | Connection |
| Connect this agent to the Treasury app?, Text to sign, Cancel, Sign and connect | dialog, the signed text (labelled), buttons | Connection |
| Disconnect this agent?, Cancel, Disconnect | dialog, buttons | Connection |
| Proposals | region and heading (level 2); list | `/agents/<agent>/proposals` (was `/agents/<agent>`) |
| Review proposal `<id, shortened>` | link | each proposal in the list |
| Swaps | list (each leg: "Swap `<amount>` for at least `<floor>`", exactly as the signed text names them, and its quote, rounded) | list and proposal |
| Back to proposals | link | proposal, and an address whose ID isn't a proposal's ("This address doesn't name a proposal: …", alert) |
| Terms, State | region and heading (level 2) | proposal |
| Proposal reference | disclosure summary (ID, sha256, policy and strategy digests) | proposal |
| Operations | list | proposal, once it reports any |
| Approve, Reject, Execute, Check again | button | proposal, State |
| Approve this proposal? or Reject this proposal?, Text to sign, Cancel, Sign and approve or Sign and reject | dialog, the signed text (labelled), buttons | proposal |
| Execute this proposal?, Cancel, Execute now | dialog, buttons | proposal |
| You approved this proposal., You rejected this proposal., Executed. Every swap succeeded. | status | proposal, State |
| Portfolio, Check again | region and heading (level 2), button | `/agents/<agent>/` (Home), once connected |
| Holdings | table (Asset, Amount exactly, Value) | Portfolio |
| Needs your decision | region and heading (level 2); list; empty: "Nothing needs a decision." (status) (#130) | `/agents/<agent>/` (Home), first; once connected, or for a DAO's waiting requests |
| Awaiting your decision: …, Approved, not executed yet: …, Waiting for the DAO's vote to …, An operation's outcome isn't proven yet …; Expires `<time>` | list items | Needs your decision |
| Review proposal `<id>`, Open the connection, Check the activity | links: the proposal's page, Home's Connection, the Activity page at the operation's entry | Needs your decision |
| Where the agent stands | region and heading (level 2); list: Policy, Strategy, Autopilot, each with its state; Open (link to Strategy) | Home, once connected |
| Forward risk | region and heading (level 2), on Home and Strategy (#220); figures list (Forward risk figures), headings (level 3) Top stress scenarios and What the agent would do with a list under each; empty: "No forward risk assessment has been recorded for this agent yet." (status) | Home and `/agents/<agent>/strategy`, once connected |
| L0 normal, L1 watch, L2 caution, L3 critical or L4 red hand; Recorded `<time>`, log record `<n>`; Proposed for your approval. or Not proposed: …; Review the de-risk proposal | badge; text; the de-risk's state in What the agent would do; link to the agent's Proposals page when one was proposed | Forward risk |
| Book, Allocation | headings (level 3); Book value, `<period>` budget left (or Budget), Held privately; table Allocation (Asset, Value, Weight · target) | Portfolio (#130; ported from the owner UI's overview, same words) |
| Held payouts | heading (level 3), list; "No payouts are held." (was **Needs attention**, which also listed unresolved operations: now in Needs your decision) | Portfolio |
| ~~Activity, Autopilot runs~~ | removed from the home: they are on the Activity page | Portfolio (#136) |
| Funding, Check again | region and heading (level 2), button | `/agents/<agent>/funding` (was `/agents/<agent>`), once connected |
| Funding account; Money in: from `<account>` to this agent; Receive funds | headings (level 3) | Funding |
| Funded from `<account>`. or Funded from `<dao>`, a DAO with `<n>` members. | status | Funding account, once linked |
| Use `<account>`, Funding NEAR account, Link; Unlink, Unlink the funding account?; Confidential in Trezu | buttons, field; button, dialog; checkbox (a linked DAO) | Funding account, a wallet owner only |
| Funding amount, Funding asset, Review transfer or Review proposal | field, select, button | Money in |
| Funding transfer to sign; Cancel, Send or File funding proposal | group (the exact transfer); buttons | Money in, once reviewed |
| Open payment in Trezu | link, with the agent's `nearcom:` recipient | Money in, a confidential DAO |
| Get a deposit address or Get a new deposit address | button | Receive funds |
| Allow owner actions; Allow owner actions for this agent?, Sign and allow | button; dialog (warns that open proposals are withdrawn), button | Connection, connected without owner, a wallet owner |
| Propose a rebalance; Proposed. Review it below: nothing is sent until it's approved.; Review the proposal | button; status; link | Proposals, once connected, for an account that may file proposals |
| Autopilot, Check again | region and heading (level 2), button | `/agents/<agent>/strategy` (was `/agents/<agent>`), once connected |
| From strategy to autopilot: 1. Configure the strategy, 2. Authorize it, 3. Turn autopilot on | ordered list, headings (level 3), in that order | Autopilot |
| Strategy targets; Why autopilot can't be turned on | lists | Autopilot (steps 1 and 3) |
| With a $0 ceiling, autopilot makes no swaps on its own…; Propose a rebalance | text; link to the agent's Proposals page (`/agents/<agent>/proposals`, was the `#proposals` section) | Autopilot, step 1, at a $0 ceiling |
| Autopilot is on… or Autopilot is off. | status | Autopilot |
| Turn on, Let the agent act on its own?; Turn off; Run now, Run the strategy once now? | button, dialog; button; button, dialog | Autopilot, for an account that may file and vote (Run now only while the grant binds the strategy) |
| Edit strategy; Edit strategy (form, opening at its heading, focus back on Edit strategy when it closes): USDC (%), wNEAR (%), ETH (%), Run every (minutes), Automatic rebalance ceiling (USD), Swap limits, Minimum swap (USD), Maximum swap cost (%), Cancel, Save with autopilot off | button; form, fields, disclosure, buttons | Autopilot, for an account that may save the strategy |
| Strategy saved. Authorize it next. | status (the schedule's own status says it's off) | Autopilot, after a save |
| Authorize this strategy or Ask the DAO to authorize this strategy; Authorize this saved strategy?, Sign in wallet or File for the DAO's vote | button; dialog, button | Autopilot, while the grant doesn't bind the saved strategy and autopilot is off. While a grant awaits its outcome (submitted, or a DAO's open vote) the button is disabled, after a reload too. |
| Shield public balances | heading (level 3) | Funding |
| Preview, Shield; Public balances | buttons; list (each balance exactly, then its shield's status) | Shield public balances, once the executor holds a treasury grant |
| Shield these public balances?, Public balances to shield, Shield now | dialog, list, button | Shield public balances |
| Books | heading (level 2), table (Asset, Public drift from chain, Private, not attributed) | Activity (was Portfolio, #136) |
| Activity | heading (level 1) on `/agents/<agent>/activity`; navigation link | #136 |
| Emergency stop | region and heading (level 2) in the frame of every page of an agent that exists, after the navigation (#133); status "Frozen: the agent refuses every send." or "Not frozen." | every agent page |
| Freeze, Unfreeze; Propose to freeze, Propose to unfreeze (a DAO's member) | button: one at a time, by the state read from the overview; disabled while a freeze or unfreeze awaits its outcome (read from the platform, so after a reload too) | Emergency stop |
| Freeze this agent?, Unfreeze this agent?; Sign and freeze, Sign and unfreeze, File for the DAO's vote, Cancel | dialogs, buttons: what a freeze does and doesn't stop is said before anything is signed | Emergency stop |
| Grants (region); Live grants, Ended grants (lists); Revoke grant <label>, Propose to revoke grant <label> (a DAO's member) | button | the Policy page (#142): a live grant with its dates; revoking is behind the dialog "Revoke this grant?" ("Sign and revoke", "File for the DAO's vote", "Cancel"), which says what it does and, for a DAO, the vote window (about 290 s). While a revocation awaits its outcome the buttons are disabled, after a reload too. |
| Policy as signed, Limits, Revisions and mandate digest (regions); Edit, Propose an edit, Review the changes (buttons); Change this policy? (dialog) with Sign and apply, Prepare for the DAO's vote; Terms before and after (region) with File for the DAO's vote | button, dialog | the Policy page (#134): the editor's fields are labelled (Swaps allowed, Owner approval for every payment, Any asset, Actions an hour, USD daily/weekly/monthly, caps per window and asset). A DAO member compares the terms before filing; the vote windows (about 290 s, or 600 s for an on-chain field) are stated before. |
| Connect the agent; Allow owner actions in Connection; A member who may file proposals asks the DAO to freeze it. | text with a link to Home's Connection: a control that can't work says why instead of disappearing | Emergency stop |
| Open the confirm page | link (the platform's own page, where the owner signs what it holds for them) | Emergency stop, when the platform answers that form |
| Freeze is waiting for a signature or the DAO's vote; Open where it is signed or voted on | list item with `Expires …`; link to the stop (`#emergency-stop`), the Strategy page (a grant) or Activity's owner actions | Needs your decision, from `owner/pending` |
| Without a proven outcome | region and heading (level 2); list | Activity, when any |
| History, Download CSV, Check status, Newer, Older, History pages, Page `n` of `m` | region and heading (level 2) with a list; link (the ledger's CSV, `/api/agents/<agent>/activity.csv`); button per row; buttons and navigation; status | Activity |
| Owner actions | region and heading (level 2); list (Strategy grant, Freeze, …, each with where it stands); "No owner actions yet." | Activity |
| Autopilot runs, Open the run of `<time>` | region and heading (level 2) with a list (was a card on the home); links | Activity |
| Run | heading (level 1) on `/agents/<agent>/activity/runs/<id>`; Back to activity; Started, Started by, How it ended; Stages (ordered list) | #136 |
| No run has this ID.; This address doesn't name a run … | alerts | Run |
| Signed in as `<member>`, a member of `<dao>`, which owns this agent | text | signed in, a DAO-owned agent |
| Ask the DAO to connect it; Connected by the vote of `<dao>`: … or Waiting for the vote of `<dao>` to connect this agent. | button; status | Connection, a DAO-owned agent |
| stop this agent | link (the platform's DAO stop page), in place of Disconnect | Connection, a DAO-owned agent |
| Ask the DAO to approve, Ask the DAO to reject | button, in place of Approve and Reject | proposal, a DAO-owned agent |
| `<dao>` votes to approve (reject) this proposal. | status | proposal, while the DAO's vote waits |
| What the DAO votes on | list (the DAO proposal's description, line by line) | a waiting DAO request |
| File the DAO proposal or File and vote; Vote on it in Trezu; Check the exact text and hash the DAO signs | button; links | a waiting DAO request |

How it departs from the brief, or decides what the brief leaves open:
- **The agent comes from the address** (`/agents/<agent>/…`, one frame around each of its pages). `/` lists the signed-in account's own treasuries (`GET /api/setup`, the agents its consents name under its Organization), and still opens an agent by name, for one a DAO owns.
- **Setup (#12) is the app server's**, through `/apps/v1/setup` and `/apps/v1/dao-setups`, not the owner session's `/gw/agents`. An account with no Treasury signs the server's setup text; the agent's page then offers its creation (`agent_create` under the setup consent), signed on the platform's confirm page, or for a DAO filed for its vote. The setup consent lasts an hour; after that, creating asks for the setup again. The stack sets up Payables agents only (`hostedAreas: ['payables']` at `49b8d51`), so setup and creation are covered by the server's unit tests, not a stack test.
- **The portfolio is read-only (#7 on `/apps/v1`).** It shows the owner reads (#61) once the agent is connected: holdings with exact amounts, what needs attention, the latest 20 activity rows and 10 autopilot runs. Plans, the steward and the inbox aren't here: they need `treasury-execute` (which this app doesn't ask for) or procedures no app scope covers. A rebalance is a proposal instead: "Propose a rebalance" asks the platform for one to the saved strategy, as `watch` does, and the owner approves it like any other; after a lost answer the page finds it by its request ID rather than asking again. Each read is a call from the deployment's shared 1,200 an hour, so the page reads them once and again only on "Check again".
- **Funding is the app's, under its `treasury` consent.** The funding account is read with `treasury/get`; a wallet owner links, unlinks and marks it confidential through the server, and a DAO agent's account is the DAO, fixed at setup, so no member gets those controls, whatever their roles. Money in asks the server for a fresh `deposit` address, builds the transfer with the SDK's `fundingTransaction` in place of the owner session's `treasury/fund`, checks and shows it exactly, then reads the account again before the funding account signs: the owner's wallet sends it, or Trezu files it as the DAO's proposal. After an answer the wallet doesn't give, it isn't offered again while the page is loaded. No platform read reports whether a funding transfer was sent, so the block can't outlast the page: a platform gap that a funding transfer's own record would close. A confidential DAO pays from Trezu to the agent's `nearcom:` wallet, read with `account`. The stack takes USDC deposits only and answers the agent's wallet as the address, so NEAR funding and fresh addresses are the unit tests'; the stack's wallets record what they're asked to send and send nothing.
- **The strategy is edited with the form and checks the owner-session UI used** (`strategy-form.ts`), and saved over the strategy shown, by its digest: a strategy changed meanwhile is refused, never overwritten, and after a lost answer saving again is safe for the same reason. Saving turns autopilot off and leads to authorizing the new strategy. Leaving with unsaved changes asks first.
- **Autopilot runs only the strategy it was turned on for.** Turn on sends the digest of the strategy the page shows, so the platform refuses it if the strategy changed meanwhile. Run now is offered only while the held grant binds the strategy, since otherwise a run swaps nothing; after a lost answer it may have run, so it isn't sent again, and the page points to the autopilot's runs. Disconnect turns autopilot off first, and disconnects nothing if it can't. A strategy without a binding grant is authorized here: a wallet owner signs the grant's intent in their wallet once their connection allows owner actions, a DAO's member files it for the DAO's vote (which must pass within minutes), and the page follows its status until the strategy reads bound. A grant already waiting is followed, never signed twice, and one awaiting its outcome in `owner/actions` holds the button after a reload too.
- **Shielding is decided from what the run reported.** The server answers a sweep as its AG-UI run, and the page decides it with `settle` (`shared/execution-outcome.ts`). After a run whose outcome is unknown (no terminal event, or a shield not settled) or partly sent, Shield isn't offered again while the page is loaded. Shielding needs the executor to hold a treasury grant, read with `account`.
- **Signed in or not** is read from `GET /api/agents/:agent` on an agent's pages, and from `GET /api/setup` or `GET /api/setup/dao/:dao` on the others: the server has no session route. `not_signed_in` there shows Sign in; another read answering `not_signed_in` later reads the identity again, so the page returns to Sign in.
- **The wallet's account is checked before relaying.** A consent or verdict signed by another account than the agent's owner is not sent: "Your wallet signed as `<account>`, but this agent's owner is `<owner>`. Nothing was sent." The server would refuse it anyway (`not_owner`, `signature_invalid`).
- **A verdict whose answer was lost** (or `unavailable`) reads the proposal: if it now reads approved (rejected), it says "You approved this proposal." (rejected), as the server's own recovery decides it; otherwise the read is shown and nothing is signed again without a new review.
- **`not_executable` carries no code or reason** from the server (`executeResult` is the result and the proposal only), so the page says the platform's causes ("a price below a signed floor, a provider warning, a short balance, no live treasury grant, or the policy not in force"), with the proposal's `reason` when it has one. Execute stays offered.
- **Execute after `pending`, lost or `unavailable`** is decided by a read after it: offered again only if that read says `approved`. If the read fails, Execute stays off until "Check again" answers. After a reload or in another tab, the platform's state decides alone: `executing` and `unknown` offer nothing, and an `approved` read offers Execute, which the platform claims at most once.
- **`policy_not_in_force`** links to the agent's Policy page here (`…/policy`, #134).
- **Swaps read exactly as signed** (the user's decision, 2026-11-04): the amount and floor of each leg are never rounded (`exactAmountOf` in `shared/format.ts`), so a floor of 0.499996 wNEAR never reads "at least 0.5". `test/proposal-terms.test.ts` checks each leg against the SDK's `proposalText`. Only the quote, which isn't signed, is rounded (`amountOf`).
- **A DAO-owned agent** (#100): a member signs in as themselves, and every signature is the DAO's vote. The page shows the request the server filed, what the DAO's proposal says (its description as text, never HTML) and the platform's check page, then what the member can do by what the DAO holds: file the platform's transaction from their own wallet (with their vote when they may vote and its proposal number still fits), vote in Trezu on the proposal already filed, or wait for the server to complete it. The member's wallet sends the platform's transaction as is, through `walletSession.send` and `transactionOutcome` (`wallet-session.ts`, `wallet-transaction.ts`). Execute is offered only to an account whose roles allow it (`access.canExecute`).
- **The consent dialog** shows the platform's consent text exactly, and beside it everything the `treasury` scope grants, which that text can't narrow, and what this server actually calls.
- **Its own build output.** `rsbuild` builds the pages to `dist-proposals/`, the only folder the app server serves. `test/proposals-isolation.test.ts` checks that every source file in `web/src` is reached from the page's entry, so nothing only a removed build used is left behind.

Driving the page on the stack (`test/proposals.e2e.ts`, its own stack started with `--app`): the app server runs in-process with the stack's `tap_` credential and serves `dist-proposals/`; Playwright's own browser installs near-connect's injected "Local test wallet" as the platform's `test/e2e/wallet.mjs` does, signing through the `signOwner` control. The server's key check is a stand-in for the stack's owner key, as in `apps/server`'s stack test. The proposals are made through the app route directly, as the app's proposer will (#20 PR 4).
