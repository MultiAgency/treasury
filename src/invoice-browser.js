// @ts-check
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * @typedef {Awaited<ReturnType<typeof import("./invoices.js").mine>>[number]} Invoice
 * @typedef {Omit<import("./agreements.js").Agreement, "payee" | "status"> & {status: Exclude<import("./agreements.js").AgreementStatus, "filed">}} Agreement
 * @typedef {{invoices: Invoice[], agreements: Agreement[], agreed: boolean}} InvoiceList
 * @typedef {{amount: HTMLInputElement, note: HTMLInputElement, submit: HTMLButtonElement, signin: HTMLButtonElement, signout: HTMLButtonElement, refresh: HTMLButtonElement, account: HTMLElement, error: HTMLElement, "step-signin": HTMLElement, "step-invoice": HTMLElement, list: HTMLElement, "not-agreed": HTMLElement, "agreed-chip": HTMLElement, "agreements-card": HTMLElement, agreements: HTMLElement, invoices: HTMLElement, none: HTMLElement, "refresh-error": HTMLElement, "refresh-status": HTMLElement}} Elements
 */

/**
 * The browser owns drafts and rendering; the HTTP handler owns authentication and submission.
 * @param {Pick<import("@fastnear/near-connect").NearConnector, "connect" | "disconnect" | "getConnectedWallet">} connector
 * @param {typeof import("./invoice-page.js").WORDS} WORDS
 * @param {typeof import("./invoice-page.js").AGREEMENT_WORDS} AGREEMENT_WORDS
 */
export async function mountInvoicePage(connector, WORDS, AGREEMENT_WORDS) {
  /** @template {keyof Elements} K @param {K} id @returns {Elements[K]} */
  const $ = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error("Missing invoice element: " + id);
    return /** @type {Elements[K]} */ (element);
  };
  /** @param {string} v */
  const fromBase64 = (v) => Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
  /** @param {string} status */
  const wordsFor = status => Object.entries(WORDS).find(([key]) => key === status)?.[1];
  /** @param {string} message */
  function fail(message) { $("error").textContent = message; $("error").hidden = false; }
  /** @param {string} method @param {string} path @param {unknown} [payload] */
  async function call(method, path, payload) {
    const session = sessionVersion;
    $("error").hidden = true;
    const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    if ((res.status === 401 || res.status === 403) && path.startsWith("/api/invoices")) {
      if (session === sessionVersion) expireSession();
      throw new Error("Sign in again to review the existing invoice.");
    }
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Something went wrong.");
    return json;
  }
  /** @param {boolean} agreed */
  function eligibility(agreed) {
    $("not-agreed").hidden = agreed;
    $("agreed-chip").textContent = agreed ? "Agreed payee" : "Not agreed yet";
    $("agreed-chip").className = "chip " + (agreed ? "ok" : "warn");
    if (!$("submit").disabled) $("submit").textContent = agreed ? "Submit invoice" : "Send request";
  }
  // Local draft identity is not payment evidence. Keep that limitation beside the action after reload.
  const retainedDraft = document.createElement("p");
  retainedDraft.id = "retained-draft";
  retainedDraft.className = "notice";
  retainedDraft.setAttribute("role", "status");
  retainedDraft.textContent = "This form retains a previous submission. Check its existing invoice and payment outcome before submitting again. Do not create a replacement while its outcome is unknown.";
  retainedDraft.hidden = true;
  $("submit").before(retainedDraft);
  let sessionVersion = 0;
  /** @param {string | null} account @param {boolean} agreed */
  function signedIn(account, agreed) {
    sessionVersion++;
    refreshVersion++;
    clearTimeout(timer);
    renderedLists.clear();
    $("invoices").replaceChildren(); $("agreements").replaceChildren();
    $("agreements-card").hidden = true;
    $("none").hidden = true;
    $("refresh").hidden = !account;
    $("refresh-error").textContent = ""; $("refresh-status").textContent = "";
    $("error").hidden = true; $("error").textContent = "";
    $("amount").value = ""; $("note").value = "";
    retainedDraft.hidden = true;
    $("submit").disabled = false;
    $("step-signin").hidden = !!account; $("step-invoice").hidden = !account; $("list").hidden = !account;
    $("account").textContent = account || "";
    eligibility(agreed);
    if (!account) $("signin").focus();
    if (account) {
      const saved = JSON.parse(localStorage.getItem("invoice-draft:" + account) || "null");
      submission = saved?.submission || crypto.randomUUID();
      retainedDraft.hidden = !saved?.submission;
      $("amount").value = saved?.amount || ""; $("note").value = saved?.note || "";
      refresh();
    }
  }
  function expireSession() {
    // Keep the account-scoped draft and its submission identity for a later authenticated return.
    signedIn(null, false);
    fail("Your session expired or access is unavailable. Sign in again to review your existing invoices. Your retained submission identity has not changed.");
  }
  /** @param {string | null} raw */
  const usdc = (raw) => raw === null ? "" : (Number(raw) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 }) + " USDC";
  /** @param {string} raw */
  const decimal = (raw) => String(Number(raw) / 1e6);
  /** @param {string} iso */
  const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  // One row: what it is, its status as a chip with the page's words, and when.
  /** @param {string} title @param {string} status @param {string} tone @param {string} at */
  function row(title, status, tone, at) {
    const item = document.createElement("li");
    const head = document.createElement("div"); head.textContent = title;
    const chip = document.createElement("span"); chip.textContent = status; chip.className = "chip " + tone; chip.style.alignSelf = "flex-start";
    const time = document.createElement("span"); time.textContent = when(at); time.className = "when";
    item.append(head, chip, time);
    return item;
  }
  // An agreed request files under its own submission (the same invoice); an offer fills in the form.
  /** @param {Agreement} agreement */
  async function fileAgreement(agreement) {
    const session = sessionVersion;
    if (agreement.origin === "owner") {
      if (!agreement.terms) { fail("Agreement terms are unavailable. Refresh before filing."); return; }
      $("amount").value = decimal(agreement.terms.maxAmount); $("note").value = agreement.note; submission = crypto.randomUUID(); retainedDraft.hidden = true;
      $("amount").focus(); return;
    }
    try { await call("POST", "/api/invoices", { amount: decimal(agreement.amount), note: agreement.note, submission: agreement.submission }); }
    catch (e) { if (session === sessionVersion) fail(e instanceof Error ? e.message : "The request could not be completed."); }
    if (session === sessionVersion) await refresh();
  }
  // Retain controls through polling, including their focus and in-flight disabled state.
  /** @type {Map<HTMLElement, Map<string, HTMLLIElement>>} */
  const renderedLists = new Map();
  /** @template {{id: string}} T @param {HTMLElement} list @param {T[]} records @param {(record: T) => HTMLLIElement} render */
  function syncRows(list, records, render) {
    const previous = renderedLists.get(list) || new Map();
    const next = new Map();
    records.forEach((record, index) => {
      const fresh = render(record);
      const existing = previous.get(record.id);
      const item = existing || fresh;
      if (existing) {
        const oldChildren = Array.from(existing.children).filter(node => node instanceof HTMLElement);
        const retained = new Set();
        Array.from(fresh.children).filter(node => node instanceof HTMLElement).forEach((child, i) => {
          const key = child.dataset.control || String(i);
          const old = oldChildren.find((node, j) => (node.dataset.control || String(j)) === key && node.tagName === child.tagName);
          if (old) {
            retained.add(old);
            if (old.textContent !== child.textContent) old.textContent = child.textContent;
            old.className = child.className;
            old.onclick = child.onclick;
            if (existing.children[i] !== old) existing.insertBefore(old, existing.children[i] || null);
          } else existing.insertBefore(child, existing.children[i] || null);
        });
        oldChildren.forEach((node) => {
          if (!retained.has(node)) {
            if (node.contains(document.activeElement)) $("refresh").focus();
            node.remove();
          }
        });
      }
      if (list.children[index] !== item) {
        const focused = document.activeElement instanceof HTMLElement && item.contains(document.activeElement) ? document.activeElement : null;
        list.insertBefore(item, list.children[index] || null);
        if (focused) focused.focus({ preventScroll: true });
      }
      next.set(record.id, item);
    });
    previous.forEach((item, id) => {
      if (!next.has(id)) {
        if (item.contains(document.activeElement)) $("refresh").focus();
        item.remove();
      }
    });
    renderedLists.set(list, next);
  }
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let refreshVersion = 0;
  // Lists the payee's invoices; while any can still change, checks again every 15 seconds.
  async function refresh() {
    if (!$("account").textContent) return;
    const version = ++refreshVersion;
    clearTimeout(timer);
    $("refresh").hidden = false;
    try {
    const res = await fetch("/api/invoices");
    if (version !== refreshVersion) return;
    if (res.status === 401 || res.status === 403) { expireSession(); return; }
    if (!res.ok) throw new Error("Invoice status could not be checked. Showing the last loaded records.");
    /** @type {InvoiceList} */
    const { invoices, agreements, agreed } = await res.json();
    if (version !== refreshVersion) return;
    eligibility(agreed);
    $("agreements-card").hidden = agreements.length === 0;
    syncRows($("agreements"), agreements, (agreement) => {
      const terms = agreement.terms ? "up to " + usdc(agreement.terms.maxAmount) + " until " + new Date(agreement.terms.until).toLocaleDateString() : usdc(agreement.amount);
      const title = [agreement.origin === "owner" ? "Offered by the DAO" : "Requested", terms, agreement.note].filter(Boolean).join(" · ");
      const tone = agreement.status === "declined" ? "warn" : agreement.status === "agreed" ? "ok" : "";
      const item = row(title, AGREEMENT_WORDS[agreement.status] || agreement.status, tone, agreement.at);
      if (agreement.status === "agreed") {
        const button = document.createElement("button");
        button.dataset.control = "agreement";
        button.textContent = agreement.origin === "owner" ? "Use these terms" : "File this invoice";
        button.onclick = () => fileAgreement(agreement);
        item.append(button);
      }
      return item;
    });
    $("none").hidden = invoices.length > 0;
    syncRows($("invoices"), invoices, (invoice) => {
      const [text, tone] = WORDS[invoice.status] || [invoice.status, ""];
      const title = [usdc(invoice.amount), invoice.note].filter(Boolean).join(" · ");
      const item = row(title, text + (invoice.revisionConflict ? " Changed invoice details require review; the original payment is unchanged." : ""), tone, invoice.filedAt);
      if (invoice.status === "prepared" && !invoice.revisionConflict) {
        const button = document.createElement("button"); button.textContent = "Continue this prepared invoice";
        button.dataset.control = "continue";
        button.onclick = async (event) => {
          const button = /** @type {HTMLButtonElement} */ (event.currentTarget);
          const session = sessionVersion;
          button.disabled = true;
          try {
            const result = await call("POST", "/api/invoices/" + invoice.id + "/continue", {});
            if (session !== sessionVersion) return;
            const words = wordsFor(result.status);
            if (words) fail(words[0]);
            await refresh();
          }
          catch (e) { if (session === sessionVersion) fail(e instanceof Error ? e.message : "The request could not be completed."); } finally { button.disabled = false; }
        };
        item.append(button);
      }
      if (invoice.revisionConflict || ["unknown", "needs_review", "failed", "refused"].includes(invoice.status)) {
        const help = document.createElement("p"); help.dataset.control = "help";
        help.textContent = "Share this reference privately with the treasury operator for review: " + invoice.id;
        const copy = document.createElement("button"); copy.dataset.control = "copy"; copy.textContent = "Copy review reference";
        copy.onclick = async (event) => {
          const copy = /** @type {HTMLButtonElement} */ (event.currentTarget);
          try { await navigator.clipboard.writeText("Invoice " + invoice.id + " · " + invoice.status); copy.textContent = "Copied"; }
          catch { fail("Copy the reference above and send it to the treasury operator."); }
        };
        item.append(help, copy);
      }
      return item;
    });
    if (invoices.some((invoice) => ["waiting", "paying", "unknown", "needs_review"].includes(invoice.status)) ||
        agreements.some((agreement) => ["requested", "proposed"].includes(agreement.status))) timer = setTimeout(refresh, 15000);
    $("refresh-error").textContent = "";
    $("refresh-status").textContent = "Last checked " + new Date().toLocaleTimeString();
    } catch (e) {
      if (version !== refreshVersion) return;
      $("refresh-error").textContent = e instanceof Error ? e.message : "Invoice status could not be checked.";
      timer = setTimeout(refresh, 15000);
    }
  }
  $("refresh").onclick = () => refresh();
  $("signin").onclick = async () => {
    $("signin").disabled = true;
    try {
      const challenge = await call("POST", "/api/signin/challenge");
      await connector.connect();
      const { wallet } = await connector.getConnectedWallet();
      const signed = await wallet.signMessage({ message: challenge.message, recipient: challenge.recipient, nonce: fromBase64(challenge.nonce) });
      const callbackUrls = [...new Set([location.origin + location.pathname, location.href.split("#")[0], location.origin + "/"])];
      const { account, agreed } = await call("POST", "/api/signin", { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: challenge.nonce, callbackUrls });
      signedIn(account, agreed);
    } catch (e) { fail(e instanceof Error ? e.message : "The request could not be completed."); } finally { $("signin").disabled = false; }
  };
  $("signout").onclick = async () => { await call("POST", "/api/signout"); await connector.disconnect().catch(() => {}); signedIn(null, false); };
  // One id per filled-in form: a retry or double click files once; the next invoice gets a new one.
  let submission = crypto.randomUUID();
  $("submit").onclick = async () => {
    const session = sessionVersion;
    $("submit").disabled = true;
    // Filing waits for the API to confirm the payout is held, which can take half a minute.
    $("submit").textContent = "Submitting… this can take up to a minute";
    try {
      const draft = { amount: $("amount").value, note: $("note").value, submission };
      const draftKey = "invoice-draft:" + $("account").textContent;
      localStorage.setItem(draftKey, JSON.stringify(draft));
      retainedDraft.hidden = false;
      const result = await call("POST", "/api/invoices", draft);
      if (session !== sessionVersion) return;
      // A request from an account not yet agreed: recorded, listed under agreements, nothing paid.
      if (result.status === "requested" || result.status === "proposed") {
        localStorage.removeItem(draftKey); retainedDraft.hidden = true; submission = crypto.randomUUID(); $("amount").value = ""; $("note").value = "";
      }
      // Turned away before filing (not agreed, or the queue is full): say so, since it isn't listed.
      if (result.status === "needs_agreement" || result.status === "busy") fail(wordsFor(result.status)?.[0] ?? result.status);
      if (["waiting", "paying", "paid", "refused"].includes(result.status) && !result.revisionConflict) {
        localStorage.removeItem(draftKey); retainedDraft.hidden = true; submission = crypto.randomUUID(); $("amount").value = ""; $("note").value = "";
      }
      if (["unknown", "prepared", "needs_review", "failed"].includes(result.status)) fail(wordsFor(result.status)?.[0] ?? result.status);
      if (result.status === "refused") fail(WORDS.refused[0]);
      await refresh();
    } catch (e) {
      if (session === sessionVersion) fail(e instanceof Error ? e.message : "The request could not be completed.");
    } finally {
      if (session === sessionVersion) {
        $("submit").disabled = false;
        $("submit").textContent = $("not-agreed").hidden ? "Submit invoice" : "Send request";
      }
    }
  };
  const { account, agreed } = await call("GET", "/api/session");
  signedIn(account, agreed);
}
