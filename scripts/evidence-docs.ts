import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { knownLabel, REQUIREMENTS_CONTEXT, PROTOTYPES, STOPPER_LABEL, VERIFICATION_CONTEXT, VERIFICATIONS, type Kind } from "../evidence/inventory.js";

const root = new URL("../", import.meta.url);
const cell = (value: string) => value.replace(/\|/g, "&#124;").replace(/\r?\n/g, "<br>");
const row = (values: string[]) => `| ${values.map(cell).join(" | ")} |`;

export function requirementsMarkdown(kind: Kind): string {
  return PROTOTYPES[kind].briefs.map((brief, index) => [
    `## ${brief.catalog} ${brief.title}${index ? " (roadmap)" : ""}`,
    "",
    REQUIREMENTS_CONTEXT,
    "",
    "| Type | Requirement | Control or limitation | Evidence stage | Evidence |",
    "|---|---|---|---|---|",
    ...brief.requirements.map((requirement) => row([
      requirement.type === "capability" ? "Capability target" : "Safety target",
      requirement.text,
      requirement.stoppedBy ? STOPPER_LABEL[requirement.stoppedBy] : "—",
      knownLabel(requirement),
      requirement.evidence + (requirement.proposals?.length ? ` (proposals ${requirement.proposals.map((id) => `#${id}`).join(", ")})` : ""),
    ])),
    ...(brief.limitations?.length ? ["", "### Known limitations", "", ...brief.limitations.map((limitation) => `- ${limitation}`)] : []),
  ].join("\n")).join("\n\n");
}

export function verificationMarkdown(): string {
  return [VERIFICATION_CONTEXT, "", "| Claim | How it is known | When |", "|---|---|---|",
    ...VERIFICATIONS.map((entry) => row([entry.claim, entry.evidence, entry.when])),
  ].join("\n");
}

/** Replace only an explicitly marked section; missing/duplicate markers must never swallow prose. */
export function replaceGenerated(source: string, section: string, body: string): string {
  const begin = `<!-- BEGIN GENERATED: ${section} -->`;
  const end = `<!-- END GENERATED: ${section} -->`;
  if (source.split(begin).length !== 2 || source.split(end).length !== 2 || source.indexOf(end) < source.indexOf(begin)) {
    throw new Error(`Expected exactly one ordered marker pair for ${section}`);
  }
  return source.slice(0, source.indexOf(begin)) + `${begin}\n<!-- Generated from evidence/inventory.ts. Run pnpm evidence:write; do not edit here. -->\n\n${body}\n\n${end}` + source.slice(source.indexOf(end) + end.length);
}

export function documentationUpdates() {
  return [
    { path: "docs/facilitator.md", section: "requirements", body: requirementsMarkdown("facilitator") },
    { path: "docs/treasury.md", section: "requirements", body: requirementsMarkdown("treasury") },
    { path: "DEMO.md", section: "verification", body: verificationMarkdown() },
  ].map(({ path, section, body }) => {
    const url = new URL(path, root);
    const current = readFileSync(url, "utf8");
    return { path, url, current, expected: replaceGenerated(current, section, body) };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !["--write", "--check"].includes(mode ?? "")) {
    throw new Error("Usage: tsx scripts/evidence-docs.ts --write|--check");
  }
  const updates = documentationUpdates().filter(({ current, expected }) => current !== expected);
  for (const update of updates) {
    if (mode === "--write") writeFileSync(update.url, update.expected);
    console.log(`${mode === "--write" ? "Updated" : "Stale"}: ${update.path}`);
  }
  if (mode === "--check" && updates.length) {
    console.error("Run pnpm evidence:write and review the generated changes.");
    process.exitCode = 1;
  }
}
