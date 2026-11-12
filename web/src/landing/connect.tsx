import { SignIn as SignInIcon } from "@phosphor-icons/react";
import { ErrorBox, Spinner } from "../shared/ui";
import { useSignIn } from "../session";

/**
 * The landing's Connect wallet: the app's sign-in (`useSignIn`: the server's challenge, the wallet's signature, the
 * session), as one button with what went wrong under it. Signed in, the root's queries are read again and the page
 * becomes the account's treasuries. `className` styles the button and `containerClassName` its wrapper.
 */
export function ConnectWallet({ className, containerClassName }: { className?: string; containerClassName?: string }) {
  const { busy, error, signIn } = useSignIn();
  return <div className={containerClassName}>
    <button type="button" className={className} onClick={signIn} disabled={busy}>
      {busy ? <Spinner /> : <SignInIcon size={16} aria-hidden="true" />} {busy ? "Connecting…" : "Connect wallet"}
    </button>
    <span role="status" className="sr-only">{busy ? "Complete sign-in in your NEAR wallet." : ""}</span>
    <ErrorBox error={error} />
  </div>;
}
