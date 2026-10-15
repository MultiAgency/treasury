const { chromium: engine } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { mkdirSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');

/** Shared context isolation and diagnostics. The runner removes artifacts for successful suites. */
let sequence = 0;
let fixtureFailed = false;
process.on('exit', () => { if (fixtureFailed) process.exitCode = 1; });
function protectRoutes(target) {
  const register = target.route.bind(target);
  const remove = target.unroute.bind(target);
  const wrappers = new WeakMap();
  target.route = (url, handler, options) => {
    if (!wrappers.has(handler)) wrappers.set(handler, async (route, request) => {
      try { await handler(route, request); }
      catch (error) {
        fixtureFailed = true;
        const message = error instanceof Error ? error.stack : String(error);
        console.error(message);
        if (process.env.PROTO_BROWSER_ARTIFACTS) {
          mkdirSync(process.env.PROTO_BROWSER_ARTIFACTS, { recursive: true });
          appendFileSync(join(process.env.PROTO_BROWSER_ARTIFACTS, 'fixture-errors.log'), message + '\n');
        }
        await route.abort().catch(() => {});
      }
    });
    return register(url, wrappers.get(handler), options);
  };
  target.unroute = (url, handler) => remove(url, handler ? wrappers.get(handler) ?? handler : undefined);
}
async function instrument(context) {
  // Scenario page routes take precedence. Unhandled pages/popups never reach the network.
  await context.route('**/*', route => route.abort());
  await context.routeWebSocket('**/*', socket => socket.close());
  protectRoutes(context);
  context.on('page', page => protectRoutes(page));
  const root = process.env.PROTO_BROWSER_ARTIFACTS;
  if (!root) return context;
  const directory = join(root, `context-${++sequence}`);
  mkdirSync(directory, { recursive: true });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const close = context.close.bind(context);
  let closed = false;
  context.close = async (...args) => {
    if (!closed) {
      closed = true;
      for (const [index, page] of context.pages().entries()) {
        if (!page.isClosed()) await page.screenshot({ path: join(directory, `page-${index}.png`), timeout: 3000 }).catch(() => {});
      }
      await context.tracing.stop({ path: join(directory, 'trace.zip') });
    }
    return close(...args);
  };
  return context;
}

const chromium = {
  async launch(options) {
    const browser = await engine.launch(options);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async options => instrument(await newContext({ ...options, serviceWorkers: 'block' }));
    // Browser.newPage otherwise bypasses the wrapped newContext implementation.
    browser.newPage = async options => {
      const context = await browser.newContext(options);
      const page = await context.newPage();
      page.close = async () => context.close();
      return page;
    };
    const close = browser.close.bind(browser);
    browser.close = async (...args) => {
      try { for (const context of browser.contexts()) await context.close(); }
      finally { await close(...args); }
    };
    return browser;
  },
};
module.exports = { chromium };
