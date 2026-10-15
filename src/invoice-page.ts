import { readFileSync } from "node:fs";
import type { AgreementStatus } from "./agreements.js";
import type { Status } from "./invoices.js";

export const invoiceBrowser = readFileSync(new URL("./invoice-browser.js", import.meta.url), "utf8");

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * near-connect's wallet list, pinned to a reviewed commit. Each wallet's own code still
 * loads from the URL the list names (mostly raw.githubusercontent.com), so that code can change under
 * the same URL: wallets run sandboxed and every signature is verified here, so the remaining risk is
 * a wallet that phishes for keys. Bump this only after reviewing the new manifest.
 */
const WALLET_MANIFEST = "https://cdn.jsdelivr.net/gh/fastnear/near-connect@d277b41263a8ea0a6892236b22824d46c2c3c377/repository/manifest.json";

/** The one page: sign in as the payee, enter an amount and what it's for, submit, and follow your invoices. */
/** What the page says for each invoice status, and its tone: one entry per `Status`, checked here. */
export const WORDS: Record<Status, [string, "" | "ok" | "warn"]> = {
  needs_agreement: ["This account isn't on the agreed list. A new agreement has to be approved first.", "warn"],
  refused: ["Refused: nothing was sent for this invoice. Ask the operator to review the refusal before trying another payment.", "warn"],
  busy: ["This invoice cannot be submitted right now. Keep this draft and try again later, or ask the operator to check what is blocking it.", "warn"],
  waiting: ["Waiting for approval. The treasury has 24 hours to approve it.", ""],
  paying: ["The payment is processing. Settlement is not yet confirmed.", ""],
  prepared: ["Recorded, never submitted. Continue this invoice with its original terms and payment identity.", ""],
  unknown: ["The payment outcome is unknown. It needs reconciliation; do not create a replacement invoice.", "warn"],
  needs_review: ["This invoice needs review. An existing payment may still be pending; do not file it again as a new invoice.", "warn"],
  paid: ["Paid.", "ok"],
  failed: ["The provider reported a failed or refunded outcome. This alone does not establish that a replacement payment is safe; ask the operator to review it.", "warn"],
};

/** What the page says for each agreement status; a filed one shows as its invoice instead. */
export const AGREEMENT_WORDS: Record<Exclude<AgreementStatus, "filed">, string> = {
  requested: "Waiting for the DAO to agree to pay you. Nothing is paid until it does and you file the invoice.",
  proposed: "The terms are saved; the DAO still needs to approve the policy before you can file.",
  agreed: "Agreed. File the invoice to be paid.",
  declined: "The DAO declined this request.",
};

export function invoicePage(title: string) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
/* The dashboard's tokens (web/src/styles.css), so the payee sees the same product. */
:root{--bg:oklch(0.99 0.003 251);--card:oklch(1 0 0);--fg:oklch(0.22 0.02 251);--muted:oklch(0.5 0.016 251);--line:oklch(0.92 0.006 251);--strong:oklch(0.78 0.012 251);--accent:oklch(0.25 0.035 252);--on-accent:oklch(0.99 0 0);--ok-bg:oklch(0.96 0.035 158);--ok:oklch(0.38 0.09 158);--warn-bg:oklch(0.97 0.04 85);--warn:oklch(0.44 0.1 60);--chip:oklch(0.965 0.005 251)}
@media (prefers-color-scheme:dark){:root{--bg:oklch(0.16 0.012 251);--card:oklch(0.2 0.014 251);--fg:oklch(0.96 0.004 251);--muted:oklch(0.72 0.012 251);--line:oklch(1 0 0 / 10%);--strong:oklch(1 0 0 / 22%);--accent:oklch(0.96 0.004 251);--on-accent:oklch(0.2 0.02 252);--ok-bg:oklch(0.27 0.05 158);--ok:oklch(0.86 0.1 158);--warn-bg:oklch(0.29 0.05 70);--warn:oklch(0.9 0.1 85);--chip:oklch(1 0 0 / 8%)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}
main{max-width:36rem;margin:0 auto;padding:40px 16px;display:flex;flex-direction:column;gap:20px}
h1{font-size:26px;font-weight:600;letter-spacing:-.01em;margin:0}h2{font-size:17px;font-weight:600;margin:0}p{margin:0;color:var(--muted)}
label{display:flex;flex-direction:column;gap:6px;font-size:14px}
input{font:inherit;color:inherit;background:transparent;border:1px solid var(--strong);border-radius:999px;height:44px;padding:0 16px}
button{font:inherit;font-weight:500;border:0;border-radius:999px;height:44px;padding:0 20px;background:var(--accent);color:var(--on-accent);cursor:pointer;align-self:flex-start}
button.link{background:transparent;color:var(--muted);height:auto;padding:0;text-decoration:underline}
button:disabled{opacity:.5;cursor:default}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px;display:flex;flex-direction:column;gap:16px}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.chip{display:inline-block;min-height:24px;padding:3px 10px;border-radius:12px;font-size:12px;line-height:18px;font-weight:500;background:var(--chip);color:var(--muted)}
.chip.ok{background:var(--ok-bg);color:var(--ok)}.chip.warn{background:var(--warn-bg);color:var(--warn)}
ul.items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}ul.items li{display:flex;flex-direction:column;gap:6px;padding:12px 0;border-top:1px solid var(--line)}ul.items li:first-child{border-top:0;padding-top:0}
.when{font-size:13px;color:var(--muted)}.notice{border-radius:12px;padding:12px 16px;font-size:14px;background:var(--warn-bg);color:var(--warn)}
[hidden]{display:none!important}code{word-break:break-all}
</style></head><body><main>
<h1>${escape(title)}</h1>
<p>Sign in with the NEAR account you want to be paid to, enter the USDC amount, and submit. After approval, follow the invoice status until it shows Paid.</p>
<section class="card" id="step-signin">
<p>Your wallet signs a message proving you control the account. It doesn't send a transaction or spend anything.</p>
<button id="signin">Sign in with NEAR</button>
</section>
<section class="card" id="step-invoice" hidden>
<div class="row"><span>Signed in as <code id="account"></code></span><span class="chip" id="agreed-chip"></span><button class="link" id="signout">Sign out</button></div>
<p id="not-agreed" class="notice" hidden>The DAO hasn't agreed to pay this account yet. Submitting sends it a request; you're paid only after it agrees and you file the invoice.</p>
<section id="agreements-card" hidden><h2>Your agreements</h2><ul class="items" id="agreements"></ul></section>
<label>Amount (USDC)<input id="amount" inputmode="decimal" autocomplete="off" placeholder="250"></label>
<label>What's it for? (optional)<input id="note" maxlength="200" autocomplete="off" placeholder="October design work"></label>
<button id="submit">Submit invoice</button>
</section>
<p id="error" class="notice" role="alert" hidden></p>
<p id="refresh-status"></p>
<p id="refresh-error" role="alert"></p>
<button id="refresh" hidden>Check invoice status again</button>
<section class="card" id="list" hidden><h2>Your invoices</h2><ul class="items" id="invoices"></ul><p id="none" hidden>None yet.</p></section>
<script type="module">
import { mountInvoicePage } from "/invoice-browser.js";
import { NearConnector } from "https://cdn.jsdelivr.net/npm/@fastnear/near-connect@0.14.1/+esm";
// The wallet list is pinned to one commit of near-connect's manifest, not its moving main branch.
const connector = new NearConnector({ network: "mainnet", features: { signMessage: true },
  manifest: "${WALLET_MANIFEST}" });
await mountInvoicePage(connector, ${JSON.stringify(WORDS)}, ${JSON.stringify(AGREEMENT_WORDS)});
</script>
</main></body></html>`;
}
