/** For the read-only scripts that check the hosted services from outside (smoke, run-report). */

/** An environment variable the script can't run without. */
export function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

/** One oRPC call to an agent behind the hosted gateway, as the signed-in session in `cookie`. */
export async function hostedRpc<T>(base: URL, cookie: string, agent: string, path: string, input?: unknown): Promise<T> {
  const res = await fetch(new URL(`/a/${agent}/rpc/${path}`, base), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(input === undefined ? {} : { json: input }),
    redirect: "manual",
  });
  if (!res.ok) throw new Error(`${agent} ${path}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { json: T }).json;
}
