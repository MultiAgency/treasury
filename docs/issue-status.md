# Issue status on harjaap-branch

The 31 open issues worked on this branch: every open issue except #60 and #61, which are assigned to ayushsingh82. Commits say `Closes #n` where the work is complete, so each issue closes when the branch merges to `main`. The engine work from `core-stack` (open PRs #98 and #68–#82) is included.

| Issue | Area | Status | What landed (commit) | Still open |
|---|---|---|---|---|
| #25 A3 epic | oracle | Done | with #29, #35 | – |
| #29 A3.1 quote checks | oracle | Done | on main (#96); a malformed quote now freezes (2bb2376) | – |
| #35 A3.2 EMA, TWAP, warm-up | oracle | Done | on main (#96) | – |
| #26 A4 epic | bands | Done | with #36–#38 | – |
| #36 A4.1 zones | bands | Done | core-stack; missing band table holds (2bb2376) | – |
| #37 A4.2 sizing, guardrails | bands | Done | one per-order cap shared with the policy (6d83b45) | – |
| #38 A4.3 anti-whipsaw | bands | Done | disarm every line crossed; partial state holds (ed05350) | – |
| #63 rename Proposal to Intent | bands | Done | core-stack | – |
| #27 A5 epic | policy | Done | with #48–#50 | – |
| #48 A5.1 limits | policy | Done | shared cap (6d83b45) | – |
| #49 A5.2 venue, cash floor | policy | Done | zero spend can't switch the floor off (048b23d) | Platform can't sign these limits (SDK report 3.2) |
| #50 A5.3 levels, stale approval | policy | Done | approvals bound to their order; level checked (e7bfbe4) | – |
| #43 A6 epic | detectors | Done | with #51, #52 | – |
| #51 A6.1 market moves | detectors | Done | stale history, bounds, config, intraday peaks (27219e5) | – |
| #52 A6.2 data and system | detectors | Done | core-stack | Live inputs arrive with A10.1 (#60) |
| #44 A7 epic | audit | Done | with #90, #54, #55 | – |
| #90 chain.ts fixes | audit | Done | 48e2a17 | – |
| #54 A7.2 replay same decision | audit | Done | decision records and replay (2b65f0c) | Records are appended once the engines run in the server (#60) |
| #55 A7.3 head-hash anchor | audit | Built | hourly anchor on NEAR, read back and checked (d92974c) | Needs a NEAR account and a function-call key to run for real |
| #45 A8 epic | backtest | Done | with #56, #57 | – |
| #56 A8.1 replay harness | backtest | Done | core-stack | – |
| #57 A8.2 history, calibration | backtest | Built | core-stack | 12-month price data (H5) |
| #46 A9 epic | mandate | Done | with #58 (#59 closed as covered by the platform) | – |
| #58 A9.1 mandate compiler | mandate | Built | core-stack | Questions, profiles and sleeve labels (H8, H6) are placeholders |
| #7 Owner UI portfolio | web | Built | rebalance, plan outcome, runs, Run now, attention, steward (24bb3b5) | No stack test yet; owner UIs move to `/apps/v1` later (platform#14) |
| #9 Guided walkthrough | web | Done | `/demo` (24bb3b5) | – |
| #12 Treasury creation | web | Built, blocked | creation, access wait, onboarding (05340d1) | No host or stack offers Treasury setup; `/gw/agents` has no SDK schema |
| #20 App server | server | Done | DAO-owned agents and missing tests (dfd70da) | DAO consent isn't on any host yet |
| #47 A10 umbrella | SDK flows | Out of scope | – | Only #60 and #61 remain (ayushsingh82) |
| #62 A23 SDK re-scope | SDK | Done | the gap table is section 3 of the SDK report | Needs posting on the issue |
| #95 Staging, red-hand stop | ops | Blocked | – | A staging `/apps/v1` host, a `tap_` credential, and an emergency freeze from the platform |
