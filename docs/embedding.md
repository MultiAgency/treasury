# Embedding Treasury in a host app

Treasury can be built as a Module Federation remote so a host (for example the MultiAgency
dashboard) can load it. This is the build and the mount API only. It does not decide whether the
dashboard should embed Treasury, and it does not make an embedded Treasury sign in or call the
gateway from another origin. Those are open (see [Limits](#limits)).

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
| `treasury/mount` | `mount(container: HTMLElement): { unmount(): void }` | Renders Treasury into `container`; `unmount()` removes it |

React and React DOM are shared as singletons with the host. Everything else Treasury brings itself.

## Host side

```ts
// Module Federation host config
remotes: { treasury: "treasury@https://<where dist-embed is served>/remoteEntry.js" }

// where Treasury should appear
const { mount } = await import("treasury/mount");
const embedded = mount(document.getElementById("treasury-slot")!);
// later: embedded.unmount();
```

`pnpm test:embed` does exactly this with a small host built by the same plugin.

## What the embed does and does not do

- It renders the same app as the standalone page (`web/src/treasury-root.tsx`).
- It does not touch the host document: no theme classes on `<html>`, no changes outside the container.
- Owner signing and money actions are unchanged. The host cannot trigger them; they still need the owner's explicit signature.
- Its assets load from the remote's own origin (`assetPrefix: "auto"`).
- `pnpm check:frontend` covers the embed entry as well as the standalone one: declared capabilities only, no shared Payables modules.

## Limits

These are not solved by this build and are tracked separately.

1. **Its own shell and sign-in.** Embedded, Treasury still renders its own header and asks the user to sign in through `/gw/me` (treasury#2, embedded mode).
2. **Gateway access from another origin.** Treasury calls `/gw/*` and `/a/<agent>/rpc/*` on the page's own origin. Proto sessions are host-bound and cross-origin calls are refused, so a host on another origin needs gateway support first (agentic-treasury#3).
3. **Where the app lives.** It reads the agent from `location.pathname` (`/a/<agent>`) and the view from `location.hash`. A host route has to fit that until embedded mode takes the owner from the host.
4. **Global styles.** The stylesheet and the `treasury-theme` rules apply to the whole document, and the Treasury dark theme is keyed on `<html>`. Scoping them to the container is future work, so an embedded Treasury follows the host's theme.
5. **One mount at a time.** The query cache is shared by the module, so mounting two Treasuries on one page would share it.
