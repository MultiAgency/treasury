// Signs the owner's grant bound to `portfolio`'s saved strategy on the platform's simulated stack, through the stack's
// `authorizeStrategy` control, and prints the digest it binds. A machine credential's `executePlan` needs it; saving
// the strategy again unbinds it.
//
//   node scripts/stack-authorize.ts <stack directory>
import { authorizeStrategy, stack } from "./stack.ts";

try {
  const [directory, ...rest] = process.argv.slice(2);
  if (!directory || rest.length) throw new Error("Usage: stack-authorize <stack directory>");
  console.log(await authorizeStrategy(stack(directory)));
} catch (error) {
  // Includes the platform's own refusal when signing fails.
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
