import { ledger, ledgerCsv, reconcileBooks } from "./ledger.js";

// `pnpm books` reconciles the agent's balances; `pnpm books --csv` prints the ledger as CSV.
if (process.argv.includes("--csv")) process.stdout.write(ledgerCsv(await ledger()));
else
  for (const r of await reconcileBooks()) {
    console.log(`${r.symbol}`);
    console.log(`  public        API ${r.public.api}, chain ${r.public.chain}${r.public.drift === "0" ? "" : `, DRIFT ${r.public.drift}`}`);
    console.log(
      `  confidential  API ${r.confidential.api}, recorded ${r.confidential.recorded}${r.confidential.unattributed === "0" ? "" : `, unexplained difference ${r.confidential.unattributed}`}`,
    );
  }
