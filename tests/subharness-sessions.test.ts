// The session map (src/subharness/sessions.ts) when it cannot be written: a failed write never stops an agent run, and the run
// reports it as a gap, which an inspection names under `Service runs`. The fake claude and the keys are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { subharnessPlace } from '../src/subharness/place.ts';
import { SESSION_MAP_GAP, runAgent } from '../src/subharness/run.ts';
import { readSessionMap, recordSession } from '../src/subharness/sessions.ts';
import { readReport } from '../src/watcher/read.ts';
import { DAY, answerOf, inspectionDeps, inspectionRig, sectionOf } from './fixtures/watcher-inspection-rig.ts';
import { writeFakeClaude } from './fixtures/claude-transcript.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

function installed() {
  const privateDir = tempDir('nep-session-map-');
  writeKeysFile(privateDir, { subharness: { backends: ['claude'], key: null, modes: {}, models: {}, uses: {} } });
  const argv = path.join(privateDir, 'argv');
  writeFakeClaude(subharnessPlace(privateDir, 'claude').binary, argv, '  --session-id <uuid>');
  return {
    privateDir,
    deps: { privateDir, denyDir: tempDir('nep-session-map-deny-') },
    run: { agent: 'dev', brief: 'B', cwd: privateDir, timeoutMs: 5_000 },
  };
}

test('a map that cannot be written leaves the run going, with its answer, its session id and the gap', async () => {
  // Bug: bookkeeping for the review stops the work it reviews, or the failure leaves no trace in the run's result.
  const { privateDir, deps, run } = installed();
  fs.mkdirSync(path.join(privateDir, 'subharness', 'sessions.jsonl'), { recursive: true });
  const done = await runAgent(run, deps);
  assert.equal(done.ok, true);
  assert.equal(done.text, 'THE-ANSWER');
  assert.deepEqual(done.gaps, [SESSION_MAP_GAP]);
  assert.ok(done.sessionId);
});

test('a run whose map was written reports no gap', async () => {
  // Bug: the gap is set on every run, so the report's line means nothing.
  const { deps, run } = installed();
  const done = await runAgent(run, deps);
  assert.equal(done.gaps, undefined);
});

test('the gap of the watcher run is named under Unavailable checks of Service runs', async () => {
  // Bug: the run's gap stops at the result, and a day with unattributed sessions has no word on why.
  const { runInspection } = await import('../src/watcher/inspection.ts');
  const rig = inspectionRig();
  await runInspection(
    inspectionDeps(rig, {
      runAgent: () => Promise.resolve({ ok: true, text: answerOf(), exitCode: 0, gaps: [SESSION_MAP_GAP] }),
    })
  );
  const read = readReport(rig.reportsDir, DAY);
  assert.ok(read.ok);
  const [, unavailable] = sectionOf(read.report.text, 'Service runs').split('### Unavailable checks');
  assert.ok(unavailable?.includes(`- ${SESSION_MAP_GAP}`));
  assert.doesNotMatch(unavailable ?? '', /^none$/m);
});

test('a torn line of the map is skipped and the rows around it stay', () => {
  // Bug: a process killed mid-append blinds every later read of the map.
  const privateDir = tempDir('nep-session-map-');
  recordSession(privateDir, { sessionId: 's1', agent: 'dev', backend: 'claude', runId: 't1', at: 1 });
  fs.appendFileSync(path.join(privateDir, 'subharness', 'sessions.jsonl'), '{"sessionId":"s2\n');
  recordSession(privateDir, { sessionId: 's3', agent: 'scout', backend: 'claude', runId: null, at: 2 });
  assert.deepEqual(
    readSessionMap(privateDir).map((row) => row.sessionId),
    ['s1', 's3']
  );
});
