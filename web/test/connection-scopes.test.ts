import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeList } from "../src/words.ts";

test("a connection's scopes read in a fixed order, whatever order the platform lists them in", () => {
  assert.equal(scopeList(["owner", "read", "treasury"]), "read, treasury and owner");
  assert.equal(scopeList(["treasury", "read"]), "read and treasury");
  assert.equal(scopeList(["read"]), "read");
  assert.equal(scopeList(["treasury-execute", "owner", "treasury", "read"]), "read, treasury, owner and treasury-execute");
});

test("it doesn't change the scopes it is given", () => {
  const scopes = ["owner", "read", "treasury"];
  scopeList(scopes);
  assert.deepEqual(scopes, ["owner", "read", "treasury"]);
});
