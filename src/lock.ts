import lockfile from "proper-lockfile";
import { blocksDispatch, type Op, opsLog, readOps, resolveUnsubmitted } from "./ops.js";

/**
 * One money-moving run at a time, across every process (CLI, dashboard server, scripts). The lock
 * is a directory next to the ops log, created atomically; its holder refreshes it, so a crashed
 * holder's lock goes stale and can be taken over. Only the holder's `release` frees it.
 */
export type MoneyLock = { readonly held: boolean; release(): Promise<void> };

/** How long a crashed holder blocks others: its lock is stale once not refreshed for this long. */
export const STALE_MS = 10_000;

export class MoneyLockBusy extends Error {
  constructor() {
    super("Another money action is running (CLI, dashboard or script). Try again when it finishes.");
  }
}

export class UnresolvedOperations extends Error {
  constructor(readonly ops: Op[]) {
    super(
      `${ops.length} earlier money action(s) have no proven outcome: ${ops.map((op) => op.idempotencyKey).join(", ")}. ` +
        "Run `pnpm reconcile` before sending new ones.",
    );
  }
}

/** Check again after asynchronous preflight: ownership may have been lost while awaiting it. */
export function assertMoneyLock(lock: MoneyLock) {
  if (!lock.held) throw new Error("Money actions need the money lock, held by this process");
}

/** A new action must not follow an unknown outcome, even within the same locked run. */
export function assertCanDispatch(lock: MoneyLock, initiatingKey?: string) {
  assertMoneyLock(lock);
  const unresolved = readOps().filter((op) => blocksDispatch(op) && op.idempotencyKey !== initiatingKey);
  if (unresolved.length) throw new UnresolvedOperations(unresolved);
}

/**
 * Takes the lock, then refuses to proceed while any earlier operation is unresolved: after a crash,
 * the same economic action must be reconciled under its original key, never sent again under a new one.
 * `reconcile` alone may take the lock with unresolved operations, to resolve them. Operations held
 * for the owner's approval don't block (see `isHeld`).
 */
export async function acquireMoneyLock({ reconcile = false }: { reconcile?: boolean } = {}): Promise<MoneyLock> {
  let held = true;
  let free: () => Promise<void>;
  try {
    free = await lockfile.lock(opsLog(), {
      realpath: false,
      stale: STALE_MS,
      retries: 0,
      // If another process took the lock over (we stalled past STALE_MS), we no longer own it:
      // stop sending rather than crash mid-operation.
      onCompromised: () => {
        held = false;
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === "ELOCKED") throw new MoneyLockBusy();
    throw error;
  }
  const lock: MoneyLock = {
    get held() {
      return held;
    },
    async release() {
      if (!held) return;
      held = false;
      await free();
    },
  };
  try {
    assertMoneyLock(lock);
    resolveUnsubmitted();
    if (!reconcile) {
      const unresolved = readOps().filter(blocksDispatch);
      if (unresolved.length > 0) throw new UnresolvedOperations(unresolved);
    }
  } catch (error) {
    await lock.release();
    throw error;
  }
  return lock;
}

export async function withMoneyLock<T>(run: (lock: MoneyLock) => Promise<T>): Promise<T> {
  const lock = await acquireMoneyLock();
  try {
    return await run(lock);
  } finally {
    await lock.release();
  }
}
