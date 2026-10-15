import assert from "node:assert/strict";
import { test } from "node:test";
import { createExecutorLifecycle } from "../src/executor-lifecycle.js";

test("concurrent activation acquires once and publishes identity only after ownership", async () => {
  const events: string[] = [];
  let allow!: () => void;
  const gate = new Promise<void>(resolve => { allow = resolve; });
  const executor = createExecutorLifecycle({ executes: () => true,
    acquire: async id => { events.push(`acquire:${id}`); await gate; return async () => { events.push("release"); }; },
    configure: id => { events.push(`configure:${id}`); }, start: () => { events.push("start"); } });
  await executor.activate(undefined);
  const creation = executor.activate("created-agent", true);
  const concurrent = executor.activate("created-agent");
  assert.deepEqual(events, ["acquire:created-agent"]);
  allow();
  await Promise.all([creation, concurrent]);
  assert.deepEqual(events, ["acquire:created-agent", "configure:created-agent", "start"]);
  await executor.activate("created-agent");
  assert.equal(events.filter(e => e === "start").length, 1);
  await assert.rejects(executor.activate("another-agent"), /another agent/);
  await executor.close();
  assert.equal(events.at(-1), "release");
});

test("lease failure leaves creation unpublished and can recover without resubmitting its signature", async () => {
  let unavailable = true;
  let configured = false;
  let started = false;
  const executor = createExecutorLifecycle({ executes: () => true,
    acquire: async () => { if (unavailable) throw new Error("lease unavailable"); return async () => {}; },
    configure: () => { configured = true; }, start: () => { started = true; } });
  await assert.rejects(executor.activate("created-agent", true), /lease unavailable/);
  assert.equal(configured, false);
  assert.equal(started, false);
  unavailable = false;
  await executor.activate("created-agent", true);
  assert.equal(configured, true);
  assert.equal(started, true);
  await executor.close();
});

test("settings failure releases ownership without starting loops", async () => {
  let released = false;
  const executor = createExecutorLifecycle({ executes: () => true,
    acquire: async () => async () => { released = true; },
    configure: () => { throw new Error("settings unavailable"); }, start: () => assert.fail("must not start") });
  await assert.rejects(executor.activate("created-agent", true), /settings unavailable/);
  assert.equal(released, true);
});

test("partial loop startup retains ownership and blocks later activation", async () => {
  let releases = 0;
  let starts = 0;
  const executor = createExecutorLifecycle({ executes: () => true,
    acquire: async () => async () => { releases++; }, configure: () => {},
    start: () => { starts++; throw new Error("loop startup failed"); } });
  await assert.rejects(executor.activate("created-agent", true), /loop startup failed/);
  await assert.rejects(executor.activate("created-agent"), /loop startup failed/);
  assert.equal(releases, 0);
  assert.equal(starts, 1);
  await executor.close();
  assert.equal(releases, 1);
});

test("approve-only creation saves identity without starting an executor", async () => {
  let configured: string | undefined;
  const executor = createExecutorLifecycle({ executes: () => false,
    acquire: async () => assert.fail("approve-only must not acquire"), configure: id => { configured = id; },
    start: () => assert.fail("approve-only must not start") });
  await executor.activate("created-agent", true);
  assert.equal(configured, "created-agent");
  await assert.rejects(executor.activate("another-agent", true), /another agent/);
  assert.equal(configured, "created-agent", "an approve-only server still belongs to one agent");
  await executor.close();
});

test("shutdown during acquisition releases ownership without publishing identity or starting loops", async () => {
  const events: string[] = [];
  let allow!: () => void;
  const gate = new Promise<void>(resolve => { allow = resolve; });
  const executor = createExecutorLifecycle({ executes: () => true,
    acquire: async () => { await gate; return async () => { events.push("release"); }; },
    configure: () => { events.push("configure"); }, start: () => { events.push("start"); } });
  const activation = executor.activate("created-agent", true);
  const rejected = assert.rejects(activation, /Executor is stopping/);
  const closing = executor.close();
  allow();
  await Promise.all([rejected, closing]);
  assert.deepEqual(events, ["release"]);
  await assert.rejects(executor.activate("created-agent", true), /Executor is stopping/);
});

test("concurrent shutdown waits for one ownership release", async () => {
  let releases = 0;
  let allow!: () => void;
  const gate = new Promise<void>(resolve => { allow = resolve; });
  const executor = createExecutorLifecycle({ executes: () => true,
    acquire: async () => async () => { releases++; await gate; }, configure: () => {}, start: () => {} });
  await executor.activate("created-agent");
  const first = executor.close();
  const second = executor.close();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(releases, 1);
  allow();
  await Promise.all([first, second]);
  await executor.close();
  assert.equal(releases, 1);
});
