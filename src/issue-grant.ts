import { ENV_FILE } from "./env.js";
import { GRANT_LABELS, type GrantLabel, grantRequest, promoteGrantToken, stageGrantToken } from "./grants.js";
import { runOwnerIntent } from "./owner.js";

// `pnpm issue-grant [treasury|payout|invoices] [suffix]`; the label defaults to what the policy allows.
const [label, suffix] = process.argv.slice(2) as [GrantLabel | undefined, string | undefined];
if (label && !GRANT_LABELS.includes(label)) throw new Error(`Unknown grant label "${label}"`);
const { token, request } = await grantRequest({ label, suffix });

stageGrantToken(token);

await runOwnerIntent(request);
promoteGrantToken(token);
console.log(`Grant issued; token saved to ${ENV_FILE} as AGENT_GRANT_TOKEN`);
