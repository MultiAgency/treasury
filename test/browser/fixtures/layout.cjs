const assert = require('node:assert/strict');

/** Exercise layout on an already loaded state; do not replay its behavior at every width. */
async function assertResponsive(page, label) {
  const viewport = page.viewportSize();
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: viewport?.height || 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label}: overflow at ${width}px`);
  }
  if (viewport) await page.setViewportSize(viewport);
}
module.exports = { assertResponsive };
