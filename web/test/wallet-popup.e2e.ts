import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
const require = createRequire(import.meta.url);
const { NearWalletsPopup } = require("@fastnear/near-connect/build/popups/NearWalletsPopup.js");
test("the installed wallet selector settings button has an accessible name while open", async () => {
  const popup = Object.create(NearWalletsPopup.prototype);
  popup.delegate = {};
  popup.state = { wallets: [], showSettings: false };
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(popup.dom.html);
    const violations = (await new AxeBuilder({ page }).withRules(["button-name"]).analyze()).violations;
    console.log(JSON.stringify({ markup: await page.locator(".settings-button").evaluate(el => el.outerHTML), violations }));
    assert.deepEqual(violations, []);
    assert.equal(await page.getByRole("button", { name: "Wallet settings", exact: true }).count(), 1);
  } finally { await browser.close(); }
});
