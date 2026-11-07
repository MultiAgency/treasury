// The owner's signature on the platform's confirm page, for the stack tests (#140): an action the platform prepares as
// NEP-366 (a policy edit it enforces itself, for one) comes back to the app only as a link. The owner opens it in a
// browser, connects their wallet and presses "Sign and submit", as the platform's own `app-access.spec.mjs` does. The
// wallet is the stack's: it signs through the stack's controls (`signOwner`, `signOwnerDelegate`), never a module of the
// page replaced.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright";
import { signOwner, signOwnerDelegate, type Stack } from "../../scripts/stack.ts";

type Account = { accountId: string; publicKey: string };

/**
 * Opens `url` (a prepared action's `confirm.url`, on the stack's own host) in a browser of its own, connects `owner`'s
 * wallet and signs: first the link's readable text, then the delegate. Answers once the page says it submitted, with the
 * signatures asked of the wallet, so a test can check what was signed. The page's other requests go to the stack only.
 */
export async function signOnConfirmPage({ browser, target, platform, url, owner }: { browser: Browser; target: Stack; platform: string; url: string; owner: Account }) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "block", reducedMotion: "reduce" });
  const unexpected: string[] = [], asked: { delegate: boolean; message?: string }[] = [];
  try {
    await context.route("**/*", async route => {
      const seen = new URL(route.request().url());
      if (seen.origin === target.origin) return route.continue();
      if (seen.hostname === "cdn.jsdelivr.net" && seen.pathname === "/npm/@fastnear/near-connect@0.14.1/+esm")
        return route.fulfill({ contentType: "text/javascript", body: readFileSync(join(platform, "node_modules", "@fastnear", "near-connect", "cdn", "hot-connect.es.js"), "utf8") });
      if (["cdn.jsdelivr.net", "raw.githubusercontent.com"].includes(seen.hostname) && seen.pathname.endsWith("/manifest.json")) return route.fulfill({ json: { version: "1.0.0", wallets: [] } });
      unexpected.push(seen.href);
      await route.abort();
    });
    await context.exposeFunction("__localSign", (payload: { message: string; recipient: string; nonce: string }) => {
      asked.push({ delegate: false, message: payload.message });
      return signOwner(target, payload);
    });
    await context.exposeFunction("__localSignDelegate", (payload: Parameters<typeof signOwnerDelegate>[1]) => {
      asked.push({ delegate: true });
      // near-connect's transport form: the signed delegate itself, base64. The page refuses anything else as an older form.
      return signOwnerDelegate(target, payload).then(signed => signed.signedDelegate);
    });
    await context.addInitScript(({ account, publicKey, origin }) => {
      if (location.origin !== origin) return;
      const accounts = [{ accountId: account, publicKey }], host = window as unknown as Record<string, (p: unknown) => Promise<unknown>>;
      const wallet = { manifest: { id: "local-test-wallet", name: "Local test wallet", type: "injected", icon: "data:image/svg+xml,<svg xmlns=\"http://www.w3.org/2000/svg\"/>", features: { signMessage: true, signDelegateActions: true } },
        signIn: async () => accounts, getAccounts: async () => accounts, signOut: async () => {},
        signMessage: (payload: { message: string; recipient: string; nonce: Uint8Array }) => host.__localSign!({ ...payload, nonce: btoa(String.fromCharCode(...new Uint8Array(payload.nonce))) }),
        signAndSendTransaction: async () => { throw new Error("Chain submission is not implemented by this test wallet"); },
        signDelegateActions: async ({ delegateActions }: { delegateActions: unknown[] }) => ({ signedDelegateActions: await Promise.all(delegateActions.map(action => host.__localSignDelegate!(action))) }) };
      window.addEventListener("near-selector-ready", () => window.dispatchEvent(new CustomEvent("near-wallet-injected", { detail: wallet })));
      for (const prefix of ["", "member:"]) localStorage.setItem(`${prefix}selected-wallet:mainnet`, "local-test-wallet");
    }, { account: owner.accountId, publicKey: owner.publicKey, origin: target.origin });

    const page = await context.newPage();
    await page.goto(url);
    const sign = page.getByRole("button", { name: "Sign and submit" }), connect = page.getByRole("button", { name: `Connect ${owner.accountId}` });
    await sign.or(connect).waitFor({ timeout: 30_000 });
    // The page may finish connecting the wallet by itself and replace the Connect button while this reaches for it:
    // whichever comes first wins, choosing the local wallet if near-connect asks.
    if (!(await sign.isVisible())) {
      const chooser = page.getByText("Local test wallet", { exact: true });
      const connecting = connect.click({ timeout: 15_000 })
        .then(() => Promise.race([chooser.waitFor({ timeout: 15_000 }).then(() => chooser.click({ timeout: 15_000 })), sign.waitFor({ timeout: 15_000 })]))
        .catch(() => {});
      await Promise.race([connecting, sign.waitFor({ timeout: 30_000 })]);
    }
    await sign.click({ timeout: 15_000 });
    await page.getByText(/Submitted\. The app follows the outcome/).waitFor({ timeout: 30_000 });
    return { asked, unexpected };
  } finally {
    await context.close();
  }
}
