# Final combined SDK 0.5.9 consumer compatibility

This record covers isolated Treasury consumer validation against the platform owner’s final combined handoff, dated 12 November 2026. The source includes PR86 Market funding protection, Paperwork DAO payouts and bounded historical receipt coverage. Treasury app publication, push/merge/tag, deployment, staging restart, credential mutation and live signatures or financial actions remain unauthorized. SDK 0.5.9 was subsequently published; the coordinator’s publication receipt verified that its public tarball is byte-identical to the artifact tested here. Backup success is not restart clearance. The artifact’s designation as the final combined candidate does not establish consumer acceptance, deployed behavior or release permission.

Owner: Treasury session `01a1cff2-87f1-7892-92fa-850a79e8a049`. Repository: `/Users/jlwaugh/agencies/agentic-treasury`. Isolated branch/worktree: `compat/final-sdk-0.5.9`, `/private/tmp/treasury-compat-final-252cba1`, based on local development-adoption commit `86c337e867fdb93915727bbc4407f2115f810a9c`. The earlier development branch, artifacts and receipts are preserved. No shared platform checkout, dependency environment, peer source or retained application state is changed. The original validation receipt identifies the pre-commit working tree through source-manifest, patch and archive hashes. The user subsequently directed review and local progress; `commit-receipt.json` associates the reviewed local commit with that evidence and records the documentation-only publication/status corrections.

## Exact authoritative inputs

| Input | Identity |
| --- | --- |
| Supplied final handoff SHA-256 | `67d6a3fdd5b2858803485e29c4c6c29693b14bb47760f39c144992a5fb87c634` |
| Signed platform source commit | `252cba1d1e6642a5ea9f42ea4927f982423ed8e1` |
| Platform Git tree | `f3f5f18eaaa16a50ab574d7211287192483bb1ed` |
| Source archive SHA-256 | `2bb86484271a7e7613550a1b16f56e967e271758cf1f3a4bedc8541c79ddfc0c` |
| Frozen candidate digest | `822346ac5b50313d493c951971695abbbab5cc1d5a48ca8868bc73421a609a40` |
| SDK tarball SHA-256 | `4ae53dce669664bcf90e0c5939e0ac617db0ab24c101e3792fc659ac4494475a` |
| SDK provenance SHA-256 | `9feb6034ccddf90c6cc16c81247c10d265094eef6d457e17cbe3f3ce5de8dd3c` |
| Gateway manifest SHA-256 | `8043058f5e55bf176597d70d3b83ebfebbef33eff436bb5739a602176d19b17a` |
| Release manifest SHA-256 | `e61553bdaa541f2a6201d71f499062bafd342012efadb9c77692008352000066` |
| Supplied gateway image ID | `sha256:9daf951d59ba40eb944d53a595ed214180254534b2e5c8cff93b448ad95dd195` |
| Supplied gateway image archive SHA-256 | `6e891b6502f574d34482a3e508b9acd95b146955ecdf387ff6beb4c3cd745f4e` |

SDK version `0.5.9` alone is not an identity: the development and final tarballs differ. Both Treasury packages and the lockfile now resolve `vendor/sdk/final-252cba1/multiagency-sdk-0.5.9.tgz`. The final handoff, sidecar, gateway manifest and release manifest are retained alongside it. The old `vendor/sdk/pr86-6f9ef3a/` directory is historical evidence only. Both Docker dependency stages explicitly copy the final directory; they install from the same lockfile. `verify:sdk` checks handoff/release/SDK/provenance/gateway identities, and records the matching gateway image pin. Stack/CI source pins move to `252cba1` together.

Fresh input verification checked the handoff, source archive, release manifest, SDK tarball and sidecar hashes; sidecar/embedded provenance equality and 57 clean SDK source inputs; all 256 packaged gateway file hashes; and the whole supplied gateway image archive hash. The owner’s SSH signature verification is reported by the authoritative handoff, not independently re-performed by Treasury.

The simulator source was extracted from the verified source archive into `/private/tmp/treasury-platform-final-252cba1`. Its frozen metadata matches the handoff, and its runtime source bytes match the packaged gateway. Dependencies were installed freshly there using its frozen lockfile; the owner’s historical dependency symlink and source checkout were not reused or mutated. Treasury stack startup independently validates runtime source hashes before spawning any stack. These consumer runs exercise that exact-source gateway with simulated provider, chain and wallets; they do not run the supplied gateway image or establish real-provider outcomes.

## Fresh consumer validation

Use Node 24 and Treasury pnpm 12.16.1. Platform dependencies use its own package-manager pin. The exact pinned source commit now resolves through GitHub. Use a new exact-commit checkout as shown in the README, the supplied source archive, or the retained local owner repository; do not switch a shared checkout.

```sh
export TREASURY_PLATFORM=/private/tmp/treasury-platform-final-252cba1
pnpm install --frozen-lockfile
pnpm verify:sdk
pnpm check
pnpm build
pnpm --filter @treasury/web test:stack
pnpm --filter @treasury/server test:stack
pnpm test:compatibility
```

`apps/server/test/sdk-compatibility.test.ts` verifies the installed server/web provenance, rejects the old development snapshot and other mismatched/overlaid snapshots, and covers `funding`, `funding_review`, `unknown`, pending DAO-hire identity, `agent_answer_unverified`, lost responses and explicit checked proposal recovery. No replacement identity or blind `proposalAndVote` replay is introduced. Treasury still exposes neither a Market-hire workflow nor Paperwork payout routes; its existing consent, owner-action and money-path implementation is unchanged. The compatibility checks use the real installed SDK with controlled responses at that boundary.

`test:compatibility` invokes the platform owner’s exact-source offline launcher, with credentials discarded and external networking guarded. It exercises existing gateway, funding proof/reservation/expiry, unknown outcome, legacy funding, DAO recovery and old journal/registry refusal tests in fresh synthetic directories. No journal reader or platform money-path implementation is copied into Treasury. Old executors must not reopen incompatible journals; no records are deleted or converted for rollback.

Fresh Node 24 validation passed: 1,214 Treasury unit tests (631 server, 181 web, 402 core), 67 wallet/DAO browser tests including accessibility scans, 24 server stack tests with three existing TODOs, and 192 exact-source platform compatibility tests. Typechecks, the browser suite’s production web build, frozen-lockfile install and a new local Treasury image build passed. Network-disabled image inspection confirmed the final SDK/source/candidate/gateway pins and absence of the prior development artifact from the runtime image.

Exact commands, source/artifact identities, dependency identities, local image ID and hashed logs are recorded in `.test-artifacts/sdk-compatibility/final-252cba1/receipt.json` in the isolated Treasury worktree. The prior development receipt’s passes are not reused as final-candidate evidence. GitHub CI is prepared with the new source pin but is not claimed as run without a push.

## Remaining boundaries

SDK publication does not clear Treasury app publication, staging deployment/restart or Market rollout holds. The coordinator’s SDK publication receipt is recorded separately at `/Users/jlwaugh/agencies/dao/sdk/.test-artifacts/release-handoffs/pr86-0.5.9-20261112/coordinator-sdk-publication-receipt.json` (SHA-256 `a2791e6354c84f23f6b0a086749c0fce50ea9b42f8ea90a5a2eb2ba554d07642`); the frozen inputs and original test receipts remain unchanged. Market destination-route proof and legacy key/funding recovery are not cleared by simulated consumer tests. Paperwork performs its own final consumer verification. Three existing Treasury server-stack TODO cases remain distinct from the full wallet/DAO browser coverage. Consumer verification does not clear shared provider keys, external writers/grants, production state, backup restoration fidelity or whole-image rollback qualifications. No staging command, live credential, live wallet/quorum signature or live financial action is part of this work.
