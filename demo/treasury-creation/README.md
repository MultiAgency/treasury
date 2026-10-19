# Treasury creation on Proto hosted setup

**Shows:** a Treasury frontend release creating a new treasury agent through its own screens (create →
onboarding → setup progress) on a local Proto stack, with Proto's hosted setup (`POST /gw/agents`), a
simulated provider and the test owner wallet. Everything is simulated; no real funds, credentials or
signatures are involved.

```sh
node demo/treasury-creation/run.mjs --proto <Proto stack snapshot or checkout>
# options: --release <Treasury release dir> (default .test-artifacts/releases/treasury-a6),
#          --previous <release dir> (release B for Proto's release server), --headed
```

The snapshot is verified and copied as for the [strategy recipe](../treasury-strategy/README.md).
Proto's harness serves an owner-app release on a host with no hosted setup areas, so the run applies a
**test-only overlay** to its own copy of `test/e2e/environment.mjs`: an `ownerApp.setupAreas` option that
adds the host's `hostedAreas` and enables `selfService`. The receipt records the file's sha256 before
and after and both replacements; Proto's snapshot is unchanged and checked after the run.

The owner signs in at `/`, chooses **Continue** (wallet owner), and the run checks that the reservation is
exactly `POST /gw/agents {owner, kind: "wallet", area: "treasury"}`. It then chooses **Create agent**,
the test wallet signs the one prepared request, and setup progress (**Continue setup**) must report the
agent the provider created, its policy in force and no grant yet. A reload resumes there without a new
owner request. It also checks that `/gw/treasuries` is never called and that nothing is sent (no
rebalance, execution, sweep, payment, funding, strategy save or schedule change).

## Runs

**2026-10-19 UTC**, `run-dkBP0E`, on Proto's review candidate snapshot
`92815f4a75b45810eed815648f73769ea1a4b614b0ba66e137abbfa98389dd6f` (`unchangedAfterRun: true`) with
release A6 (`13ad983b…8d1a`), harness overlay `50033e22f95d…`, Node 24.22.0. Result **unexpected**: 12 of
13 checks pass; one known defect fails.

- **Passes:** hosted setup offered; `POST /gw/agents` with the expected body; a fresh `own-…` workspace;
  registration signs and creates nothing; one owner signature; the provider's created agent
  (`e713f647…`) is the one setup reports, with its policy in force and no grant; reload resumes without
  a new request; no `/gw/treasuries`; no send; one `owner/prepare` and one `owner/submit`; no page errors,
  unexpected requests or simulator errors.
- **Fails, known defect:** the new workspace first shows **Access unavailable**. Proto's gateway keeps a
  hosted agent closed until its server first answers (by design), and Treasury loads the workspace right
  after the reservation, then keeps that first answer. The run records the identity reads (no access at
  first, access about 15 s later) and continues through the page's own **Check access again**.
  Agreed fix (Proto, after the review checkpoint): `POST /gw/agents` waits, within a bounded budget, for
  the hosted agent's first owner answer before replying, keeping fail-closed access. Proto will also take
  the `ownerApp.setupAreas` option upstream, and this run then drops its overlay.

Not covered: a DAO-owned treasury, and the policy, grant, strategy and funding steps after creation.
