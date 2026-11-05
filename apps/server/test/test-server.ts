// The server as the in-process tests run it: on a free port, against a fake platform, with generous limits.
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { AuditEntry } from "../src/audit.ts";
import { createDaoRequests } from "../src/dao-requests.ts";
import { standInDaos } from "../src/dao.ts";
import { createServer, type Deps } from "../src/http.ts";
import { standInKeyLookup } from "../src/keys.ts";
import { createSessions } from "../src/sessions.ts";
import { createSignIn } from "../src/signin.ts";
import { HOST, ORIGIN, type wallet } from "./fakes.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

type Wallet = ReturnType<typeof wallet>;

/**
 * Starts the server on a free port: each of `wallets` signs in with its own key, every relayed action is recorded in
 * `audited` (a new array unless given), and limits are high enough not to matter. `deps` replaces any dependency.
 */
export async function testServer({ platform, wallets = [], audited = [], ...deps }: Pick<Deps, "platform"> & Partial<Deps> & { wallets?: Wallet[]; audited?: AuditEntry[] }) {
  const server = createHttpServer(createServer({
    platform,
    signIn: createSignIn({ recipient: HOST, ttlMs: 5 * 60_000, perMinute: 1_000,
      keyLookup: standInKeyLookup(Object.fromEntries(wallets.map(who => [who.accountId, [who.publicKey]]))) }),
    sessions: createSessions({ idleMs: 30 * 60_000, maxMs: 12 * 60 * 60_000 }),
    publicOrigin: ORIGIN, deployment: "treasury", trustedProxyHops: 0, ownerRequestsPerMinute: 1_000,
    audit: { append: async entry => { audited.push(entry); } }, consentsPerDay: 1_000, daoFilingsPerDay: 1_000, keyLookup: async () => "full",
    daos: standInDaos({}), daoRequests: await createDaoRequests(join(tempDir("treasury-test-"), "dao-requests.json")),
    ...deps,
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const write = { origin: ORIGIN, "content-type": "application/json" };
  /** Signs `who` in through the routes, as the page does, and answers the session cookie. */
  const signIn = async (who: Wallet) => {
    const issued = await (await fetch(`${base}/api/session/challenge`, { method: "POST", headers: write, body: "{}" })).json() as { value: Parameters<Wallet["sign"]>[0] };
    const response = await fetch(`${base}/api/session`, { method: "POST", headers: write, body: JSON.stringify(who.sign(issued.value)) });
    return response.headers.get("set-cookie")!.split(";")[0]!;
  };
  return { server, base, audited, signIn };
}
