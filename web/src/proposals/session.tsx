import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Button, ErrorBox, errorMessage } from "../shared/ui";
import { api } from "./queries";
import { sign } from "./wallet";
import { failureText } from "./words";

/** Signs in to this server: the owner's wallet signs the server's challenge, addressed to this server's own host. */
export function SignIn() {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const signIn = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const issued = await api.challenge();
      if (!issued.ok) return setError(failureText(issued, "sign-in"));
      let signed;
      try { signed = await sign(issued.value); } catch (problem) { return setError(`The wallet didn't sign: ${errorMessage(problem)}`); }
      const session = await api.signIn({ accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: issued.value.nonce });
      if (!session.ok) return setError(failureText(session, "sign-in"));
      await client.resetQueries();
    } finally { setBusy(false); }
  };
  return <section aria-labelledby="sign-in" className="flex max-w-md flex-col items-start gap-4">
    <h2 id="sign-in" className="text-xl font-semibold">Sign in</h2>
    <p className="text-sm text-muted-foreground">Sign in with the wallet of the account that owns the Treasury, or for one a DAO owns, your own account as one of its members. Your wallet signs a message addressed to this server; it moves nothing.</p>
    <ErrorBox error={error} />
    <Button disabled={busy} onClick={signIn}>{busy ? "Signing in…" : "Sign in with wallet"}</Button>
  </section>;
}

/** Who is signed in, and signing out, which ends the server's session whatever the wallet does. */
export function SignedIn({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const signOut = async () => {
    setBusy(true);
    setError(undefined);
    const ended = await api.signOut();
    setBusy(false);
    if (!ended.ok) return setError("Sign-out didn't complete, so you may still be signed in. Try again.");
    await client.resetQueries();
  };
  return <div className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-3 text-sm">
      {children && <p>{children}</p>}
      <Button variant="outline" size="sm" disabled={busy} onClick={signOut}>{busy ? "Signing out…" : "Sign out"}</Button>
    </div>
    <ErrorBox error={error} />
  </div>;
}
