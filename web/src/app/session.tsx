import { SignIn as SignInIcon, SignOut } from "@phosphor-icons/react";
import { readGateway, type Gateway } from "./gateway-contract";
export type { Gateway, GatewayAgent } from "./gateway-contract";
import { useState } from "react";
import { errorMessage, gw } from "../shared/lib";
import { Button, Card, ErrorBox, Spinner } from "../shared/ui";
import { useViewer } from "./viewer";
import { signChallenge, signOutMember } from "../features/owner/wallet";

/** The agents' owners, each once, in order. Signed out, the gateway lists only DAOs' agents, so these are DAOs. */
export const ownersOf = (agents: Gateway["agents"]) => [...new Set(agents.map((a) => a.owner))];

/**
 * The gateway's view of this visitor, or null when the page is served by a local agent server, which
 * answers /gw/me with the page itself. An error from a gateway, or from the proxy in front of it,
 * throws: a hosted page must never fall back to the trusted local view on loopback.
 */
export async function loadGateway(): Promise<Gateway | null> {
  return readGateway(await fetch("/gw/me"), location);
}

export async function signOut() {
  await fetch("/gw/logout", { method: "POST" });
  await signOutMember().catch(() => {});
  location.assign("/");
}

export function SignIn({ daos, compact = false, create = false, primary = false }: { daos: string[]; compact?: boolean; create?: boolean; primary?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const signIn = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const challenge = await gw<{ message: string; recipient: string; nonce: string }>("/gw/challenge");
      await gw("/gw/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(await signChallenge(challenge)),
      });
      // Back to the page they asked for: signed out, any address shows the public page in its place.
      // A reload, not assign: assigning a URL with a hash is a fragment navigation and loads nothing.
      location.reload();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const action = <>
    <ErrorBox error={error} />
    <span role="status" className="sr-only">{busy ? "Complete sign-in in your NEAR wallet." : ""}</span>
    <Button variant={primary ? "default" : "outline"} size={primary ? "default" : "sm"} className="w-fit" onClick={signIn} disabled={busy}>
      {busy ? <Spinner /> : <SignInIcon size={16} aria-hidden="true" />} {busy ? "Connecting…" : "Connect wallet"}
    </Button>
  </>;
  if (compact) return <div className="flex max-w-sm flex-col items-start gap-2">{action}</div>;
  return (
    <Card>
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">{create ? "Start with your NEAR account" : "Members"}</h2>
        <p className="text-sm text-muted-foreground">
          {create ? "Connect your NEAR wallet to create a treasury for your account or a Sputnik DAO. Sign-in signs a message; creating an agent requires a separate owner action." : <>Sign in with the NEAR wallet that owns an agent here{daos.length > 0 && `, or as a member of ${daos.join(" or ")}`}. You sign a message, not a transaction: nothing is sent on chain.</>}
        </p>
      </div>
      {action}
    </Card>
  );
}

export function ViewerBadge() {
  const viewer = useViewer();
  if (!viewer) return null;
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <div className="flex min-w-0 flex-col">
        <span className="truncate" title={viewer.account}>
          {viewer.account}
        </span>
        <span className="text-muted-foreground">Signed in</span>
      </div>
      <Button variant="ghost" size="sm" onClick={signOut} aria-label="Sign out">
        <SignOut size={16} />
      </Button>
    </div>
  );
}
