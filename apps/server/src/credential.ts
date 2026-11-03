import { readFile, stat } from "node:fs/promises";
import { Secret } from "./config.ts";

/**
 * The deployment's `tap_` credential, read from a file only its owner can read. Each call checks the file's mode and
 * whether it has changed (its inode, size and nanosecond modification and change times); the contents are read again
 * only when it has, so a rotated credential is used as soon as it's written, without a restart.
 */
export function createCredential(file: string) {
  let loaded: { stamp: string; secret: Secret } | undefined;
  return {
    async get(): Promise<Secret> {
      const info = await stat(file, { bigint: true });
      if (info.mode & 0o077n) throw new Error(`${file} is readable by others: it must be 0600`);
      const stamp = `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      if (loaded?.stamp !== stamp) {
        const value = (await readFile(file, "utf8")).trim();
        // The platform's own format (`src/gateway/app-access.ts`): `tap_<credential id>.<secret>`.
        if (!/^tap_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(value)) throw new Error(`${file} doesn't hold a tap_ credential`);
        loaded = { stamp, secret: loaded?.secret.reveal() === value ? loaded.secret : new Secret(value) };
      }
      return loaded.secret;
    },
  };
}
export type Credential = ReturnType<typeof createCredential>;
