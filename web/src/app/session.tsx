import { SignIn as SignInIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { gateway } from "../platform";
import { Button, ErrorBox, Spinner, errorMessage } from "../shared/ui";
import { announceSessionChange } from "./session-signal";
import { disconnect, signChallenge } from "./wallet";

/**
 * Ends the host session and the wallet connection, then starts again at the host's root. If the gateway doesn't
 * confirm the sign-out, it throws and changes nothing: the wallet stays connected and the page stays put.
 */
export async function signOut() {
  try {
    await gateway.signOut();
  } catch (error) {
    if (error instanceof TypeError) throw new Error("Sign-out didn't reach the gateway. You're still signed in; check your connection and try again.");
    throw error;
  }
  await disconnect().catch(() => {});
  announceSessionChange();
  location.assign("/");
}

/** `className` restyles the button and `containerClassName` its wrapper (the signed-out landing); behaviour is unchanged. */
export function SignIn({ primary = false, className, containerClassName }: { primary?: boolean; className?: string; containerClassName?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const signIn = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await gateway.signIn(await signChallenge(await gateway.challenge()));
      // Back to the page they asked for: signed out, any address shows the signed-out page in its place.
      // A reload, not assign: assigning a URL with a hash is a fragment navigation and loads nothing.
      announceSessionChange();
      location.reload();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return <div className={containerClassName ?? "flex max-w-sm flex-col items-start gap-2"}>
    <ErrorBox error={error} />
    <span role="status" className="sr-only">{busy ? "Complete sign-in in your NEAR wallet." : ""}</span>
    <Button variant={primary ? "default" : "outline"} size={primary ? "default" : "sm"} className={className ?? "w-fit"} onClick={signIn} disabled={busy}>
      {busy ? <Spinner /> : <SignInIcon size={16} aria-hidden="true" />} {busy ? "Connecting…" : "Connect wallet"}
    </Button>
  </div>;
}
