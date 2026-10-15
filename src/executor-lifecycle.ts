type Release = () => Promise<void>;

/** Server lifetime ownership. An identity learned during onboarding uses the same path as startup. */
export function createExecutorLifecycle(deps: {
  executes: () => boolean;
  acquire: (id: string) => Promise<Release>;
  configure: (id: string) => void;
  start: () => void;
}) {
  let identity: string | undefined;
  let release: Release | undefined;
  let active = false;
  let starting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let failed: unknown;
  let closed = false;

  async function activate(id: string | undefined, configure = false): Promise<void> {
    if (!id) return;
    if (closed) throw new Error("Executor is stopping");
    if (failed) throw failed;
    if (identity && identity !== id) throw new Error("This server already belongs to another agent");
    if (starting) { await starting; return activate(id, configure); }
    identity = id;
    if (!deps.executes()) { if (configure) deps.configure(id); return; }
    if (active) { if (configure) deps.configure(id); return; }
    starting = (async () => {
      // Do not expose a newly created agent to RPC callers before owning its executor lease.
      release = await deps.acquire(id);
      try {
        if (closed) throw new Error("Executor is stopping");
        if (configure) deps.configure(id);
      }
      catch (error) { await release(); release = undefined; throw error; }
      try { deps.start(); active = true; }
      catch (error) {
        // A starter may have partially installed timers. Retain ownership and refuse further work.
        // The server terminates on this error rather than running with a partial lifecycle.
        failed = error;
        throw error;
      }
    })();
    try { await starting; }
    finally { starting = undefined; }
  }

  function close() {
    closed = true;
    return closing ??= (async () => {
      await starting?.catch(() => undefined);
      await release?.();
      release = undefined;
    })();
  }
  return { activate, close };
}
