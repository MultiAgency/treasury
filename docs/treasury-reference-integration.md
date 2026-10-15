# Focused Treasury access to the existing DAO executor

This is a local integration candidate, not deployment guidance to apply automatically. The
funded DAO reference can use Treasury's focused frontend through Proto's existing candidate
host routing. No new executor, money API, state migration or frontend platform extraction is
needed. Proto source and its product have not been changed by this work.

The read-only hosting inspection on 2026-10-15 UTC identified DAO service deployment
`f3c78026-3826-4380-a94a-9947277b38fa` and wallet Treasury deployment
`07c31669-3ebe-4cc2-ba93-a87009e16c51`, each with a separate `/data` volume and
agent identity. This proposal preserves that inspected executor/state split. It does not
certify later deployments or the entire evolving Proto working tree.

## Recommended boundary

Keep `treasury.multiagency.ai` attached to the existing **treasury** service. Its wallet agent,
`.treasuries` registry, onboarding, volume and host-bound sign-in remain there. Keep
`proto.multiagency.ai` on **dao**, with its own umbrella showcase and retained scoped routes.

Use a separately reviewed reference hostname on **dao**, with Treasury's independently built
frontend and only the existing `treasury` agent assigned. `reference.treasury.multiagency.ai`
is the example, not an approved DNS attachment or a deployed URL. It opens the same focused
Treasury interface; its authenticated entry is `/a/treasury/`. The existing `.env.dao`, port
8789, agent ID, grant, journal, plans and history remain on their current executor.
The payout child stays approve-only and Invoices keeps its payout executor.

A separate hostname has a cost: owners sign in separately and its agent list does not include
the wallet installation. This is explicit isolation, not seamless account consolidation. Do not
add public navigation to the example address before it works. No private financial observations
or owner roster belong in the public entry.

Putting both installations under the exact current hostname would require additional path
routing to distinct gateways, with deliberate session, origin, URL and failure handling. Moving
both agents to one gateway would require stopped-executor state migration between incompatible
registries. Neither is the smallest change for a focused demo. The reference-host candidate
keeps both options open without committing to either or displacing the wallet installation.

## What is reused

The sibling `/Users/jlwaugh/agencies/proto` candidate implements `frontendDist` per configured
host in `src/gateway/config.ts` and `src/gateway/server.ts`. Its host routing derives separate
session keys, signs challenges for the actual host, scopes discovery and RPC to assigned agents,
checks the existing owner permissions on each call, and refuses sibling-origin requests.
It forwards accepted calls to the existing loopback agent server. Host selection ignores
`X-Forwarded-Host`. These are source/offline properties; the host-aware candidate is not the
currently deployed legacy gateway.

Treasury's existing gateway adapter accepts both the standalone `/gw/treasuries` contract and
the shared `/gw/agents` contract when advertised. On the reference host, `hostedAreas: []`
keeps creation off; the wallet host retains its own onboarding. No authorization rule was
added or changed here. Hidden Payables routes are not a server authorization boundary; the
reference host's agent assignment is the relevant existing routing restriction.

## Reviewable artifacts

Build a fresh, focused asset package:

```sh
node scripts/package-treasury-frontend.mjs .test-artifacts/treasury-reference-candidate
node scripts/test-treasury-reference.mjs ../proto .test-artifacts/treasury-reference-candidate
```

Use a new output directory for each candidate; the packager refuses to overwrite one. It forces
`PUBLIC_TREASURY_ONLY=true`, builds in an isolated directory without reading `.env` files or
inheriting application credentials, checks for source changes during the build, and packages only frontend
assets plus a hash manifest. It starts no server or executor and copies no settings or state.
The manifest records the Treasury source digest and every asset's size and SHA-256. Ordinary
`web/dist` assets are not replaced.

[treasury-reference-host.example.json](../deploy/treasury-reference-host.example.json) is a host-map
fragment, **not** a complete `DASHBOARD_FILE`. During a separately reviewed infrastructure release,
merge only that entry into the reviewed gateway's `hosts` map and include the frontend directory
at the stated absolute path. Preserve the Proto host entry, existing agents, executor assignments,
self-service settings, intake routing and state. If introducing explicit hosts to a legacy config,
the default Proto host must also have its reviewed showcase assignment and intended `hostedAreas`;
do not replace it with this one-entry fragment or use the broader shared-demo domain-move plan.
The fragment does not attach `treasury.multiagency.ai`, Payables or Invoices to **dao**.

## Offline verification and limits

The integration runner sanitizes its environment and blocks non-loopback traffic. It copies Proto's
current source and default built frontend to a temporary directory, verifies the source digest,
and runs the actual gateway against one simulated DAO backend and local chain observations.
It never edits Proto or starts an agent process. It checks:

- Signed-out discovery returns no agents and reads no backend records.
- A DAO group member reaches the focused Treasury UI; a nonmember is refused.
- Sign-in challenges name the reference host; a copied Proto cookie does not authenticate there.
- Sibling-origin calls, unknown hosts and payout-agent calls are refused before reaching the backend.
- Accepted observation calls preserve their exact scoped paths/query strings and omit browser
  cookies and Origin on loopback forwarding. Private responses remain `private, no-store`.
- The reference entry cannot reserve another agent; it creates no registry or child settings.
- Proto's default HTML is byte-for-byte unchanged. This checks asset selection, not the completeness
  of Proto's three-idea design or its separate release acceptance.
- The packaged focused UI loads through the actual gateway at desktop and mobile sizes, shows
  the DAO owner, signed limits and schedule state, and submits no money or owner actions on entry.

The output includes `integration-result.json` with both source digests and screenshots under
`inspection/`. These are offline observations with simulated ownership and balances, not new
mainnet or deployed-provider guarantees. The test exercises an existing DAO backend endpoint;
it does not certify a live signing, execution or new-owner lifecycle.

## Separate owner release decision

Before any release, freeze and review both exact candidates and their lockfiles. The current Proto
working tree includes unrelated evolving product work; passing this integration does not approve
that entire tree for deployment. The owner must review its infrastructure release separately.

Review the reference hostname, image inclusion path, actual project/service/volume assignments and
host-bound sign-in. Preserve all state with the stopped-writer procedure in
[operations](operations.md#executor-migration-and-state-preservation). Keep one executor per agent;
leases remain single-host coordination, not distributed fencing. Adding explicit hosts changes
legacy dashboard session handling, so require normal sign-in again and verify existing Proto access.
No existing domain, wallet registry, grant, schedule or executor assignment needs to move for this option.

After an owner-authorized release, verify health, public boundaries, DAO membership denial,
reference identity, policy/grant/strategy, schedule and retained run/operation URLs read-only.
Quote-only rebalance and Sweep Preview require their own bounded rehearsal; execution is separate.
Rollback restores the prior image/configuration while retaining all new state and records. A
frontend rollback must never restore an old journal or start another executor.

Local validation on 2026-10-15 UTC: typecheck, all 735 offline tests, generated evidence
consistency, the four standalone Treasury browser suites, and the explicit reference integration
passed. The initial concurrent offline run had one registration HTTP fixture failure; its isolated
rerun and the complete rerun passed without changing the fixture or gateway behavior. The tested
asset package is `.test-artifacts/treasury-reference-final`; its manifest and integration result
identify the Treasury build and Proto source digests. These results apply to those local snapshots,
not a deployed release or an approval of unrelated working-tree changes.
