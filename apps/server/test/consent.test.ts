import { test } from "node:test";
import assert from "node:assert/strict";
import { consentMessage, parseConsentMessage } from "@multiagency/sdk";
import { CONSENT_DAYS, checkConsent, consentText, liveConsents, organizationOf } from "../src/consent.ts";

/** The decoding decision 5 promises: each "--" back to ".". */
const accountOf = (organization: string) => organization.replaceAll("--", ".");

const DAY = 86_400_000, now = Date.parse("2026-11-03T12:00:00Z");
const identity = { agent: "portfolio", owner: "owner.near", agentId: "id-portfolio", host: "platform.test" };
const expected = { identity, deployment: "treasury", now };

test("the Organization is the owner's account with each '.' written as '--', and turns back exactly", () => {
  assert.equal(organizationOf("owner.near"), "owner--near");
  assert.equal(organizationOf("my_dao.sputnik-dao.near"), "my_dao--sputnik-dao--near");
  for (const account of ["owner.near", "a-b_c.d.near", "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de", "0x" + "ab".repeat(20), "x".repeat(2)])
    assert.equal(accountOf(organizationOf(account)), account, account);
  const longest = `${"a.".repeat(31)}ab`;
  assert.equal(longest.length, 64);
  assert.ok(organizationOf(longest).length <= 128, "a 64-character account fits the platform's 128");
  assert.match(organizationOf(longest), /^[A-Za-z0-9_-]{1,128}$/, "the platform's pattern");
});

test("the consent text names this deployment, the owner's Organization, the agent's identity, and read and treasury only", () => {
  const text = consentText(expected);
  assert.equal(text.recipient, "platform.test", "the platform's host, never this server's");
  assert.equal(Buffer.from(text.nonce, "base64").length, 32);
  assert.equal(Buffer.from(text.nonce, "base64").toString("base64"), text.nonce, "canonical base64");
  assert.deepEqual(parseConsentMessage(text.message), {
    type: "multiagency.app-consent", version: 1, host: "platform.test", deployment: "treasury", organization: "owner--near",
    owner: "owner.near", agent: "portfolio", agentId: "id-portfolio", scopes: ["read", "treasury"],
    expiresAt: new Date(now + CONSENT_DAYS * DAY).toISOString(),
  });
  assert.notEqual(consentText(expected).nonce, text.nonce, "a fresh nonce each time");
  assert.deepEqual(checkConsent(text.message, expected), { ok: true });
});

test("a signed text is relayed only if it's exactly a consent this server would ask for now: read and treasury, or with owner too", () => {
  const base = { host: "platform.test", deployment: "treasury", organization: "owner--near", owner: "owner.near", agent: "portfolio",
    agentId: "id-portfolio", scopes: ["read", "treasury"] as ("read" | "treasury" | "treasury-execute" | "owner")[], expiresAt: new Date(now + 30 * DAY).toISOString() };
  assert.deepEqual(checkConsent(consentMessage(base), expected), { ok: true });
  assert.deepEqual(checkConsent(consentMessage({ ...base, scopes: ["owner", "read", "treasury"] }), expected), { ok: true }, "owner actions, opted into");
  const cases: [string, Partial<typeof base>][] = [
    ["another host", { host: "elsewhere.test" }],
    ["another deployment", { deployment: "other" }],
    ["another Organization", { organization: "someone--near" }],
    ["another owner", { owner: "someone.near" }],
    ["another agent", { agent: "other" }],
    ["another agent identity", { agentId: "id-old" }],
    ["unattended execution", { scopes: ["read", "treasury", "treasury-execute"] }],
    ["owner actions without treasury", { scopes: ["owner", "read"] }],
    ["owner actions and unattended execution", { scopes: ["owner", "read", "treasury", "treasury-execute"] }],
    ["read only", { scopes: ["read"] }],
    ["already expired", { expiresAt: new Date(now - 1).toISOString() }],
    ["longer than this server asks", { expiresAt: new Date(now + CONSENT_DAYS * DAY + 1).toISOString() }],
  ];
  for (const [label, change] of cases) assert.deepEqual(checkConsent(consentMessage({ ...base, ...change }), expected), { ok: false, code: "not_this_consent" }, label);
  assert.deepEqual(checkConsent(`${consentMessage(base)} `, expected), { ok: false, code: "not_this_consent" }, "not the canonical text");
  assert.deepEqual(checkConsent("anything", expected), { ok: false, code: "not_this_consent" });
});

test("the agent's live consents are this owner's, for this agent's current identity, with read and treasury, unrevoked and unexpired", () => {
  const consent = { id: "c", deployment: "treasury", host: "platform.test", organization: "owner--near", owner: "owner.near", agent: "portfolio",
    agentId: "id-portfolio", scopes: ["read", "treasury"] as ("read" | "treasury" | "owner" | "payout" | "treasury-execute")[], expiresAt: now + DAY, createdAt: 0, publicKey: "k", revoked: false, revokedAt: null };
  const others = [
    { ...consent, id: "setup", agentId: "unborn", scopes: ["owner" as const] },
    { ...consent, id: "earlier", agentId: "id-old" },
    { ...consent, id: "read-only", scopes: ["read" as const] },
    { ...consent, id: "revoked", revoked: true, revokedAt: 1 },
    { ...consent, id: "expired", expiresAt: now },
    { ...consent, id: "previous-owner", owner: "previous.near" },
    { ...consent, id: "other-agent", agent: "other" },
  ];
  const wider = { ...consent, id: "wider", scopes: ["owner" as const, "read" as const, "treasury" as const] };
  const later = { ...consent, id: "later", expiresAt: now + 2 * DAY };
  assert.deepEqual(liveConsents([...others, consent, wider, later], identity, now).map(c => c.id), ["later", "c", "wider"], "the latest to expire first");
});
