import assert from "node:assert/strict";
import { test } from "node:test";
import { assertDryGrantUses, runtimeImports } from "./fixtures/source-analysis.mjs";

test("boundary analysis follows runtime imports including dynamic imports and ignores types", () => {
  assert.deepEqual(runtimeImports(`
    import type { A } from './types';
    import { type B } from './more-types';
    import { client as alias } from './client';
    export { alias } from './exports';
    export type { C } from './exported-types';
    const lazy = () => import('./owner');
    const common = require('./transport');
    // import('./comment') is not executable
  `), ["./client", "./exports", "./owner", "./transport"]);
  assert.throws(() => runtimeImports("const load = path => import(path)"), /non-literal/);
});

test("grant analysis rejects aliases, non-dry calls and overriding spreads", () => {
  const header = `import { agent as grant } from './agent.js';\n`;
  assert.equal(assertDryGrantUses(header + 'grant()["swap"](id, { ...request, dry: true });'), 1);
  for (const body of [
    'const retained = grant(); retained.transfer(id, request);',
    'grant().swap(id, { dry: false });',
    'grant().swap(id, { dry: true, ...request });',
    'grant().swap(id, { [dry]: true });',
    'const alias = grant; alias().swap(id, request);',
    'grant()[method](id, { dry: true });',
    'export { grant };',
  ]) assert.throws(() => assertDryGrantUses(header + body), /Grant factory|Quote must/);
  assert.throws(() => assertDryGrantUses("export { agent as factory } from './agent.js'"), /cannot be re-exported/);
  assert.throws(() => assertDryGrantUses("const load = () => import('./agent.js')"), /explicit static imports/);
});
