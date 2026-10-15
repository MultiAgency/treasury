import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { documentationUpdates, replaceGenerated, requirementsMarkdown } from "../scripts/evidence-docs.js";
import { PROTOTYPES, PROVEN, VERIFICATIONS, knownLabel, summarizeRequirements, type Requirement } from "../evidence/inventory.js";

test("the app uses the canonical evidence inventory instead of a handwritten copy", () => {
  const source = readFileSync(new URL("../web/src/features/evidence/beats.ts", import.meta.url), "utf8");
  assert.ok(source.includes('export * from "../../../../evidence/inventory.js"'));
  assert.doesNotMatch(source, /export const PROTOTYPES/);
});

test("coverage separates observation scope and never promotes missing scope or offline tests", () => {
  const requirement = (known: Requirement["known"], where?: Requirement["where"]): Requirement => ({
    type: "guarantee", text: "Example", evidence: "Fixture", stoppedBy: "policy", known, where,
  });
  assert.deepEqual(summarizeRequirements([
    requirement("mainnet", "agent"), requirement("mainnet", "other"), requirement("mainnet"),
    requirement("offline"), requirement("not-yet"),
  ]), { total: 5, agent: 1, other: 1, offline: 1, unverified: 2, unsupported: 0 });
  assert.deepEqual(summarizeRequirements([]), { total: 0, agent: 0, other: 0, offline: 0, unverified: 0, unsupported: 0 });
});

test("running brief coverage excludes roadmap requirements and retains limitations despite mainnet observations", () => {
  assert.deepEqual(summarizeRequirements(PROTOTYPES.facilitator.briefs[0].requirements),
    { total: 9, agent: 6, other: 1, offline: 0, unverified: 1, unsupported: 1 });
  assert.deepEqual(summarizeRequirements(PROTOTYPES.treasury.briefs[0].requirements),
    { total: 9, agent: 7, other: 1, offline: 0, unverified: 1, unsupported: 0 });
  for (const kind of ["facilitator", "treasury"] as const) {
    const limitations = PROTOTYPES[kind].briefs[0].limitations;
    assert.ok(limitations?.length);
    for (const limitation of limitations) assert.ok(requirementsMarkdown(kind).includes(limitation));
  }
});

test("all generated evidence presentations match the canonical inventory", () => {
  for (const { path, current, expected } of documentationUpdates()) {
    assert.equal(current, expected, `${path} has drifted; run pnpm evidence:write`);
  }
});

test("primary Treasury docs contain only brief 02 and retain exact-unshielding as a gap", () => {
  const primary = requirementsMarkdown("treasury", true);
  assert.match(primary, /02 Agentic Treasury Management/);
  assert.doesNotMatch(primary, /Adaptive DCA|House Money|Bitcoin treasury/);
  assert.match(primary, /Unshields exactly what a public payout needs.*Not yet/);
  assert.match(primary, /atomic|simultaneous requests/);
  const updates = documentationUpdates();
  assert.ok(updates.some(entry => entry.path === "docs/legacy/facilitator.md"));
  assert.doesNotMatch(updates.find(entry => entry.path === "DEMO.md")!.expected, /Invoice → DAO approval/);
});

test("regeneration preserves surrounding prose and rejects ambiguous boundaries", () => {
  const marked = "intro\n<!-- BEGIN GENERATED: sample -->\nstale claim\n<!-- END GENERATED: sample -->\noutro";
  const updated = replaceGenerated(marked, "sample", "reviewed observation");
  assert.ok(updated.startsWith("intro\n"));
  assert.ok(updated.endsWith("\noutro"));
  assert.ok(!updated.includes("stale claim"));
  assert.equal(replaceGenerated(updated, "sample", "reviewed observation"), updated);
  for (const invalid of ["no markers", marked + marked, "<!-- END GENERATED: sample --><!-- BEGIN GENERATED: sample -->"]) {
    assert.throws(() => replaceGenerated(invalid, "sample", "claim"), /marker pair/);
  }
});

test("requirements keep evidence scope, refusal qualifications and proposal references", () => {
  for (const kind of ["facilitator", "treasury"] as const) {
    const markdown = requirementsMarkdown(kind);
    for (const brief of PROTOTYPES[kind].briefs) {
      for (const requirement of brief.requirements) {
        assert.ok(requirement.evidence.trim());
        assert.equal(Boolean(requirement.stoppedBy), requirement.type === "guarantee");
        if (requirement.known === "mainnet") assert.ok(requirement.where);
        assert.ok(markdown.includes(requirement.evidence));
        for (const proposal of requirement.proposals ?? []) assert.ok(markdown.includes(`#${proposal}`));
      }
    }
  }
  assert.match(requirementsMarkdown("treasury"), /on another agent/);
  assert.match(requirementsMarkdown("treasury"), /one trial/);
  assert.match(requirementsMarkdown("facilitator"), /not observed/);
  assert.deepEqual(PROVEN, VERIFICATIONS.flatMap((entry) => entry.publicClaim ? [entry.publicClaim] : []));
});

test("provider-source claims are not labeled or counted as offline tests", () => {
  const requirement = PROTOTYPES.facilitator.briefs[0].requirements.find(r => r.text.includes("even with votes"))!;
  assert.equal(requirement.known, "provider-source");
  assert.match(knownLabel(requirement), /pinned provider source; deployed behavior unverified/);
  assert.match(requirement.evidence, /b8c58c0/);
  assert.deepEqual(summarizeRequirements([requirement]),
    { total: 1, agent: 0, other: 0, offline: 0, unverified: 1, unsupported: 0 });
});

test("unsupported requirements never count as working or offline-only", () => {
  const requirements: Requirement[] = ["mainnet", "offline", "provider-source", "not-yet"].map(known => ({
    type: "guarantee", text: "Unsupported target", evidence: "Fixture", stoppedBy: "impossible",
    known: known as Requirement["known"], where: "agent",
  }));
  assert.deepEqual(summarizeRequirements(requirements),
    { total: 4, agent: 0, other: 0, offline: 0, unverified: 0, unsupported: 4 });
});
