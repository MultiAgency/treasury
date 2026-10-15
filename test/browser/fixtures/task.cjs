const { resolve } = require('node:path');
const { chromium } = require('./browser.cjs');

/** One browser per task; fresh contexts, diagnostics and failures remain isolated per scenario. */
async function runTask(scenarios) {
  const root = resolve(process.argv[2] || 'web/dist');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    for (const scenario of scenarios) {
      console.log(`Scenario: ${scenario.name}`);
      try { await scenario(browser, root); }
      catch (error) { console.error(error); process.exitCode = 1; }
      finally { for (const context of browser.contexts()) await context.close(); }
    }
  } finally { await browser.close(); }
}
module.exports = { runTask: scenarios => runTask(scenarios).catch(error => { console.error(error); process.exitCode = 1; }) };
