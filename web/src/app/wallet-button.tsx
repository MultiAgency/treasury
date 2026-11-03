import { Wallet as WalletIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button, ErrorBox, Spinner, errorMessage, short } from "../shared/ui";
import { signOut } from "./session";
import { useViewer } from "./viewer";
import { connect, disconnect, useWallet } from "./wallet";

/**
 * The connected wallet, and disconnecting it, which signs the member out of this host as well. A wallet connected to
 * another account than the session's is called out: owner actions wait until they match (see `useCanCall`). Signed in
 * with no wallet connected (disconnected from the wallet itself, or a new browser profile), "Sign out" ends the session.
 */
export function WalletButton() {
  const wallet = useWallet();
  const viewer = useViewer();
  const [error, setError] = useState<string>();
  if (wallet.status === "connected" && wallet.accountId) {
    const mismatch = viewer !== null && wallet.accountId !== viewer.account;
    return <div className="flex max-w-sm flex-col items-end gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="outline" size="sm" aria-label={`Wallet: ${wallet.accountId}`}><WalletIcon data-icon="inline-start" aria-hidden="true" />{short(wallet.accountId)}</Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end"><DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => {
            setError(undefined);
            (viewer ? signOut() : disconnect()).catch(e => setError(errorMessage(e)));
          }}>Disconnect</DropdownMenuItem>
        </DropdownMenuGroup></DropdownMenuContent>
      </DropdownMenu>
      {/* A status, not an alert: it stays while the mismatch does, and an alert would be announced again on every page. */}
      {mismatch && <p role="status" className="text-right text-sm">
        This wallet is connected to {wallet.accountId}, but you're signed in as {viewer.account}. Owner actions are unavailable until they match.
      </p>}
      <ErrorBox error={error} />
    </div>;
  }
  return <div className="flex max-w-sm flex-col items-end gap-2">
    <Button variant="outline" size="sm" className="h-auto max-w-full whitespace-normal py-3" disabled={wallet.status === "connecting"} onClick={() => {
      setError(undefined);
      connect().catch(e => setError(errorMessage(e)));
    }}>
      {wallet.status === "connecting" ? <Spinner /> : <WalletIcon size={16} />}
      Connect wallet
    </Button>
    {viewer && <Button variant="ghost" size="sm" onClick={() => {
      setError(undefined);
      signOut().catch(e => setError(errorMessage(e)));
    }}>Sign out</Button>}
    <ErrorBox error={error} />
  </div>;
}
