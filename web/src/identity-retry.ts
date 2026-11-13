import type { Failure } from "./server-api";

/** A newly reserved agent may still be starting. Only retry its safe identity read, up to three times. */
export const retryIdentity = (failures: number, failure: Failure | undefined) =>
  failures < 3 && failure?.kind === "unavailable";
