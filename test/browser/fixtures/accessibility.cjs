const assert = require('node:assert/strict');
const AxeBuilder = require('@axe-core/playwright').default;
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

/** Automated WCAG checks supplement keyboard and visual review; they do not prove conformance. */
async function assertAccessible(page, label) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  if (process.env.PROTO_BROWSER_ARTIFACTS) {
    mkdirSync(process.env.PROTO_BROWSER_ARTIFACTS, { recursive: true });
    writeFileSync(join(process.env.PROTO_BROWSER_ARTIFACTS, `${label}-axe.json`), JSON.stringify(result, null, 2));
  }
  assert.deepEqual(result.violations.map(v => ({ rule: v.id, impact: v.impact, targets: v.nodes.map(n => n.target), help: v.help })), [], `${label}: automated accessibility violations`);
}
module.exports = { assertAccessible };
