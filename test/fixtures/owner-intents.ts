// Child process for owner-intents.test.ts: starts as a restarted server would, over the pending file
// the test wrote, and prints the status of each correlation id in argv.
import { status } from "../../src/owner-intents.js";

console.log(JSON.stringify(process.argv.slice(2).map((id) => status(id).stage)));
