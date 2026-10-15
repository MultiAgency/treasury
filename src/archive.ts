import { agentId } from "./env.js";
import { api } from "./api.js";
import { ownerRequests } from "./owner-requests.js";
import { runOwnerIntent } from "./owner.js";

const id = agentId();

// The API refuses to archive a live account (pause_before_archive): freeze it first.
const { policy } = await api.getPolicy(id);
if (!policy?.frozen) {
  await runOwnerIntent(ownerRequests.agent_freeze());
}

// Reversible: hides the account and stops it being usable; the wallet and history stay.
await runOwnerIntent({ type: "agent_archive", agent_id: id });
console.log(`Archived ${id}`);
