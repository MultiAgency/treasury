import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { executes } from "./env.js";
import { getWorkOrder, listWorkOrders, workOrderDirectory, type WorkOrder } from "./work-order-store.js";
import type { WorkOrderCommand, WorkOrderReply } from "./work-order-protocol.js";

/** Only infrastructure credentials enter a child; never the parent grant or local owner signing key. */
export function workOrderEnvironment(order: WorkOrder, envFile: string, parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "NODE_OPTIONS", "NEAR_INTENTS_AGENT_API_KEY", "NEAR_INTENTS_AGENT_API_URL", "NEAR_RPC_URL", "FASTNEAR_API_KEY", "PROTO_TEST_MODE"])
    if (parent[key] !== undefined) env[key] = parent[key];
  return { ...env, ENV_FILE: envFile, EXECUTOR: "on", AUTOPILOT: "off", GRANT_PURPOSE: "invoices",
    WORK_ORDER_PARENT: order.parentAgentId, WORK_ORDER_ID: order.id };
}

export function workOrderSettings(order: WorkOrder) {
  const parent = createHash("sha256").update(order.parentAgentId).digest("hex").slice(0, 16);
  return join(workOrderDirectory(order.parentAgentId), `work-${parent}-${order.id}.env`);
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Worker = { child: ChildProcess; ready: Promise<void>; pending: Map<string, Pending> };
const workers = new Map<string, Worker>();
let closed = false;

function settings(order: WorkOrder) {
  const path = workOrderSettings(order);
  if (!existsSync(path)) {
    if (existsSync(`${path}.initialized`)) throw new Error("Work order settings are missing. Restore the original state before continuing.");
    try { writeFileSync(path, `AUTOPILOT=off\n${order.dao ? `TREASURY_ACCOUNT=${order.dao}\n` : ""}`, { flag: "wx", mode: 0o600, flush: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  writeFileSync(`${path}.initialized`, "Preserve this settings file, its owner intents and its agent state together.\n", { mode: 0o600, flush: true });
  return path;
}

function worker(parent: string, id: string): Worker {
  if (!executes() || closed) throw new Error("Work orders must run on their executor host.");
  const order = getWorkOrder(parent, id);
  const key = `${parent}/${id}`;
  const existing = workers.get(key);
  if (existing) return existing;
  const limit = Number(process.env.MAX_WORK_ORDER_EXECUTORS ?? 8);
  if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error("MAX_WORK_ORDER_EXECUTORS must be between 1 and 64.");
  if (workers.size >= limit) throw new Error("Work order executor capacity reached. Ask the operator to review capacity; no shared payout will be substituted.");
  const child = fork(fileURLToPath(new URL("./work-order-worker.ts", import.meta.url)), [], {
    execArgv: ["--import", import.meta.resolve("tsx")], env: workOrderEnvironment(order, settings(order), process.env),
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const pending = new Map<string, Pending>();
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const startTimer = setTimeout(() => { rejectReady(new Error("Work order executor did not start.")); child.kill("SIGTERM"); }, 30_000);
  const state = { child, pending, ready };
  workers.set(key, state);
  child.on("message", (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    if ("ready" in raw && raw.ready === true) { clearTimeout(startTimer); resolveReady(); return; }
    if (!("id" in raw) || typeof raw.id !== "string") return;
    const request = pending.get(raw.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(raw.id);
    if ("error" in raw && typeof raw.error === "string") request.reject(new Error(raw.error));
    else if ("result" in raw) request.resolve(raw.result);
    else request.reject(new Error("Work order executor returned an invalid result."));
  });
  const lost = () => {
    clearTimeout(startTimer);
    const error = new Error("Work order executor disconnected. Review its existing records before repeating an action.");
    rejectReady(error);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    // Wait for process exit before another instance can acquire its leases.
  };
  child.once("error", lost);
  child.once("disconnect", lost);
  child.once("exit", () => { lost(); if (workers.get(key) === state) workers.delete(key); });
  return state;
}

export async function callWorkOrder<T extends WorkOrderCommand["type"]>(parent: string, id: string,
  command: Extract<WorkOrderCommand, { type: T }>): Promise<WorkOrderReply[T]> {
  const state = worker(parent, id);
  await state.ready;
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      state.pending.delete(requestId);
      reject(new Error("Work order outcome not yet available. Follow the existing record; do not create a replacement."));
    }, 200_000);
    state.pending.set(requestId, { resolve: value => resolve(value as WorkOrderReply[T]), reject, timer });
    state.child.send({ id: requestId, command }, error => {
      if (!error) return;
      clearTimeout(timer); state.pending.delete(requestId);
      reject(new Error("Work order executor unavailable. Review the existing record."));
    });
  });
}

/** Resume retained instances on this host so approvals and unresolved payments continue to be observed. */
export function resumeWorkOrders(parent: string) {
  for (const order of listWorkOrders(parent)) {
    const path = workOrderSettings(order);
    if (existsSync(`${path}.initialized`) && !existsSync(path)) throw new Error("Work order settings missing; restore state before startup.");
    if (!existsSync(path)) continue;
    const saved = parseEnv(readFileSync(path, "utf8"));
    if (saved.AGENT_ID || existsSync(join(".owner-intents", `${path.split("/").at(-1)}.json`)))
      void callWorkOrder(parent, order.id, { type: "snapshot" }).catch(() => console.error("A work order executor could not resume; review its retained state."));
  }
}

export async function closeWorkOrders() {
  closed = true;
  await Promise.all([...workers.values()].map(({ child }) => new Promise<void>(resolve => {
    if (child.exitCode !== null) { resolve(); return; }
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  })));
}
