# DAO Treasury demo rollout — prepared, not applied

Serve the selected `agentic.sputnik-dao.near` Treasury at `treasury.multiagency.ai` using the
existing **dao** service in the **agentic-treasury / production** Railway environment. Keep its
current `/data` volume, agent settings, grant, operation journal and history in place. This plan
changes the application and domain routing; it does not move funds or migrate agent state.

## Configuration to review

Use [dao-treasury-demo.json](../deploy/dao-treasury-demo.json). It keeps the existing Treasury
executor on port 8789 and the existing payout approve-only instance on port 8790. Payables stays
hidden by the default Treasury frontend; its retained server responsibilities are preserved.
Do not point this deployment at the empty `deploy/dashboard.json` or `deploy/treasury.json`.

| Service | Setting | Intended value |
|---|---|---|
| dao | DASHBOARD_FILE | /app/deploy/dao-treasury-demo.json |
| dao | DASHBOARD_HOST | treasury.multiagency.ai |
| dao | TREASURY_SELF_SERVICE | false |
| dao | Frontend build | PUBLIC_TREASURY_ONLY=true, the default |
| dao | Replicas / deployment overlap | One replica / zero overlap |
| dao | Volume and secrets | Retain existing volume and settings; no credential copying |
| treasury | DASHBOARD_HOST, if retaining wallet access through its generated domain | treasury-production-c98c.up.railway.app |

The **treasury** service is a separate self-service installation with its own volume and existing
wallet workspace. Keep its state intact. Moving its custom domain does not move that workspace.
If access through its generated Railway domain is needed, the owner must apply the matching
`DASHBOARD_HOST` setting and restart that service. Do not copy the DAO's settings or grant into it.
The invoices service and its domain remain outside this rollout.

## Owner procedure

1. Finalize and identify the reviewed source revision, including untracked candidate files and
   the approved branding change. `pnpm verify` must pass for that revision. The current source is
   not deployed merely because existing Railway deployments are healthy.
2. Before any stop or restart, check for an unattended run, active CLI writer, unresolved operation
   or owner-signature attempt. Arrange a quiet maintenance window. Use the stopped-writer backup
   procedure in [operations.md](operations.md#executor-migration-and-state-preservation); preserve
   the entire DAO state directory and settings. Do not discard unresolved records or replay
   an attempted signature. Record current deployment IDs, domains, DNS records and settings privately.
3. Stage the **dao** settings above without triggering an intermediate deployment. Select
   `Dockerfile.dashboard`, one replica and zero overlap. Retain the existing volume and secrets.
4. In Railway, move the custom domain `treasury.multiagency.ai` from **treasury** to **dao**,
   targeting port 8080. Update DNS to the value Railway supplies for the new attachment, including
   any required verification record. Do not assume the old CNAME or certificate is reusable.
   DNS and certificate convergence can interrupt access during the maintenance window.
5. Deploy the reviewed candidate to **dao**, after confirming the prior executor and writers have
   stopped. Verify one running instance before admitting money actions. No second DAO executor
   is started on the separate **treasury** service. Preserve any pre-existing schedule state;
   if a schedule must be paused for maintenance, the owner does that separately and records it.
6. Check domain DNS and certificate status, `/health`, and read-only smoke:

   ```sh
   DASHBOARD_URL=https://treasury.multiagency.ai pnpm smoke
   ```

7. Sign in normally at the new host; old host cookies are not a sign-in migration. Verify the
   selected DAO owner, policy identity, strategy/grant binding, intended schedule state, balances,
   unresolved records, retained plans and run history against the private pre-release observations.
   Verify Payables is absent from navigation and Steward remains a hidden direct route.
8. Only after read-only verification, prepare the low-value demonstration described in
   [DEMO.md](../DEMO.md). Quotes, confirmations, refusals and sweeps are separate owner actions.

Keep `proto.multiagency.ai` attached during initial verification for routing rollback. The gateway
has one configured sign-in host, so do not present the old host as an equivalent authenticated
entry point after cutover. A redirect or domain retirement is a later, separate change.

## Rollback

If the candidate fails before money actions, stop the affected executor before changing the image.
Restore the prior DAO deployment and its prior `DASHBOARD_FILE` and sign-in host, retaining all
current state. Move `treasury.multiagency.ai` back to its former service and restore the privately
recorded DNS/settings as needed. Confirm certificate status and host-bound sign-in again.

If any operations occurred after deployment, retain their records and reconcile unknown outcomes;
never restore an older journal backup over new records. Rollback does not authorize resubmission.
The same single-executor constraint applies during rollback.
