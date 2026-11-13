import { writeFileSync, appendFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
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
  const disconnected = scenario.startsWith('ipc-error') ? once(worker.child, 'disconnect') : undefined;
  if (scenario !== 'spawn-error') {
    await worker.next();
    writeFileSync(`${pidFile}.ready`, 'ready');
  }
  if (disconnected) {
    await disconnected;
    const ipcError = error => error.code === 'ERR_IPC_CHANNEL_CLOSED';
    if (scenario === 'ipc-error-next') {
      const pending = worker.next();
      worker.child.send('configuration');
      await assert.rejects(pending, ipcError);
    } else if (scenario === 'ipc-error-exit') {
      worker.child.send('configuration');
      await assert.rejects(worker.exit(), ipcError);
    } else {
      const failed = once(worker.child, 'error');
      worker.child.send('configuration');
      assert.ok(ipcError((await failed)[0]));
      // Later operational errors also need a listener; they do not prove process exit.
      worker.child.send('configuration-again');
      await new Promise(resolve => setImmediate(resolve));
    }
    await worker.stop();
    assert.ok(worker.child.exitCode !== null || worker.child.signalCode !== null, 'cleanup must observe actual process termination before returning');
    return;
  }
  await worker.exit();
});
