import assert from "node:assert/strict";
import { test } from "node:test";
import { CONSENT_PREFIX, ConsentRefused, checkConsent, consentDescription, consentDigest, verifyConsent, type ConsentProposal, type ConsentRequest, type ConsentTerms } from "../src/gateway/dao-consent.js";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const request: ConsentRequest = { agent: "treasury", agentId: "a".repeat(64), host: "treasury.test", label: "Treasury assistant", scopes: ["read", "prepare"], ttlSeconds: 3_600 };
const terms: ConsentTerms = { ...request, issueBy: "2026-10-23T12:00:00Z" };
const filedAt = (ms: number) => String(BigInt(ms) * 1_000_000n);
const proposal = (over: Partial<ConsentProposal> = {}): ConsentProposal =>
  ({ id: 7, description: consentDescription(terms), status: "Approved", kind: "Vote", submission_time: filedAt(NOW - 60_000), ...over });
const refused = (p: ConsentProposal | null, req: ConsentRequest = request, now = NOW, id = 7) =>
  assert.throws(() => checkConsent(p, id, req, now), ConsentRefused);

test("an approved Vote proposal that names exactly this credential is the DAO's consent", () => {
  const { digest, terms: read } = checkConsent(proposal(), 7, request, NOW);
  assert.equal(digest, consentDigest(consentDescription(terms)));
  assert.deepEqual(read.scopes, ["prepare", "read"], "scopes are compared as a set, in a fixed order");
  // Scope order in the request does not matter; a shorter lifetime than approved is fine.
  checkConsent(proposal(), 7, { ...request, scopes: ["prepare", "read"], ttlSeconds: 60 }, NOW);
  // The host is compared without case.
  checkConsent(proposal(), 7, { ...request, host: "TREASURY.TEST" }, NOW);
});

test("a proposal that is missing, another id, not approved, or not a plain Vote is not consent", () => {
  refused(null);
  refused(proposal({ id: 8 }));
  for (const status of ["InProgress", "Rejected", "Removed", "Expired", "Moved", "Failed"]) refused(proposal({ status }));
  // Anything that executes something as well as voting cannot be consent.
  for (const kind of [{ Transfer: {} }, { FunctionCall: {} }, { ChangePolicy: {} }, { AddMemberToRole: {} }, "Vote2"]) refused(proposal({ kind }));
});

test("a description that is not a machine-credential consent is refused", () => {
  for (const description of ["", "please approve", `${CONSENT_PREFIX}`, `${CONSENT_PREFIX}\n{not json`, `${CONSENT_PREFIX}\n{}`,
    `${CONSENT_PREFIX}\n${JSON.stringify({ ...terms, extra: true })}`, `other/v1\n${JSON.stringify(terms)}`,
    `${consentDescription(terms)}\nand more`, `${CONSENT_PREFIX}\n${JSON.stringify({ ...terms, scopes: ["read", "read"] })}`,
    `${CONSENT_PREFIX}\n${JSON.stringify({ ...terms, ttlSeconds: 86_401 })}`, `${CONSENT_PREFIX}\n${JSON.stringify({ ...terms, issueBy: "tomorrow" })}`])
    refused(proposal({ description }));
});

test("the approval must cover every part of the credential asked for", () => {
  refused(proposal(), { ...request, agent: "other" });
  refused(proposal(), { ...request, agentId: "b".repeat(64) });
  refused(proposal(), { ...request, host: "elsewhere.test" });
  refused(proposal(), { ...request, label: "Another label" });
  refused(proposal(), { ...request, scopes: ["read"] });
  refused(proposal(), { ...request, scopes: ["read", "prepare", "sweep"] });
  refused(proposal(), { ...request, scopes: ["read", "execute-plan"] });
  refused(proposal(), { ...request, ttlSeconds: 3_601 });
});

test("an approval expires: after its issue-by time and after thirty days", () => {
  checkConsent(proposal(), 7, request, Date.parse(terms.issueBy));
  refused(proposal(), request, Date.parse(terms.issueBy) + 1);
  const long: ConsentTerms = { ...terms, issueBy: "2027-01-01T00:00:00Z" };
  const old = proposal({ description: consentDescription(long), submission_time: filedAt(NOW - 31 * 24 * 3_600_000) });
  refused(old);
  checkConsent(proposal({ description: consentDescription(long), submission_time: filedAt(NOW - 29 * 24 * 3_600_000) }), 7, request, NOW);
  refused(proposal({ submission_time: "not a number" }));
});

test("verifyConsent reads the chain, and a chain that cannot answer is a refusal", async () => {
  const seen: unknown[] = [];
  const ok = await verifyConsent("dao.near", 7, request, NOW, async (dao, id) => { seen.push([dao, id]); return proposal(); });
  assert.deepEqual(seen, [["dao.near", 7]]);
  assert.equal(ok.digest, consentDigest(consentDescription(terms)));
  await assert.rejects(verifyConsent("dao.near", 7, request, NOW, async () => { throw new Error("rpc down"); }), ConsentRefused);
  await assert.rejects(verifyConsent("dao.near", 7, request, NOW, async () => null), ConsentRefused);
});
