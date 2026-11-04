import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { onSessionEnded } from "./queries";
import "../styles.css";
import "../treasury-theme.css";

document.documentElement.classList.add("treasury-theme", "dark");

const queryClient: QueryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
  queryCache: new QueryCache({ onError: (error, query) => onSessionEnded(queryClient, error, query.queryKey) }),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode><QueryClientProvider client={queryClient}><App /></QueryClientProvider></StrictMode>,
);
