import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

test("refreshing gateway permissions updates every session consumer from the same snapshot", async () => {
  Object.defineProperty(globalThis, "location", { value: { pathname: "/a/payables/" }, configurable: true });
  const { clearAgentCapabilities, gatewayQueries } = await import(new URL("../web/src/app/queries.ts", import.meta.url).href);
  const { loadGateway } = await import(new URL("../web/src/app/session.tsx", import.meta.url).href);
  // Exercise every session query definition; these used to give the shell and sibling controls
  // independent snapshots even though they loaded the same gateway response.
  const definitions = Object.values(gatewayQueries).filter((entry): entry is {
    queryKey: string[]; queryFn: () => Promise<ReturnType<typeof session> | null>; staleTime: number; retry: false;
  } => Boolean(entry && typeof entry === "object" && "queryFn" in entry && entry.queryFn === loadGateway));
  assert.ok(definitions.length > 0);
  const session = (canExecute: boolean) => ({
    agents: [{ name: "payables", owner: "owner.near", dao: false }], invoices: null,
    viewer: { account: "owner.near", access: {
      payables: { canSign: false, canExecute, canManage: false, canPropose: true, canVote: canExecute },
      treasury: { canSign: true, canExecute: true, canManage: true, canPropose: false, canVote: false },
    } },
  });
  const client = new QueryClient();
  for (const definition of definitions) client.setQueryData(definition.queryKey, session(true));
  const shell = new QueryObserver(client, definitions[0]!);
  const sibling = new QueryObserver(client, definitions.at(-1)!);
  const unsubscribe = [shell.subscribe(() => {}), sibling.subscribe(() => {})];
  const originalFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = async () => { reads++; return Response.json(session(false)); };
  try {
    await sibling.refetch();
    assert.equal(sibling.getCurrentResult().data?.viewer?.access.payables?.canExecute, false);
    assert.equal(shell.getCurrentResult().data?.viewer?.access.payables?.canExecute, false,
      "a successful permission refresh must also update the shell instead of leaving stale execution access");
    assert.equal(reads, 1, "one refresh serves both consumers");
    clearAgentCapabilities(client, "");
    assert.deepEqual(shell.getCurrentResult().data, session(false), "a workspace feed denial cannot change unrelated agent permissions");
    const observedAt = shell.getCurrentResult().dataUpdatedAt;
    clearAgentCapabilities(client, "/a/payables");
    const refused = session(false);
    refused.viewer.access.payables.canPropose = false;
    assert.deepEqual(shell.getCurrentResult().data, refused, "a procedure denial clears only that agent's actions and keeps its membership");
    assert.deepEqual(sibling.getCurrentResult().data, refused, "every consumer loses the refused authority immediately");
    assert.equal(shell.getCurrentResult().dataUpdatedAt, observedAt, "a refusal is not a fresh permission read");
    globalThis.fetch = async () => Response.json({ error: "Gateway unavailable" }, { status: 503 });
    await shell.refetch();
    assert.match(shell.getCurrentResult().error?.message ?? "", /Gateway unavailable/);
    assert.match(sibling.getCurrentResult().error?.message ?? "", /Gateway unavailable/);
    assert.deepEqual(shell.getCurrentResult().data, refused, "failed refresh cannot restore refused capabilities or become local access");
  } finally {
    for (const stop of unsubscribe) stop();
    globalThis.fetch = originalFetch;
    client.clear();
    Reflect.deleteProperty(globalThis, "location");
  }
});
