import { gatewayQueries } from "../../app/queries";
import { useQuery } from "@tanstack/react-query";

import { CopyButton, QueryError } from "../../shared/ui";

/** The configured intake, never an assumed host or an invitation claiming permission. */
export function InvoicePageLink({ next = false }: { next?: boolean }) {
  const gateway = useQuery(gatewayQueries.session);
  if (gateway.error) return <QueryError error={gateway.error} retry={() => gateway.refetch()} />;
  if (!gateway.data?.invoices) return <p className="text-sm text-muted-foreground">This agent's invoice page address is not configured here.</p>;
  return <div className="flex flex-wrap items-center gap-2 text-sm">
    {next && <p className="w-full">Next: share the invoice page with the agreed payee.</p>}
    <a className={next ? "inline-flex min-h-11 items-center justify-center rounded-full border px-5 py-2 font-medium hover:bg-accent" : "underline"} href={gateway.data.invoices} target="_blank" rel="noopener noreferrer">Open invoice page</a>
    <CopyButton text={gateway.data.invoices} /> <span>Copy and share with the payee, who signs in with their own account.</span>
  </div>;
}
