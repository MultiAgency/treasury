import { api } from "./api.js";
import { ENV_FILE, saveEnv } from "./env.js";
import { ownerRequests } from "./owner-requests.js";
import { owner, runOwnerIntent } from "./owner.js";

const status = await runOwnerIntent(ownerRequests.agent_create(owner));
if (!status.agent_id) throw new Error("agent_create succeeded without an agent id");

saveEnv({ AGENT_ID: status.agent_id });
console.log(await api.getAgent(status.agent_id));
console.log(`\nAgent created; saved to ${ENV_FILE} as AGENT_ID`);
