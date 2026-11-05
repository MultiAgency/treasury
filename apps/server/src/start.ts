import { writeAtomic } from "./files.ts";

// The entry point on a host that keeps secrets as environment variables (Railway): each secret the server reads from a
// 0600 file is written there first, then deleted from `process.env` before the server starts, so no process it starts
// (`notify`, say) inherits it. Locally and in tests the files already exist, and `main.ts` starts directly.

/** Each secret variable, and the setting naming the 0600 file the server reads it from. */
export const SECRET_FILES = { TREASURY_CREDENTIAL: "TREASURY_CREDENTIAL_FILE", TREASURY_ANCHOR_KEY: "TREASURY_ANCHOR_KEY_FILE" } as const;

/**
 * Writes each secret set in `env` to the file its setting names, owner-only and whole (`writeAtomic`), and deletes the
 * secret from `env`. A secret without its file setting is refused, so it's never silently dropped. Answers the files written.
 */
export async function writeSecretFiles(env: NodeJS.ProcessEnv): Promise<string[]> {
  const written: string[] = [];
  for (const [secret, setting] of Object.entries(SECRET_FILES)) {
    const value = env[secret];
    if (value === undefined || value === "") continue;
    const file = env[setting];
    if (!file) throw new Error(`${secret} is set, but ${setting} doesn't name the file to write it to`);
    await writeAtomic(file, `${value.trim()}\n`);
    delete env[secret];
    written.push(file);
  }
  return written;
}

if (import.meta.main) {
  try {
    for (const file of await writeSecretFiles(process.env)) console.log(JSON.stringify({ event: "secret_file_written", file }));
  } catch (error) {
    console.error(`Invalid configuration:\n${(error as Error).message}`);
    process.exit(1);
  }
  await import("./main.ts");
}
