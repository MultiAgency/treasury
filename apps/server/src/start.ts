import { writeAtomic } from "./files.ts";

// The entry point on a host that keeps secrets as environment variables (Railway): each secret the server reads from a
// 0600 file is written there first, then deleted from `process.env` before the server starts, so no process it starts
// (`notify`, say) inherits it. Locally and in tests the files already exist, and `main.ts` starts directly.

/** Each secret variable, and the setting naming the 0600 file the server reads it from. */
export const SECRET_FILES = { TREASURY_CREDENTIAL: "TREASURY_CREDENTIAL_FILE", TREASURY_ANCHOR_KEY: "TREASURY_ANCHOR_KEY_FILE" } as const;

/**
 * Why the server mustn't start on this host's disk, or undefined. With `TREASURY_REQUIRED_MOUNT` set (on Railway,
 * `/data`), the audit trail, stored requests and secrets live on the volume mounted there, and Railway names the
 * mounted volume's path in `RAILWAY_VOLUME_MOUNT_PATH`. Without that volume they would land on the container's own
 * disk: a fresh audit trail, lost on the next deploy. Railway's own guard (`requiredMountPath`) isn't settable for this
 * service from `.railway/railway.ts`, so the server checks.
 */
export function volumeProblem(env: NodeJS.ProcessEnv): string | undefined {
  const required = env.TREASURY_REQUIRED_MOUNT;
  if (!required) return undefined;
  if (!required.startsWith("/")) return `TREASURY_REQUIRED_MOUNT must be an absolute path, not ${required}`;
  const mounted = env.RAILWAY_VOLUME_MOUNT_PATH;
  if (mounted !== required) return `no volume is mounted at ${required}${mounted ? ` (Railway mounted one at ${mounted})` : ""}: attach the service's volume there before it starts`;
  return undefined;
}

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
    const problem = volumeProblem(process.env);
    if (problem) throw new Error(problem);
    for (const file of await writeSecretFiles(process.env)) console.log(JSON.stringify({ event: "secret_file_written", file }));
  } catch (error) {
    console.error(`Invalid configuration:\n${(error as Error).message}`);
    process.exit(1);
  }
  await import("./main.ts");
}
