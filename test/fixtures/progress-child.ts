import { progressRecorder } from "../../src/run-progress.js";
const [root, agent, tick] = process.argv.slice(2);
progressRecorder(root!, agent!, tick!).record({ type: "STEP_STARTED", stepName: "execution" });
// Abrupt process exit after a synced start; no finally writes a finish.
process.exit(23);
