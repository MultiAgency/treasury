# Contributing

This repository holds the Treasury app: its pages (`web/`: the proposals page the app server serves, and the owner-session UI until it's retired), the app server (`apps/server/`) and the strategy engine (`packages/core/`), which `watch` runs for the agents configured with it. It moves money, so the rules below are about not losing track of it.

## How changes land

- **One branch, one PR to `main`.** Each PR needs one approving review from someone other than its author, and green CI on its head commit ("Typecheck, unit tests and build" on Node 24 and 26, and "Stack tests (simulated platform)"). It's squash-merged.
- **Stacked PRs land one at a time.** Once the PR below merges, retarget the next one to `main`, and review and merge it there. Don't merge PRs into each other's branches.
- **A PR description has three parts:**
  - **Summary:** what changed and why.
  - **Evidence:** the head commit, the CI run, test counts, and what the stack test covers.
  - **Merge Danger:** door (one-way or two-way) and blast radius.
- **Link the issue** with `Closes #<n>` when the PR finishes it.

## Tests

- **`pnpm check`** runs every package's typecheck and unit tests, and **`pnpm build`** builds. Both run in CI.
- **A package's `test` script is unit tests only.** Stack and end-to-end tests have their own scripts (`test:stack`, `test:sandbox`) and CI's stack job. They run against the platform's simulated stack at the pinned commit: see the README.
- **A stack test that runs real timers, or leaves an operation unresolved, gets its own stack,** so it can't move funds or block actions that other tests count on.
- **Money logic gets a test that fails without its fix.** For a bug, reproduce it in a test first.

## Money-path rules

- **After an unknown outcome, nothing is sent again.** Block on the platform's records, not on component state, so a reload or another tab keeps the block. Recover by reading the platform's state. Where the platform keeps no record to block on, as for a funding transfer (`web/PLATFORM-SESSION.md`), block for as long as the page is loaded, say why, and record the gap there.
- **Show exactly what is signed,** and read it again right before the wallet signs. If it changed, show the new version and ask again.
- **Decide outcomes by `kind` and code,** never by message text. `web/src/shared/execution-outcome.ts` decides executions from what they report.
- **Emergency controls (Freeze, Turn off) are never hidden or disabled** by unrelated work.
- **Never present the owner's own action as someone else's change.**
- **Engines fail closed.** Missing, `NaN`, out-of-range or ambiguous input gives hold, frozen or a refusal, never a trade, and never a thrown error a caller might swallow. Validate every configuration.
- **An app-side check only holds back.** The platform enforces the owner's signed policy when a proposal executes. A check in this repo can refuse to propose, but it never replaces the platform's.

## Secrets and new credentials

- **No credential, session, signature or key** goes in an issue, a PR, a log, the audit trail or the repository. `.env` stays untracked.
- **A new credential or signing key** (an anchor key, a bot token, an API key) needs a threat-model entry before its code: what it can do, where it's stored, how it rotates, and what a leak costs. #20 holds the app server's threat model.

## Where decisions live

- **`docs/adr/`:** decisions that later work builds on.
- **The feature's issue:** its design and plan (for example #20 for the app server).
- **`web/PLATFORM-SESSION.md`:** every accessible name the owner UI changes, adds or removes, and each departure from the prototype.

## Versions

- **The platform pin** (in `scripts/stack.ts`, CI and the README) **and `@multiagency/sdk` move together,** in their own PR.
- **Installs respect pnpm's minimum release age.** An exemption in `pnpm-workspace.yaml` says when it can come out.
