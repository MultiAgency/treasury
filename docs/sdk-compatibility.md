# Frozen SDK 0.5.9 development compatibility

This is the preserved development-candidate record. The current isolated branch uses the [final combined handoff](sdk-final-compatibility.md); the older input pins and results below remain evidence for commit `86c337e` only.

This is the Treasury owner’s local compatibility adoption of the supplied PR86 handoff, dated 12 November 2026. It is not a final release candidate. SDK 0.5.9 remains held, and this work authorizes no publication, deployment, live owner signing or financial action. The candidate omits the separate Paperwork DAO payout additions. A consolidated release requires new exact artifact pins and fresh consumer validation.

The canonical Treasury repository is `/Users/jlwaugh/agencies/agentic-treasury`; the historical `/Users/jlwaugh/agencies/dao/treasury` path is absent. Session `01a1cff2-87f1-7892-92fa-850a79e8a049` owns branch `compat/pr86-sdk-0.5.9` in `/private/tmp/treasury-compat-6f9ef3a`, based on Treasury commit `bc93c4db857a723d947781b1a0cf6bd2023d43ee`. The shared Treasury checkout and the platform/SDK owners’ source and dependency directories are unchanged. The original validation receipt identifies the pre-commit working tree by its manifest and patch hashes instead of attributing the adoption to the base commit. The user subsequently authorized review and commit on this isolated branch; the sibling `commit-receipt.json` associates the resulting commit with that validation and records the documentation-only status update.

## Exact inputs

| Input | Pin |
| --- | --- |
| Platform source | `6f9ef3ae9decb9b073843a9f9c8cfc869ffff49e` |
| Frozen candidate | `e7f171abb42baa5dc6b05d3bb72eb6f3bb43d5d17a80a66c135914bce885be01` |
| SDK tarball SHA-256 | `58d27ef7398770b1c44265b41a165abfda186239711d9979749d7e276c744505` |
| SDK provenance SHA-256 | `09dad5e5043431155875b0a588ad215e5f6e1f2950ed5e1d3daaff7806fe9b70` |
| Gateway manifest SHA-256 | `61b81847cafdd65145ea1e556d2d611211b434baacebe42ccdc1b0bbe8818f89` |
| Supplied handoff SHA-256 | `b1501a3c75d00d4e5ae5fcb3257f500e3c857c5d5a84fb32cc78777c03882306` |

The unchanged SDK tarball, provenance, handoff and gateway manifest are vendored in `vendor/sdk/pr86-6f9ef3a/`. Both server and web use that file dependency; `pnpm-lock.yaml` retains its integrity, and Docker copies it before each dependency install. `pnpm verify:sdk` checks the tarball, sidecar, embedded provenance, source, candidate and gateway manifest. Stack startup checks the exact source commit or frozen snapshot identity and hashes every packaged runtime source against the gateway manifest. A different artifact sharing version `0.5.9`, an old checkout, or a source overlay is refused.

The supplied gateway package was freshly checked: 256 of 256 packaged file hashes matched, and the isolated simulator’s runtime source matched that gateway package. The simulator was copied from the frozen snapshot into `/private/tmp/treasury-platform-pr86-6f9ef3a`, with its own fresh frozen-lockfile dependency install. No historical `node_modules` symlink was reused or mutated. This is source-based simulated gateway compatibility, not a boot or deployment of the supplied production gateway image.

## Scope and behavior

Treasury currently exposes no Market-hire UI, route, consent scope or executor. Adoption preserves that boundary. No money-path implementation or retry behavior was added. The consumer contract tests call the real installed SDK with controlled responses; the platform runner exercises the platform owner’s existing exact-source tests rather than copying its journals or execution implementation into Treasury.

- `funding`, `funding_review` and `unknown` remain observations of the original hire. A top-up may already have moved funds; no replacement hire, inferred refund or completion is justified.
- A DAO hire may remain `pending` with a funding state. The approval ID, hash and hire request ID are retained.
- HTTP 502 with `agent_answer_unverified`, or a lost response, stays unavailable. The SDK performs no automatic retry or replacement filing; the next observation uses the same approval identity.
- Repeated hire filing yields null transactions by default. A test caller’s explicit `recoverProposal: "dao-checked"` requests the original proposal only; it never blindly replays `proposalAndVote`. This guarantee is not applied to Treasury’s consent/setup/proposal-vote filing routes.
- Exact-source offline gates cover funding proof and reservations, approval expiry, repeated filing/recovery, lost or unverified replies, legacy funding refusal and unknown outcomes.
- The platform’s frozen old journal readers refuse v3 Market records without rewriting them. The old hosted registry reader refuses a mixed Market registry while preserving it. Every directory in these tests is fresh and synthetic; no retained application or production state is opened. Old executors must never be pointed at newer incompatible journals, and rollback must not delete or convert records.

## Reproduce and inspect receipts

Use Node 24, pnpm 12.16.1 for Treasury, and the platform’s own package manager pin for its isolated source copy. The README shows a new exact-commit source checkout. For the supplied snapshot, use the isolated copy path above.

```sh
export TREASURY_PLATFORM=/private/tmp/treasury-platform-pr86-6f9ef3a
pnpm install --frozen-lockfile
pnpm verify:sdk
pnpm check
pnpm build
pnpm --filter @treasury/web test:stack
pnpm --filter @treasury/server test:stack
pnpm test:compatibility
```

The compatibility runner requires Node 24 or later and invokes only the platform’s existing offline test launcher, which discards inherited application credentials and guards external networking. It prints hashes of the exact platform test files used. The browser suites simulate the provider, chain and wallets, and include accessibility scans. These tests do not prove real-provider behavior or hosted settlement.

Fresh Node 24 results: 1,214 Treasury unit tests (631 server, 181 web, 402 core), 67 wallet/DAO browser tests including accessibility scans, 24 server stack tests passed with three existing TODOs, and 187 exact-source platform compatibility tests passed. Typechecks, the production web build, frozen-lockfile install and local Docker build passed. A network-disabled container inspection verified the installed SDK source/candidate and tarball hash; it did not start the app.

Fresh receipts, logs, app source manifest, review patch and dependency identities are retained in `.test-artifacts/sdk-compatibility/pr86-6f9ef3a/receipt.json` and its sibling files in the isolated Treasury worktree. Three existing server stack cases remain TODO; the complete wallet/DAO browser suite separately exercises the existing owner flows. The isolated local image build is a packaging check only. No image is published or deployed, and the branch is not pushed. GitHub CI has been repinned for later user review, but is not claimed as run on this local branch.
