import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const firstJourney = 'invoice, owner approval, and settlement stay distinct across the real stack';
const lostTransfer = 'accepted transfer with lost response stays unresolved after restart and blocks another send';
const transferCount = evidence => evidence.requests.filter(r => r.method === 'POST' && r.path.endsWith('/transfer')).length;
const definitions = [
  { name: 'duplicate-transfer', file: 'src/agent.ts', test: firstJourney, marker: 'E2E_SINGLE_TRANSFER',
    before: '    case "transfer":\n      return grant.transfer(id, action.request, options);',
    after: '    case "transfer":\n      await grant.transfer(id, action.request, options);\n      return grant.transfer(id, action.request, options);',
    witness: evidence => transferCount(evidence) === 2 },
  { name: 'premature-paid', file: 'src/invoices.ts', test: firstJourney, marker: 'E2E_SETTLEMENT_NOT_APPROVAL',
    before: 'case "PROCESSING": case "QUEUED": case "SENT": return "paying";',
    after: 'case "PROCESSING": case "QUEUED": case "SENT": return "paid";',
    witness: evidence => transferCount(evidence) === 1 && evidence.records.payments[0]?.status === 'PROCESSING'
      && evidence.records.reservations[0]?.released === 0 },
  { name: 'approve-only-bypass', file: 'src/agent.ts', test: lostTransfer, marker: 'E2E_APPROVE_ONLY_NO_SEND',
    before: '  if (!executes()) throw new Error("This instance only approves: payouts are sent by the agent\'s executor on its own host");',
    after: '  // Deliberately removed in this disposable challenge copy only.',
    witness: evidence => transferCount(evidence) === 2 },
];
const sha = data => createHash('sha256').update(data).digest('hex');
const specs = suite => [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(specs)];

/** Match the complete discovered baseline; adding a journey must not invalidate the challenge runner. */
export function validateBaseline(baseline, discovered) {
  const cases = report => specs(report).flatMap(spec => spec.tests.map(test => ({
    key: JSON.stringify([spec.id, test.projectId]), title: spec.title, test,
  })));
  const expected = cases(discovered), actual = cases(baseline);
  const keys = rows => rows.map(row => row.key).sort();
  const successful = ({ test }) => test.expectedStatus === 'passed' && test.status === 'expected'
    && test.results.length === 1 && test.results[0].status === 'passed' && test.results[0].retry === 0;
  if (!expected.length || discovered.errors?.length || baseline.errors?.length
    || new Set(keys(expected)).size !== expected.length || new Set(keys(actual)).size !== actual.length
    || JSON.stringify(keys(expected)) !== JSON.stringify(keys(actual))
    || baseline.stats.expected !== expected.length || baseline.stats.unexpected || baseline.stats.skipped || baseline.stats.flaky
    || !actual.every(successful) || definitions.some(definition => !actual.some(row => row.title === definition.test)))
    throw new Error('Challenges require every discovered baseline E2E case to pass once, without skips or retries');
}

/** Mutate fresh descendants of the already-tested snapshot, never the caller's application files. */
export function runChallenges({ snapshot: seed, artifacts, env, root }) {
  const baseline = JSON.parse(readFileSync(join(artifacts, 'results.json')));
  validateBaseline(baseline, JSON.parse(readFileSync(join(artifacts, 'baseline-list.json'))));
  const original = new Map(definitions.map(d => [d.file, sha(readFileSync(join(seed, d.file)))]));
  const summary = { baseline: 'passed', results: [] };
  for (const definition of definitions) {
    const directory = join(artifacts, 'challenges', definition.name), snapshot = join(directory, 'snapshot');
    mkdirSync(directory, { recursive: true });
    cpSync(seed, snapshot, { recursive: true, filter: path => !path.endsWith('/node_modules') });
    symlinkSync(join(root, 'node_modules'), join(snapshot, 'node_modules'), 'dir');
    const file = join(snapshot, definition.file);
    // A changed implementation invalidates the experiment instead of quietly applying a different fault.
    const source = readFileSync(file, 'utf8');
    if (source.split(definition.before).length !== 2) throw new Error(`Challenge source changed: ${definition.name}`);
    const mutated = source.replace(definition.before, definition.after);
    writeFileSync(file, mutated);
    writeFileSync(join(directory, 'mutation.json'), JSON.stringify({ name: definition.name, file: definition.file,
      before: definition.before, after: definition.after, originalHash: sha(source), mutatedHash: sha(mutated),
      test: definition.test, expectedAssertion: definition.marker }, null, 2));
    const local = { ...env, PROTO_E2E_ARTIFACTS: directory,
      NODE_OPTIONS: `--require ${JSON.stringify(join(snapshot, 'test/fixtures/offline-network.cjs'))}` };
    function execute(command, args, log) {
      const result = spawnSync(command, args, { cwd: snapshot, env: local, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180_000 });
      writeFileSync(join(directory, log), `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error ?? ''}`);
      return result;
    }
    const build = execute(join(root, 'node_modules/.bin/rsbuild'), ['build', '--root', 'web'], 'build.log');
    let outcome = 'invalid', detail = 'Build failed', observed = null;
    if (build.status === 0) {
      const result = execute(process.execPath, [join(root, 'node_modules/@playwright/test/cli.js'), 'test', '-c',
        'test/e2e/playwright.config.mjs', '--grep', `^.*${definition.test}$`], 'test.log');
      outcome = result.status === 0 ? 'survived' : 'invalid';
      detail = result.status === 0 ? 'Fault did not fail the test' : 'Expected assertion and independent witness not established';
      const reportPath = join(directory, 'results.json'), cases = join(directory, 'cases');
      if (existsSync(reportPath) && existsSync(cases)) {
        const report = JSON.parse(readFileSync(reportPath));
        const selected = specs(report).filter(s => s.title === definition.test);
        const results = selected.flatMap(s => s.tests).flatMap(t => t.results);
        const evidencePaths = readdirSync(cases).map(name => join(cases, name, 'environment/observations.json')).filter(existsSync);
        if (evidencePaths.length === 1) {
          const evidence = JSON.parse(readFileSync(evidencePaths[0]));
          observed = { transfers: transferCount(evidence), providerErrors: evidence.errors, paymentStates: evidence.records.payments.map(p => p.status) };
          if (result.status === 1 && !result.error && selected.length === 1 && results.length === 1 && results[0].status === 'failed'
            && report.stats.unexpected === 1 && report.stats.skipped === 0 && report.stats.flaky === 0
            && results[0].errors.some(e => e.message?.includes(definition.marker))
            && evidence.errors.length === 0 && definition.witness(evidence)) {
            outcome = 'detected'; detail = definition.marker;
          }
        }
      }
    }
    summary.results.push({ name: definition.name, outcome, detail, observed, directory: resolve(directory) });
    writeFileSync(join(artifacts, 'challenge-results.json'), JSON.stringify(summary, null, 2));
    console.log(`Challenge ${definition.name}: ${outcome} (${detail})`);
  }
  for (const [file, hash] of original) if (sha(readFileSync(join(seed, file))) !== hash) throw new Error(`Baseline changed: ${file}`);
  return summary.results.every(result => result.outcome === 'detected');
}
