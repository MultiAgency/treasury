import { saveReviewedStrategy } from "../../src/strategy-controls.js";
import { DEFAULT_STRATEGY, strategyDigest } from "../../src/strategy-digest.js";
try {
  await saveReviewedStrategy({ ...DEFAULT_STRATEGY, minLegUsd: Number(process.argv[2]) }, strategyDigest(DEFAULT_STRATEGY));
  process.stdout.write("saved");
} catch (error) {
  process.stdout.write(error instanceof Error ? error.message : String(error));
}
