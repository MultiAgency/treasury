import { api } from "./api.js";
import { agentId } from "./env.js";

// `pnpm inspect` dumps the agent's policy, balances and grants; `--whoami` only the network and API key's account.
if (process.argv.includes("--whoami")) {
  console.log(await api.getNetwork());
  console.log(await api.whoami());
  process.exit(0);
}

const id = agentId();
const [policy, publicBalances, confidentialBalances, grants] = await Promise.all([
  api.getPolicy(id),
  api.getBalances(id, { source: "public" }),
  api.getBalances(id, { source: "confidential" }),
  api.listGrants(id),
]);
console.dir({ policy, publicBalances, confidentialBalances, grants }, { depth: null });
