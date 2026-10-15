import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { refreshQueries } from "../web/src/shared/query-refresh.js";

test("scoped refresh invalidates affected reads without invalidating unrelated provider observations", async () => {
  const client = new QueryClient();
  for (const key of [["inbox"], ["inbox", "detail"], ["overview"], ["held"]]) client.setQueryData(key, {});
  await refreshQueries(client, [["inbox"]]);
  assert.equal(client.getQueryState(["inbox"])?.isInvalidated, true);
  assert.equal(client.getQueryState(["inbox", "detail"])?.isInvalidated, true);
  assert.equal(client.getQueryState(["overview"])?.isInvalidated, false);
  assert.equal(client.getQueryState(["held"])?.isInvalidated, false);
  client.clear();
});

test("previews can leave shared reads alone while default money-action refresh remains broad", async () => {
  const client = new QueryClient();
  client.setQueryData(["overview"], {}); client.setQueryData(["held"], {});
  await refreshQueries(client, []);
  assert.equal(client.getQueryState(["overview"])?.isInvalidated, false);
  await refreshQueries(client);
  assert.equal(client.getQueryState(["overview"])?.isInvalidated, true);
  assert.equal(client.getQueryState(["held"])?.isInvalidated, true);
  client.clear();
});
