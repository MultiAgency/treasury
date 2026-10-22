# Embedding Treasury in a host app

Treasury can be built as a Module Federation remote so a host (for example the MultiAgency
dashboard) can load it, and it has an embedded mode: the host names the treasury and the signed-in
account, and Treasury drops its own header, footer and sign-in. This page covers the build, the
mount API and what embedded mode does. It does not decide whether the dashboard should embed
Treasury, and it does not make a host on another origin able to reach the gateway. That is open (see
[Limits](#limits)).

## Build

```sh
pnpm build:embed      # PUBLIC_TREASURY_EMBED=true, writes web/dist-embed/
pnpm test:embed       # builds it, then loads it into a host from another origin
```

The standalone build (`pnpm build:web`, `web/dist/`) is unchanged. The embed build is opt-in, ships
no `contract.json` or `skill.md`, and is not a release artifact.

`web/dist-embed/remoteEntry.js` is the remote entry. It declares the remote `treasury` and exposes one module:

| Module | Export | Meaning |
|---|---|---|
| `treasury/mount` | `mount(container, { agent, account }): Promise<{ unmount() }>` | Renders Treasury into `container` for the agent named `agent`; `account` is the account the host has signed in |

`agent` is the name in `/a/<agent>/`. `mount` rejects without both. Only one Treasury can be mounted
in a page at a time, and a page serves one agent: to switch agents, reload the page.

React and React DOM are shared as singletons with the host. Everything else Treasury brings itself.

## Host side

```ts
// Module Federation host config
remotes: { treasury: "treasury@https://<where dist-embed is served>/remoteEntry.js" }

// where Treasury should appear
const { mount } = await import("treasury/mount");
const embedded = await mount(document.getElementById("treasury-slot")!, {
  agent: "treasury",          // the treasury agent's name
  account: "alice.near",      // the account the host has signed in
});
// later: embedded.unmount();
```

`pnpm test:embed` does exactly this with a small host built by the same plugin, against a fixture gateway.

## What embedded mode does

- **No standalone chrome.** No brand header, no "Your treasuries" footer, no Treasury sign-in. Navigation is the Treasury tasks (overview, strategy, balances and funding, policy and limits). The owner and the wallet button stay, because owner approvals are signed there.
- **Who and which treasury come from the host.** The agent is the one the host names, not the page address. The account the host reports must be the account the gateway has signed in: if they differ, Treasury shows "Account mismatch" and reads no private records. If nobody is signed in it asks the user to sign in to the host. The gateway still authorizes every call; the host's claim never widens access.
- **The host page is left alone.** Treasury keeps its place in memory (no changes to the host's address bar), links inside Treasury move within it, any other link does nothing, the host's title and `<html>` are untouched, and "Disconnect" disconnects the wallet only: it does not sign the host out.
- **Owner signing and money actions are unchanged.** The mount API has no way to start one. Owner actions are still prepared, signed by the owner's wallet and submitted from Treasury's own explicit controls. The test checks that mounting and navigating call no procedure that sends, saves or signs.
- Its assets load from the remote's own origin (`assetPrefix: "auto"`).
- `pnpm check:frontend` covers the embed entry as well as the standalone one: declared capabilities only, no shared Payables modules.

## Limits

These are not solved by this build and are tracked separately.

1. **Gateway access from another origin.** Treasury calls `/gw/*` and `/a/<agent>/rpc/*` on the page's own origin. Proto sessions are host-bound and cross-origin calls are refused, so a host on another origin needs gateway support first (agentic-treasury#3). The host test serves the gateway from the host's own origin.
2. **Wallet.** Owner approvals still use Treasury's own wallet connection; the host's wallet is not shared.
3. **Global styles.** The stylesheet and the `treasury-theme` rules apply to the whole document, and the Treasury dark theme is keyed on `<html>`, which the embed does not set. Scoping them to the container is future work, so an embedded Treasury follows the host's theme.
4. **One mount and one agent per page.** The query cache and the agent's address are module state.
5. **Skip link and focus.** The "skip to main content" link and the focus handling assume the whole page; they work inside the container but are not tuned for a host layout.
