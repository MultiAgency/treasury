import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson, sha256Hex } from "../src/digest.ts";

test("SHA-256 matches the standard vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  assert.equal(sha256Hex("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu"),
    "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1");
});

test("SHA-256 agrees with node:crypto, UTF-8 included", () => {
  const pick = (n: number) => Math.floor(Math.random() * n);
  const random = (n: number) => Array.from({ length: n }, () => String.fromCodePoint(Math.random() < 0.1 ? 0x10000 + pick(0x10000) : 0x20 + pick(0xd000))).join("");
  for (const s of ["é€😀", "lone \ud800 surrogate", "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000), ...Array.from({ length: 20 }, (_, i) => random(i * 13))]) {
    assert.equal(sha256Hex(s), createHash("sha256").update(s, "utf8").digest("hex"), JSON.stringify(s));
  }
});

test("canonical JSON does not depend on key order and keeps values apart", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 3 }], c: "s" } }), canonicalJson({ a: { c: "s", d: [1, { x: 3, y: 2 }] }, b: 1 }));
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  const distinct = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null, 0, -0, "NaN"].map(v => canonicalJson({ v }));
  assert.equal(new Set(distinct).size, distinct.length);
});
