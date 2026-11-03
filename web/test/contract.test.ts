// `contract.json` against what the app calls. The release server refuses a build whose required capabilities its host
// doesn't offer, and the gateway refuses calls outside them; the brief asks the list to name only capabilities the UI
// uses. So both directions hold: every call is covered, and every required capability is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ownerCapabilities, type OwnerCapability } from "@multiagency/sdk";

const SRC = join(import.meta.dirname, "..", "src");
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []);
const source = files(SRC).map(file => readFileSync(file, "utf8")).join("\n");

/** Owner procedures the app calls: `.read("…"`, `.act("…"` and `.stream("…"`, wherever they appear. */
const procedures = new Set([...source.matchAll(/\.(?:read|act|stream)\(\s*"([A-Za-z/]+)"/g)].map(match => match[1]!));
/** Gateway routes the app calls. */
const routes = new Set([...source.matchAll(/"(\/gw\/[a-z-]+)"/g)].map(match => match[1]!));
const contract = JSON.parse(readFileSync(join(import.meta.dirname, "..", "contract.json"), "utf8")) as { required: OwnerCapability[] };
const capability = (name: OwnerCapability) => ownerCapabilities[name] as { procedures: readonly string[]; routes: readonly string[] };

test("the app's calls are found at all, so the checks below aren't vacuous", () => {
  assert.ok(procedures.size > 0 && routes.size > 0, `procedures: ${[...procedures]}, routes: ${[...routes]}`);
});

test("every capability the contract requires is one the platform defines", () => {
  for (const name of contract.required) assert.ok(name in ownerCapabilities, name);
});

test("every owner procedure and gateway route the app calls is covered by a required capability", () => {
  for (const procedure of procedures)
    assert.ok(contract.required.some(name => capability(name).procedures.includes(procedure)), `${procedure} needs a capability in contract.json`);
  for (const route of routes)
    assert.ok(contract.required.some(name => capability(name).routes.includes(route)), `${route} needs a capability in contract.json`);
});

test("every required capability is one the app uses", () => {
  for (const name of contract.required) {
    const { procedures: covered, routes: served } = capability(name);
    assert.ok(covered.some(p => procedures.has(p)) || served.some(r => routes.has(r)), `${name} is required but nothing the app calls needs it`);
  }
});
