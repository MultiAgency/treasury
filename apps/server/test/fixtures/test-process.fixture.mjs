import { writeFileSync, appendFileSync } from 'node:fs';
import { test } from 'node:test';
import { testChild, testResource } from '../test-process.ts';

const scenario = process.env.LIFECYCLE_SCENARIO;
const pidFile = process.env.LIFECYCLE_PID_FILE;
const resourceFile = process.env.LIFECYCLE_RESOURCE_FILE;
const timeout = scenario === 'after-message' ? 2_000 : ['before-message', 'late-resource'].includes(scenario) ? 1_000 : 5_000;
test(`worker lifecycle: ${scenario}`, { timeout }, async t => {
  await testResource(t, async () => {
    if (scenario === 'late-resource') await new Promise(resolve => setTimeout(resolve, 1_300));
    return {};
  }, async () => { appendFileSync(resourceFile, 'disposed\n'); });
  if (scenario === 'late-resource') throw new Error('late startup should have been cancelled');
  const script = scenario === 'before-message'
    ? 'setInterval(() => {}, 1000)'
    : scenario === 'normal'
      ? 'process.send("ready"); process.disconnect()'
      : 'process.send("ready"); process.disconnect(); setInterval(() => {}, 1000)';
  const worker = testChild(t, ['-e', script], {
    cwd: scenario === 'spawn-error' ? `${pidFile}-missing-directory` : undefined,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  }, { exitMs: scenario === 'exit-deadline' ? 100 : 10_000 });
  if (worker.child.pid) writeFileSync(pidFile, String(worker.child.pid));
  if (scenario !== 'spawn-error') {
    await worker.next();
    writeFileSync(`${pidFile}.ready`, 'ready');
  }
  await worker.exit();
});
