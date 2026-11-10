// The inventory of what the archive holds per service (src/watcher/coverage.ts), checked against the code as it is, and
// the report's coverage block (`checkCoverage` of src/watcher/report.ts), which the validator requires of an inspection.
// The audit behind the pins: `archivedLlm` wraps the chat client and the memory session's client in src/core.ts; every
// wake and helper goes through that chat client; the embedder (src/llm/embed.ts) and the speech call
// (src/speech/synth.ts) bypass `complete`. The agents' source is pinned in tests/watcher-transcripts.test.ts.
// Changed: the agents' test here said a CLI run records through the writer or declares its transcript absent. A real run
// of 2026-11-04 showed the transcripts hold those requests, so the coordinator moved that pin to the transcript source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as reports from '../src/watcher/report.ts';
import { readReport } from '../src/watcher/read.ts';
import {
  DAY,
  MINUTE,
  answerOf,
  coverageBlock,
  coverageOf,
  inspectionDeps,
  inspectionRig,
  said,
  templateOf,
} from './fixtures/watcher-inspection-rig.ts';
import { HEADINGS, PLANTED_KEY, reportText } from './fixtures/watcher-rig.ts';

const coverage = () => import('../src/watcher/coverage.ts');
const inspection = () => import('../src/watcher/inspection.ts');

const REPO = fileURLToPath(new URL('..', import.meta.url));
const FIELDS = ['request', 'toolResults', 'backend', 'model', 'runIdentity', 'timestamps', 'outcomeLink'] as const;

test('each recorded field names a file and a symbol that exist', async () => {
  // Bug: the table claims coverage the code lost in a refactor, and nothing says so.
  const { ARCHIVE_COVERAGE } = await coverage();
  for (const entry of ARCHIVE_COVERAGE) {
    for (const name of FIELDS) {
      const field = entry.fields[name];
      if (field.state !== 'recorded') continue;
      const [file, symbol] = field.where.split('#');
      assert.ok(file !== undefined && symbol !== undefined, `${entry.service} ${name}: ${field.where}`);
      assert.ok(
        fs.readFileSync(path.join(REPO, file), 'utf8').includes(symbol),
        `${entry.service} ${name}: ${field.where}`
      );
    }
  }
});

// ---- the report's coverage block -------------------------------------------------------------------------------------

const withBlock = (fields: Readonly<Record<string, unknown>> = {}): string =>
  reportText() + '\n' + coverageBlock(fields);

test('a report with its coverage block passes, and the block is given back as data', () => {
  // Bug: the validator accepts the block but nobody can read it, so calibration greps prose.
  const checked = reports.checkCoverage(withBlock());
  assert.ok(checked.ok);
  assert.deepEqual(checked.coverage, coverageOf());
});

test('a report with no coverage block is refused', () => {
  // Bug: a report that never says what it looked at passes as a clean bill of health.
  const checked = reports.checkCoverage(reportText());
  assert.ok(!checked.ok);
  assert.equal(checked.code, 'coverage-missing');
});

for (const name of [
  'observation',
  'backend',
  'account',
  'sources',
  'defects',
  'suspicious',
  'inspected',
  'unavailable',
] as const) {
  test(`a coverage block without ${name} is refused and names it`, () => {
    // Bug: a report drops "unavailable checks", and missing access reads as nothing wrong.
    const fields = coverageOf();
    delete fields[name];
    const text = reportText() + '\n```coverage\n' + JSON.stringify(fields) + '\n```\n';
    const checked = reports.checkCoverage(text);
    assert.ok(!checked.ok);
    assert.equal(checked.code, 'coverage-invalid');
    assert.ok(checked.detail.includes(name));
  });
}

for (const [name, fields] of [
  ['an interval with no end', { observation: { from: '2026-11-03T06:00:00.000Z' } }],
  [
    'an interval ending before it starts',
    { observation: { from: '2026-11-04T06:00:00.000Z', to: '2026-11-03T06:00:00.000Z' } },
  ],
  ['a date that is no date', { observation: { from: 'yesterday', to: 'today' } }],
  ['a blank backend', { backend: ' ' }],
  ['a blank account', { account: '' }],
  ['no source at all', { sources: [] }],
  ['a list that is no list', { defects: 'none' }],
  [
    'one item both a defect and inspected without a finding',
    { defects: ['memory cursors'], inspected: ['memory cursors'] },
  ],
  ['one item both suspicious and a defect', { defects: ['skill hash'], suspicious: ['skill hash'] }],
] as const) {
  test(`a coverage block with ${name} is refused`, () => {
    // Bug: the structure is there in name only, or the four kinds of finding blur into each other.
    const checked = reports.checkCoverage(withBlock(fields));
    assert.ok(!checked.ok);
    assert.equal(checked.code, 'coverage-invalid');
  });
}

test('two coverage blocks are refused', () => {
  // Bug: the parser takes the first, and a block quoted from an inspected file overrules the real one.
  const checked = reports.checkCoverage(withBlock() + coverageBlock({ backend: 'another' }));
  assert.ok(!checked.ok);
  assert.equal(checked.code, 'coverage-invalid');
});

test('a refusal never quotes the block', () => {
  // Bug: a detail repeats what caused it, so a refused value lands in a log line.
  const checked = reports.checkCoverage(withBlock({ observation: { from: `x${PLANTED_KEY}`, to: 'y' } }));
  assert.ok(!checked.ok);
  assert.equal(checked.detail.includes(PLANTED_KEY), false);
});

test('prompt.md keeps its twelve sections and asks for the coverage block', () => {
  // Bug: the validator requires a block the prompt never asks for, so every live inspection fails its check.
  const prompt = fs.readFileSync(path.join(REPO, 'agents', 'watcher', 'prompt.md'), 'utf8');
  const headings = prompt.split('\n').filter((line) => line.startsWith('## '));
  assert.deepEqual(
    headings.map((line) => line.slice(3)),
    [...HEADINGS]
  );
  assert.ok(prompt.includes('```coverage'));
});

test('an inspection whose answer has no coverage block fails its check and saves nothing', async () => {
  // Bug: the validator exists but the run does not call it.
  const { runInspection } = await inspection();
  const rig = inspectionRig();
  const result = await runInspection(
    inspectionDeps(rig, { runAgent: () => Promise.resolve(said(templateOf({ end: '' }))) })
  );
  assert.equal(result.state, 'failed');
  assert.equal(result.code, 'coverage-missing');
  assert.equal(readReport(rig.reportsDir, DAY).ok, false);
});

test('the brief states the window: from the last success to now, and a failed attempt does not move it', async () => {
  // Bug: a failed run advances the window, and the hours it failed to inspect are never inspected.
  const { runInspection } = await inspection();
  const rig = inspectionRig();
  const iso = (at: number): string => new Date(at).toISOString();
  const start = rig.clock.t;
  await runInspection(inspectionDeps(rig));
  rig.clock.t += MINUTE;
  await runInspection(inspectionDeps(rig, { runAgent: () => Promise.resolve({ ok: false, text: '', exitCode: 3 }) }));
  rig.clock.t += MINUTE;
  const briefs: Array<string> = [];
  await runInspection(
    inspectionDeps(rig, {
      runAgent: (brief) => {
        briefs.push(brief);
        return Promise.resolve(said(answerOf()));
      },
    })
  );
  assert.ok(briefs[0]?.includes(iso(start)), 'opens at the last success');
  assert.ok(briefs[0]?.includes(iso(rig.clock.t)), 'closes now');
  assert.equal(briefs[0]?.includes(iso(start + MINUTE)), false, 'the failed attempt is no boundary');
});
