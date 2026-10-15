// One payout executor serves both the private dashboard and public invoices. There is no invoice
// grant or separate money writer. The public port may be supplied by the deployment platform.
process.env.INVOICES_PORT ??= process.env.PORT ?? "8791";
process.env.PORT = process.env.AGENT_PORT ?? "8790";
await import("./server.js");
