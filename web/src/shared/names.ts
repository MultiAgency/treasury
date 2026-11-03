import { useSetup } from "../app/frame";
import { short } from "./ui";

/**
 * An account as people know it on an agent's own pages: its wallet is "this agent", any other 64-character account is
 * shortened. Named accounts (alice.near, the DAO) read fine as they are. Sibling agents aren't read in this build.
 */
export function useNameOf() {
  const setup = useSetup();
  return (account: string) => account === setup.wallet ? "this agent" : /^[0-9a-f]{64}$/.test(account) ? short(account) : account;
}
