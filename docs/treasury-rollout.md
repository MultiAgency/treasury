# Treasury release review — no topology change approved

The focused destination is `treasury.multiagency.ai`, with the existing
`agentic.sputnik-dao.near` Treasury as the reference and optional wallet/DAO registration.
Proto remains the umbrella showcase for three ideas. The earlier proposal to attach both
hosts to a Treasury-only gateway and redirect Proto is superseded; do not apply it.
This document prepares review, not deployment, DNS changes, restarts or state migration.

The [focused reference integration](treasury-reference-integration.md) is the concrete local
option for preserving both installations. Its example hostname remains subject to owner review;
it reuses Proto’s candidate host routing and adds no executor or state migration.

## Candidate configuration

[dao-treasury-demo.json](../deploy/dao-treasury-demo.json) keeps the historical DAO Treasury agent on
port 8789 and payout agent on port 8790, both approve-only: Proto executes for them. It has no redirect hosts.
It is an explicit candidate for review, not evidence of current hosting. The default
`deploy/treasury.json` has no preset agents and must not silently replace existing DAO settings.
The duplicate local `treasury-reference.json` candidate has been consolidated into this file.

## Decisions required before release

- Verify the actual project, service, domain, deployment, volume and executor assignments
  read-only. Historical Proto DAO links and the separate Treasury wallet installation do not
  establish today's mapping.
- Decide how the DAO reference becomes accessible at Treasury while preserving the existing
  wallet installation and its sign-in/access destination. Do not merge registries or copy grants
  into another running executor.
- Preserve Proto's umbrella experience and verify successors for historical authenticated
  Treasury and Payables links before retiring any routes. Treasury-only navigation cannot
  substitute for Payables access. Proto's evolving sibling directory is context, not an approved
  deployment or platform-extraction plan.
- Review whether optional Treasury registration is enabled. Registration signs nothing;
  offline acceptance does not establish a hosted owner-signing lifecycle.

## Owner release gates

1. Finish concurrent edits and freeze one identifiable candidate, including required new files.
   Run `pnpm verify`; local passing tests are not deployed-provider evidence.
2. Check for unattended runs, active writers, unresolved operations and attempted owner
   signatures. Arrange a quiet maintenance window before any restart or state copy.
3. Follow [state preservation](operations.md#executor-migration-and-state-preservation).
   Preserve the complete state and settings, including registered children and retained sibling
   records. Exactly one executor may run per agent; the lease is single-host only.
4. The owner reviews and performs any deployment or routing change separately. Preserve the
   intended schedule state; signing a strategy and enabling its schedule are separate actions.
5. Verify health, host-bound sign-in, displayed owner, policy/grant/strategy binding, schedule,
   private access, public boundaries and retained operation/run records read-only. A health
   check alone does not establish safe executor ownership.
6. Rehearse [DEMO.md](../DEMO.md) with previews or retained evidence. Any real signing, execution
   or sweep requires a separate request; never run `pnpm test:live` as a release check.

Rollback stops the affected executor before restoring the prior application or routing,
retains all new records and verifies one executor per agent. Never restore an older journal over
new operations or resubmit an attempted owner signature. Live assignments and the full new-owner
hosted lifecycle remain unverified by this source cleanup.
