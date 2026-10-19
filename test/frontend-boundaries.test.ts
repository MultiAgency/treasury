import "../web/src/features/payables/payment-stages.test.js";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runtimeImports } from "./fixtures/source-analysis.mjs";

const web = fileURLToPath(new URL("../web/src/", import.meta.url));
function runtimeDependencies(entry: string, seen = new Set<string>()) {
  const file = resolve(web, entry);
  if (seen.has(file)) return seen;
  seen.add(file);
  const source = readFileSync(file, "utf8");
  for (const specifier of runtimeImports(source, file)) {
    if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
    const base = (specifier.startsWith("@/") ? resolve(web, specifier.slice(2)) : resolve(dirname(file), specifier)).replace(/\.js$/, "");
    const dependency = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(existsSync);
    assert.ok(dependency, `Unresolved local runtime dependency: ${specifier} in ${file}`);
    runtimeDependencies(dependency, seen);
  }
  return seen;
}
test("legacy public overviews cannot reach authenticated clients, queries or actions", () => {
  const dependencies = runtimeDependencies("public/prototype-explorer.tsx");
  // Shared formatting re-exports exactPayment/fromUnits from shared/amounts.ts: pure presentation helpers.
  const presentation = ["features/evidence/showcase.tsx", "features/evidence/beats.ts"];
  for (const dependency of [...presentation, "shared/amounts.ts", "../../evidence/inventory.ts", "shared/ui.tsx", "components/ui/card.tsx", "components/ui/button.tsx"]) {
    assert.ok(dependencies.has(resolve(web, dependency)), `Public presentation dependency must be checked: ${dependency}`);
  }
  for (const file of dependencies) {
    if (!presentation.some(entry => file === resolve(web, entry))) assert.doesNotMatch(file, /\/(?:app|features)\//);
    assert.doesNotMatch(file, /\/(?:client|queries|viewer|wallet|owner|confirm-button)\.[tj]sx?$/);
    assert.doesNotMatch(readFileSync(file, "utf8"), /fetch\(|useQuery|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage/);
  }
});
test("generic UI primitives have no permission or transport dependency", () => {
  const dependencies = runtimeDependencies("shared/ui.tsx");
  for (const file of dependencies) assert.doesNotMatch(file, /\/(?:client|queries|viewer|wallet|owner|confirm-button)\.[tj]sx?$/);
});
