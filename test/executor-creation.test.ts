import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { api } from "../src/api.js";
import { saveEnv } from "../src/env.js";
import { createExecutorLifecycle } from "../src/executor-lifecycle.js";
import { prepare, reconcileOwnerIntents, setAgentCreationHandler, submit } from "../src/owner-intents.js";
import { freshDirectory } from "./fixtures/harness.js";
import { walletIntent, walletSignature, walletSigner } from "./fixtures/wallet-signature.js";

freshDirectory("executor-creation");

test("creation with unavailable ownership stays recoverable and does not resubmit its signature", async t => {
  const previous = process.env.AGENT_ID;
  delete process.env.AGENT_ID;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = previous;
    setAgentCreationHandler(async id => { saveEnv({ AGENT_ID: id }); });
  });
  let signatures = 0;
  let leaseUnavailable = true;
  let starts = 0;
  const executor = createExecutorLifecycle({ executes: () => true,
    acquire: async () => { if (leaseUnavailable) throw new Error("lease unavailable"); return async () => {}; },
    configure: id => saveEnv({ AGENT_ID: id }), start: () => { starts++; } });
  setAgentCreationHandler(id => executor.activate(id, true));
  t.mock.method(api, "generateIntent", async () => ({ type: "agent_create", correlation_id: "creation", preview: {},
    expires_at: new Date(Date.now() + 60_000).toISOString(), intent: walletIntent, signer: walletSigner }) as never);
  t.mock.method(api, "submitIntent", async () => { signatures++; return { correlation_id: "creation", status: "SUCCESS" } as never; });
  t.mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, agent_id: "created-agent", status: "SUCCESS" }) as never);
  await prepare({ type: "agent_create", owner: walletSigner });
  await assert.rejects(submit("creation", await walletSignature()), /lease unavailable/);
  const pending = JSON.parse(readFileSync(".owner-intents/.env.json", "utf8")).creation;
  assert.equal(pending.stage, "submitted");
  assert.equal(pending.ownerSucceeded, undefined);
  assert.equal(process.env.AGENT_ID, undefined);
  assert.equal(starts, 0);
  assert.equal(signatures, 1);
  leaseUnavailable = false;
  assert.equal((await reconcileOwnerIntents())[0]?.status, "SUCCESS");
  assert.equal(process.env.AGENT_ID, "created-agent");
  assert.equal(starts, 1);
  assert.equal(signatures, 1);
  assert.equal(JSON.parse(readFileSync(".owner-intents/.env.json", "utf8")).creation.stage, "settled");
  await executor.close();
});
