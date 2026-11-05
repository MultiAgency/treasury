import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_READS, APP_OWNER, APP_PAYOUT, APP_TREASURY, APP_TREASURY_EXECUTE,
  appScopesCover, DAO_CONSENT_SCOPES, daoScopesCover, type AppScope } from "@multiagency/sdk";

const SCOPES: AppScope[] = ["read", "owner", "payout", "treasury", "treasury-execute"];
const procedures = [...new Set([...APP_READS, ...APP_OWNER, ...APP_PAYOUT, ...APP_TREASURY, ...APP_TREASURY_EXECUTE])];
export function scopesFor(procedure: string): AppScope[] {
  return SCOPES.filter(scope => scope === "treasury-execute"
    ? !appScopesCover(["treasury"], procedure) && appScopesCover(["treasury", scope], procedure)
    : appScopesCover([scope], procedure));
}
/** Whether a DAO's consent reaches the procedure: its scopes, less what the platform refuses DAO consents. */
export const daoCovers = (procedure: string): boolean => daoScopesCover(DAO_CONSENT_SCOPES, procedure);

/** Literal owner call inventory, using the same convention as contract.test.ts. */
export function callsIn(source: string): string[] {
  return [...new Set([...source.matchAll(/\.(?:read|act|stream)\(\s*["']([A-Za-z/]+)["']/g)].map(match => match[1]!))].sort();
}

export function inventory(root: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.tsx?$/.test(entry.name)) {
        for (const procedure of callsIn(readFileSync(file, "utf8"))) {
          const sites = found.get(procedure) ?? [];
          sites.push(relative(root, file));
          found.set(procedure, sites);
        }
      }
    }
  };
  walk(root);
  return new Map([...found].sort(([a], [b]) => a.localeCompare(b)));
}

export function report(root: string): string {
  const calls = inventory(root);
  const missing = [...calls.keys()].filter(path => !procedures.includes(path as typeof procedures[number]));
  return [
    "# Owner UI app-access audit",
    "",
    "Generated from owner UI call sites and the installed @multiagency/sdk scope rules. Scope coverage alone does not prove a migrated flow works.",
    "",
    "| Procedure | Wallet consent scopes | DAO consent covers | Call sites |",
    "| --- | --- | --- | --- |",
    ...[...calls].map(([path, sites]) => `| ${path} | ${scopesFor(path).join(", ") || "Unavailable"} | ${daoCovers(path) ? "Yes" : "No"} | ${sites.join(", ")} |`),
    "",
    `Missing from all app scopes (${missing.length}): ${missing.join(", ") || "none"}.`,
    "",
    "DAO owner actions use the SDK's separate DAO preparation/vote flow; a No above does not mean that a DAO cannot freeze or authorize a grant.",
    "Gateway discovery, sign-in, creation, confirm-page handling, setup fields and consent changes also need migration; they are not agent procedure calls in this table.",
    "",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(report(join(import.meta.dirname, "..", "src")));
}
