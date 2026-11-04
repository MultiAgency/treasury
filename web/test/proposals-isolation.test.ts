import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

/** A module's relative imports that remain at runtime: `import type` and `export type` are erased. */
function runtimeImports(file: string) {
  const source = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const [, clause, specifier] of source.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm))
    if (!clause && (specifier!.startsWith(".") || specifier!.startsWith("@/"))) found.push(specifier!);
  for (const [, specifier] of source.matchAll(/^\s*import\s+"([^"]+)"/gm)) if (specifier!.startsWith(".")) found.push(specifier!);
  return found.map(specifier => {
    const base = specifier.startsWith("@/") ? join(SRC, specifier.slice(2)) : resolve(dirname(file), specifier);
    const path = EXTENSIONS.map(extension => base + extension).find(candidate => existsSync(candidate) && !candidate.endsWith("/"));
    assert.ok(path, `${relative(SRC, file)} imports ${specifier}, which doesn't resolve`);
    return path;
  });
}

/** Every module the page's entry reaches at runtime. */
function reachable(entry: string) {
  const seen = new Set<string>(), queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !/\.tsx?$/.test(file)) continue;
    seen.add(file);
    queue.push(...runtimeImports(file));
  }
  return [...seen].map(file => relative(SRC, file));
}

test("the proposals page never reaches the owner session's platform module at runtime", () => {
  const modules = reachable(join(SRC, "proposals", "main.tsx"));
  assert.ok(modules.includes("proposals/proposals-api.ts"), "the walk follows the page's imports");
  assert.ok(modules.includes("shared/ui.tsx"), "and into shared/");
  assert.deepEqual(modules.filter(module => module === "platform.ts" || module.startsWith("app/") && module !== "app/wallet.ts" && module !== "app/wallet-transaction.ts" && module !== "app/brand.tsx"), [],
    "no owner-session module: only the wallet's connection and the brand are shared");
});
