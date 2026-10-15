const { chromium } = require('./browser.cjs');
const { rpcValue } = require('./rpc.cjs');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ body: String(rpcValue({}, 'unexpected-write')) }));
    await page.goto('http://fixture.invalid').catch(() => {});
    await page.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
