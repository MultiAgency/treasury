# 1. Owner pages on the owner session; agents and proposals through the app server

**Status:** accepted, 2026-11-04; reopened 2026-11-04; superseded 2026-11-05 by [ADR 2](0002-owner-ui-app-access.md) · **Platform:** `1a7fe98` (tag `sdk-v0.4.0`)

**Reopened:** two of the conditions under "What would reopen it" have happened. MultiAgency/platform#14 answered that the owner session gets no production host, so the owner pages move onto the app route. SDK 0.5.0 (`6ba0831`) brings DAO-owned agents to the app route only. Which owner-session procedures the app route gains is MultiAgency/platform#17.

**Superseded:** ADR 2 replaces the owner pages' destination, moving them behind this repository's app server, which already serves agents and proposals as decided here. The owner-session build stayed as the simulated-stack reference until it was retired in #189.

## Decision

- **The owner pages** in `web/` (Overview, Strategy, Policy & grants, Operation status, Balances & funding, Runs) call the platform through the **owner's session**: same-origin `/a/<agent>/`, `ownerClient`, and every owner action signed in the owner's own wallet.
- **Agents and proposals** go through **this repository's app server** (`apps/server`, #20). It holds the deployment's `tap_` credential and calls `/apps/v1` from the server. The proposals page is served by it and calls only its `/api/` routes.

## Why

The platform enforces three things:

- **`/apps/v1` is server to server.** It refuses any request carrying an `Origin` or `Cookie` header ([`app-routes.ts:60`](https://github.com/MultiAgency/platform/blob/1a7fe9818e2a83c548e1ba8d587f10acac37716a/src/gateway/app-routes.ts#L60)), so a browser can't call it.
- **Proposals are app-only.** `caller()` requires an `app:<deployment>:<organization>` caller with a live owner consent ([`proposals/service.ts:38-44`](https://github.com/MultiAgency/platform/blob/1a7fe9818e2a83c548e1ba8d587f10acac37716a/src/proposals/service.ts#L38-L44)). The owner session can't create or list them.
- **The app route doesn't offer everything the owner pages use.** App scopes cover reads, `owner/*`, payouts and the Treasury procedures ([`contract/app-access.ts`](https://github.com/MultiAgency/platform/blob/1a7fe9818e2a83c548e1ba8d587f10acac37716a/src/contract/app-access.ts)). They don't cover `setup`, `reconcileBooks`, `recover`, `treasury/link`, `treasury/fund`, `autopilot/tick` or `steward/propose`, and NEP-413 is the only kind of intent an app receives: freeze, unfreeze and on-chain policy edits go to the platform's confirm page instead (MultiAgency/platform#14).

So each half takes the only route that does its job. The owner pages need the full set of owner procedures, which only the owner session has. An agent has to propose while no browser is open, which takes a server holding a credential, and only the app route accepts proposals.

## Consequences

**What we get:**
- **The server holds no owner power.** It never holds anything that can sign an owner action. Freeze, policy and grants are signed in the owner's wallet, and an approval carries the owner's own signature, which the platform verifies.
- **A small server.** It handles only consent, proposals and the agent, which keeps its threat model, attack surface and quota use small: the platform allows one credential 1,200 calls an hour, shared by all of a deployment's owners (MultiAgency/platform#15).
- **It's what is built:** #13–#22 and #75 on the owner session, and #31 and #76 for the app server.

**What it costs:**
- **Two sign-ins.** The owner signs in to the platform's owner session, and separately to this server (NEP-413) for the proposals page: two origins, two cookies.
- **Two ways the browser reaches data.** `web/src/platform.ts` is the owner session's; the proposals page calls the app server's `/api/` routes. They stay separate modules with separate failure handling.
- **A consent step.** Before an agent can propose, the owner signs a consent naming the agent with the `read` and `treasury` scopes.

## Alternatives rejected

- **Everything through the app server.** It loses the procedures above: the frame's `setup`, Activity's books and recovery, and funding. It would also make the server relay every owner action, widening its role and spending the shared quota on page reads.
- **Everything on the owner session.** Proposals are impossible there, so there's no agent.

## What would reopen it

- **MultiAgency/platform#14 answers that the owner session gets no production host.** The owner pages then move onto the app route, which first needs the platform to offer the procedures above.
- **The app route gains every owner procedure.** Then one sign-in becomes worth weighing.
- **DAO-owned agents** (MultiAgency/platform#13, SDK 0.5.0) arrive differently on the two routes.
