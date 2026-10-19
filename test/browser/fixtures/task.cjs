const { mkdirSync, writeFileSync } = require('node:fs');
const { basename, join, resolve } = require('node:path');
const { chromium } = require('./browser.cjs');

const FAILURES = resolve('.test-artifacts/browser-failures');
// A scenario that hasn't finished in this time fails by name, with diagnostics, instead of hanging the run.
const LIMIT_MS = Number(process.env.BROWSER_SCENARIO_LIMIT_MS || 5 * 60_000);

/** A failed or unfinished scenario's name, error and each open page's address and text. Returns the directory. */
async function keepFailure(task, scenario, error, browser) {
  const dir = join(FAILURES, `${new Date().toISOString().replace(/[:.]/g, '-')}-${task}-${scenario}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'error.txt'), `${task} › ${scenario}\n\n${error?.stack ?? error}\n`);
  const pages = browser ? browser.contexts().flatMap(context => context.pages()) : [];
  await Promise.all(pages.map(async (page, i) => {
    writeFileSync(join(dir, `page-${i}.txt`), `${page.url()}\n\n${await page.locator('body').innerText({ timeout: 2_000 }).catch(() => 'Page text unavailable')}\n`);
    await page.screenshot({ path: join(dir, `page-${i}.png`), fullPage: true, timeout: 5_000 }).catch(() => {});
  }));
  return dir;
}

/**
 * Fails the process unless every registered scenario ran to completion, passed or failed. A scenario awaiting
 * something that never settles lets Node exit early with status 0, as does an early `process.exit(0)`; either
 * would otherwise read as a pass.
 */
function requireEvery(task, scenarios, ran, running) {
  process.on('exit', () => {
    const missing = scenarios.filter(scenario => !ran.has(scenario.name)).map(scenario => scenario.name);
    if (!missing.length) return console.log(`${task}: ${ran.size} of ${scenarios.length} scenarios ran`);
    process.exitCode = 1;
    console.error(`${task}: ${ran.size} of ${scenarios.length} scenarios ran; did not run to completion: ${missing.join(', ')}`);
    const scenario = running();
    if (scenario) console.error(`${scenario} was still running when the process ran out of work or exited.`);
  });
}

/** One browser per task; fresh contexts, diagnostics and failures remain isolated per scenario. */
async function runTask(scenarios) {
  const root = resolve(process.argv[2] || 'web/dist'), task = basename(process.argv[1], '.cjs');
  const ran = new Set();
  let current;
  requireEvery(task, scenarios, ran, () => current);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    for (const scenario of scenarios) {
      console.log(`Scenario: ${scenario.name}`);
      current = scenario.name;
      let timer;
      try {
        await Promise.race([scenario(browser, root), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${scenario.name} did not finish within ${LIMIT_MS / 1000}s`)), LIMIT_MS); })]);
      } catch (error) {
        console.error(error); process.exitCode = 1;
        console.error(`Kept failure diagnostics for ${scenario.name}: ${await keepFailure(task, scenario.name, error, browser)}`);
      } finally {
        clearTimeout(timer); ran.add(scenario.name); current = undefined;
        for (const context of browser.contexts()) await context.close();
      }
    }
  } finally { await browser.close(); }
}
/**
 * For a suite with its own browser loop: the whole body counts as one scenario that must finish, within the
 * same time limit. On the limit it exits at once, since the suite's own browser would keep the process alive.
 */
function runSuite(body) {
  const task = basename(process.argv[1], '.cjs'), ran = new Set();
  requireEvery(task, [{ name: task }], ran, () => task);
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${task} did not finish within ${LIMIT_MS / 1000}s`), { limit: true })), LIMIT_MS); });
  return Promise.race([body(), limit])
    .then(() => ran.add(task), error => {
      console.error(error); process.exitCode = 1;
      if (error?.limit) process.exit(1);
      ran.add(task);
    })
    .finally(() => clearTimeout(timer));
}
module.exports = { runSuite, runTask: scenarios => runTask(scenarios).catch(error => { console.error(error); process.exitCode = 1; }) };
