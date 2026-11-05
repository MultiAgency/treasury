import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { onSessionEnded } from "./queries";
import { router } from "./router";
import "../styles.css";
import "../treasury-theme.css";

document.documentElement.classList.add("treasury-theme", "dark");

// A read is made when a page first shows it, then only when it's asked for again (Check again, or an action's own
// refresh) or polled: each is a call against the deployment's shared 1,200 an hour, so returning to a page doesn't repeat it.
const queryClient: QueryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: Infinity } },
  queryCache: new QueryCache({ onError: (error, query) => onSessionEnded(queryClient, error, query.queryKey) }),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></StrictMode>,
);
