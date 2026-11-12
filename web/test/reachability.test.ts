import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
  // A module loaded on demand (`import("./landing/landing")`, the landing and its 3D vault) is reached too, later.
  for (const [, specifier] of source.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)) if (specifier!.startsWith(".") || specifier!.startsWith("@/")) found.push(specifier!);
  return found.map(specifier => {
    const base = specifier.startsWith("@/") ? join(SRC, specifier.slice(2)) : resolve(dirname(file), specifier);
    const path = EXTENSIONS.map(extension => base + extension).find(candidate => existsSync(candidate) && !candidate.endsWith("/"));
    assert.ok(path, `${relative(SRC, file)} imports ${specifier}, which doesn't resolve`);
    return path;
  });
}

/** Every module the entry reaches at runtime, and the stylesheets it imports. */
function reachable(entry: string) {
  const seen = new Set<string>(), queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const code = /\.tsx?$/.test(file);
    seen.add(file);
    if (code) queue.push(...runtimeImports(file));
    // A stylesheet's own relative `@import`s (the theme's palette, `theme/tokens.css`) are part of it.
    else for (const [, specifier] of readFileSync(file, "utf8").matchAll(/^@import\s+"(\.[^"]+)"/gm)) queue.push(resolve(dirname(file), specifier!));
  }
  return [...seen].map(file => relative(SRC, file));
}

const ENTRY = join(SRC, "main.tsx");

test("every source file in web/src is reached from the entry, so no module outlives what used it", () => {
  const reached = new Set(reachable(ENTRY));
  const files: string[] = [];
  (function walk(directory: string) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(tsx?|css)$/.test(name)) files.push(relative(SRC, path));
    }
  })(SRC);
  assert.deepEqual(files.filter(file => file !== "env.d.ts" && !reached.has(file)), []);
});
