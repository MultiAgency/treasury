import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { writeAtomic } from "./files.ts";

/**
 * Records kept in one owner-only file, `{ version: 1, [key]: [...] }`, replaced whole on every change (`writeAtomic`),
 * so a crash leaves the records before a change or after it. Changes are made one at a time, in order, each on disk
 * before it returns; a write that fails keeps what was there. Refuses a file others can read, or one that doesn't hold
 * these records (`what` names them in the error).
 */
export async function createRecords<S extends z.ZodType>(path: string, key: string, record: S, what: string) {
  type Record = z.output<S>;
  let records: Record[] = await load(path, z.strictObject({ version: z.literal(1), [key]: z.array(record) }), key, what);
  let writing = Promise.resolve();
  return {
    all: (): readonly Record[] => records,
    /** Writes what `change` makes of the records and then keeps it; `change` answering null writes nothing (false). */
    commit(change: (current: readonly Record[]) => Record[] | null) {
      const done = writing.then(async () => {
        const next = change(records);
        if (!next) return false;
        await writeAtomic(path, JSON.stringify({ version: 1, [key]: next }));
        records = next;
        return true;
      });
      writing = done.then(() => {}, () => {});
      return done;
    },
  };
}

/** Records that live only as long as the process, changed as `createRecords`' are: for tests, and when no file is configured. */
export function memoryRecords<R>(): Pick<Awaited<ReturnType<typeof createRecords<z.ZodType<R>>>>, "all" | "commit"> {
  let records: R[] = [];
  let writing = Promise.resolve();
  return {
    all: () => records,
    commit(change: (current: readonly R[]) => R[] | null) {
      const done = writing.then(() => {
        const next = change(records);
        if (!next) return false;
        records = next;
        return true;
      });
      writing = done.then(() => {}, () => {});
      return done;
    },
  };
}

async function load<T>(path: string, schema: z.ZodType<Record<string, unknown>>, key: string, what: string): Promise<T[]> {
  let text: string;
  try {
    if ((await stat(path)).mode & 0o077) throw new Error(`${path} is readable by others: it must be 0600`);
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed;
  try { parsed = schema.parse(JSON.parse(text)); } catch { throw new Error(`${path} doesn't hold ${what}`); }
  return parsed[key] as T[];
}
