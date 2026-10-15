// Prints the instance-scoped values this process sees, then saves AGENT_ID=<argv[2]>.
import { saveEnv } from "../../src/env.js";

console.log(JSON.stringify([process.env.AGENT_ID ?? null, process.env.TREASURY_ACCOUNT ?? null, process.env.SHARED ?? null]));
saveEnv({ AGENT_ID: process.argv[2]! });
