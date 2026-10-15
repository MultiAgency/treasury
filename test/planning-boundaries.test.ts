import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { runtimeImports } from "./fixtures/source-analysis.mjs";

test("planning, storage and execution have no runtime import cycle", () => {
  const files = ["src/plans.ts", "src/treasury.ts", ...(existsSync("src/planning")
    ? readdirSync("src/planning").filter(f => f.endsWith(".ts")).map(f => `src/planning/${f}`) : [])].map(f => resolve(f));
  const graph = new Map(files.map(file => {
    const source = readFileSync(file, "utf8");
    const imports = runtimeImports(source).flatMap(specifier => {
      if (!specifier.startsWith(".")) return [];
      const target = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
      return files.includes(target) ? [target] : [];
    });
    return [file, imports];
  }));
  const visited = new Set<string>();
  const visit = (file: string, path: string[]) => {
    assert.ok(!path.includes(file), `Runtime cycle: ${[...path, file].join(" → ")}`);
    if (visited.has(file)) return;
    for (const target of graph.get(file) ?? []) visit(target, [...path, file]);
    visited.add(file);
  };
  files.forEach(file => visit(file, []));
});
