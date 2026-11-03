import { readFileSync, statSync } from "node:fs";
import { Secret } from "./config.ts";

/**
 * The deployment's `tap_` credential, read from a file only its owner can read. The file is tiny and read on every
 * call, so a rotated credential is used as soon as it's written, without a restart or change detection.
 */
export function createCredential(file: string) {
  let current: Secret | undefined;
  return {
    get(): Secret {
      if (statSync(file).mode & 0o077) throw new Error(`${file} is readable by others: it must be 0600`);
      const value = readFileSync(file, "utf8").trim();
      // The platform's own format (`src/gateway/app-access.ts`): `tap_<credential id>.<secret>`.
      if (!/^tap_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(value)) throw new Error(`${file} doesn't hold a tap_ credential`);
      if (current?.reveal() !== value) current = new Secret(value);
      return current;
    },
  };
}
export type Credential = ReturnType<typeof createCredential>;
