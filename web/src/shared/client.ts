import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { Router } from "../../../src/router.js";
import { reportAccessDenial } from "./access";

/**
 * Where this agent's pages live: "" when a local agent server serves them, "/a/<agent>" behind the
 * hosted gateway, which forwards that prefix's calls to the agent's own server.
 */
export const BASE = (location.pathname.match(/^\/a\/[a-z0-9-]+/)?.[0] ?? "") as "" | `/${string}`;

/** A client for the agent server whose pages live at `base` (see BASE). */
export const clientFor = (base: "" | `/${string}`): RouterClient<Router> => createORPCClient(new RPCLink({
  url: `${base}/rpc`,
  async fetch(request, init) {
    const response = await fetch(request, init);
    // Gateway denials are plain HTTP responses, not encoded RPC errors.
    if (response.status === 401 || response.status === 403) {
      const body = await response.clone().json().catch(() => null);
      // Preserve encoded RPC errors, including their messages and structured details.
      if (typeof body?.json?.code !== "string") {
        // Older gateways have no scope field. Their procedure denial must not revoke agent reads.
        const scope = body?.access === "procedure" || body?.error === "Operators only" ? "procedure"
          : body?.access === "session" || response.status === 401 ? "session" : "agent";
        reportAccessDenial({ base, scope, message: typeof body?.error === "string" ? body.error : "Access is no longer available." });
        throw new ORPCError(response.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN", {
          message: typeof body?.error === "string" ? body.error : undefined,
        });
      }
    }
    return response;
  },
}));

export const client = clientFor(BASE);

/** One call to the hosted gateway's own API (`/gw/...`); its `{ error }` answer is thrown. */
export async function gw<T>(path: `/gw/${string}`, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    const message = body.error ?? `${path}: ${response.status}`;
    if (response.status === 401 || response.status === 403) {
      reportAccessDenial({ base: "", scope: response.status === 401 ? "session" : "procedure", message });
      throw new ORPCError(response.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN", { message });
    }
    throw new Error(message);
  }
  return body;
}
