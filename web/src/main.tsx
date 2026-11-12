import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { onSessionEnded } from "./queries";
import { router } from "./router";
// The theme (`styles.css`, with its palette in `theme/tokens.css`): unscoped, so the page and every shared primitive read it.
import "./styles.css";

// A read is made when a page shows it, and again only once it's a minute old, when it's asked for (Check again, or an
// action's own refresh), or polled. Each is a call against the deployment's shared 1,200 an hour, so moving between
// pages doesn't repeat it; but the agent changes on its own (autopilot's runs), so what's shown is never older than that.
const STALE_AFTER_MS = 60_000;
const queryClient: QueryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: STALE_AFTER_MS } },
  queryCache: new QueryCache({ onError: (error, query) => onSessionEnded(queryClient, error, query.queryKey) }),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></StrictMode>,
);
