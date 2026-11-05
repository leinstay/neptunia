// The risk of a finding (src/watcher/risk.ts): the model writes a level, and code alone decides whether the finding
// repeats an earlier successful report. A repeat becomes `low` with a fixed mark, new evidence brings the model's level
// back, a key seen after a verified resolution is new. Through an inspection, the saved lines and the stamped metadata
// follow it, and a repeat files nothing. Everything in this file is synthetic and the clock is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readReport } from '../src/watcher/read.ts';
import * as reports from '../src/watcher/report.ts';
import type { RiskHistoryEntry, RiskLevel } from '../src/watcher/risk.ts';
import { DAY, MINUTE, inspectionDeps, inspectionRig, said, templateOf } from './fixtures/watcher-inspection-rig.ts';
import type { InspectionRig } from './fixtures/watcher-inspection-rig.ts';
import { tasksBlock } from './fixtures/watcher-rig.ts';

const risk = () => import('../src/watcher/risk.ts');
const inspection = () => import('../src/watcher/inspection.ts');
const filing = () => import('../src/watcher/filing.ts');

const CODE_500 = 'the session failed with http_500 in src/memory/db/session.ts:88';
const CODE_503 = 'the session failed with http_503 in src/memory/db/session.ts:88';

const seen = (day: string, key: string, text: string, resolved?: Array<string>): RiskHistoryEntry => ({
  day,
  findings: [{ key, text }],
  ...(resolved === undefined ? {} : { resolved }),
});
const now = (key: string, text: string, level: RiskLevel = 'high') => ({ key, level, text });

// ---- the fingerprint ------------------------------------------------------------------------------------------------

for (const [name, one, other] of [
  ['a timestamp', 'failed with http_500 at 2026-11-03T04:05:06.000Z', 'failed with http_500 at 2026-11-04T21:00:09Z'],
  ['a date', 'failed with http_500 on 2026-11-03', 'failed with http_500 on 2026-11-04'],
  ['a clock time', 'failed with http_500 at 04:05:06', 'failed with http_500 at 21:00:09'],
  [
    'a uuid',
    'failed with http_500 in run 123e4567-e89b-42d3-a456-426614174000',
    'failed with http_500 in run 987e6543-e21b-42d3-a456-426614174999',
  ],
  ['a hex id', 'failed with http_500 in commit a6c2769e', 'failed with http_500 in commit b406ae61'],
  ['a long number', 'failed with http_500 for message 1234567890123', 'failed with http_500 for message 9876543210987'],
  ['case', 'failed with HTTP_500', 'failed with http_500'],
  ['spacing', 'failed   with\thttp_500 ', 'failed with http_500'],
  ['the words around the same evidence', 'the session failed with http_500', 'http_500 stopped that session again'],
] as const) {
  test(`the evidence fingerprint ignores ${name}`, async () => {
    // Bug: a finding that differs only in when or where it was seen counts as new evidence every day.
    const { evidenceFingerprint } = await risk();
    assert.equal(evidenceFingerprint(one), evidenceFingerprint(other));
  });
}

for (const [name, one, other] of [
  ['a failure code', 'failed with http_500', 'failed with http_503'],
  ['a file', 'failed in src/a.ts:12', 'failed in src/b.ts:12'],
  ['a line', 'failed in src/a.ts:12', 'failed in src/a.ts:13'],
  ['an added code', 'failed with http_500', 'failed with http_500 and e_timeout'],
] as const) {
  test(`the evidence fingerprint tells apart ${name}`, async () => {
    // Bug: the normalization eats real evidence, so a new failure is lowered as a repeat of an old one.
    const { evidenceFingerprint } = await risk();
    assert.notEqual(evidenceFingerprint(one), evidenceFingerprint(other));
  });
}

// ---- the rules --------------------------------------------------------------------------------------------------------

test('a finding with no history stays at the model level and counts as new', async () => {
  // Bug: the rules lower or rewrite a first sighting, and the owner never hears about it at the level it was given.
  const { applyRiskRules } = await risk();
  const result = applyRiskRules([now('rail', CODE_500, 'critical')], []);
  assert.equal(result.findings[0]?.level, 'critical');
  assert.equal(result.findings[0]?.repeat, null);
  assert.equal(result.risk, 'critical');
  assert.equal(result.newFindings, 1);
  assert.equal(result.repeats, 0);
});

test('no findings at all give risk none and zero counts', async () => {
  // Bug: an empty report has no highest level, so the metadata row is blank and the report fails its own check.
  const { applyRiskRules } = await risk();
  assert.deepEqual(applyRiskRules([], [seen('2026-11-01', 'rail', CODE_500)]), {
    findings: [],
    risk: 'none',
    newFindings: 0,
    repeats: 0,
  });
});

test('the same key and evidence becomes low with its count and first day, whatever the model wrote', async () => {
  // Bug: the model keeps writing critical about the same bug, and the owner stops reading the top line.
  const { applyRiskRules } = await risk();
  const history = [seen('2026-11-01', 'rail', CODE_500), seen('2026-11-02', 'rail', CODE_500)];
  const [finding] = applyRiskRules([now('rail', CODE_500, 'critical')], history).findings;
  assert.equal(finding?.level, 'low');
  assert.equal(finding?.modelLevel, 'critical');
  assert.deepEqual(finding?.repeat, { count: 3, firstDay: '2026-11-01' });
});

test('changing the key with the same evidence is a repeat', async () => {
  // Bug: the model renames its finding each day and every rename passes as new.
  const { applyRiskRules } = await risk();
  const [finding] = applyRiskRules([now('another-name', CODE_500)], [seen('2026-11-01', 'rail', CODE_500)]).findings;
  assert.equal(finding?.level, 'low');
  assert.deepEqual(finding?.repeat, { count: 2, firstDay: '2026-11-01' });
});

test('rewording with the same key and no new evidence is a repeat, with evidence and with none', async () => {
  // Bug: the fingerprint hashes the prose, so a model that rephrases escapes the rule.
  const { applyRiskRules } = await risk();
  const reworded = applyRiskRules(
    [now('rail', 'src/memory/db/session.ts:88 again gave http_500 to that session')],
    [seen('2026-11-01', 'rail', CODE_500)]
  );
  assert.equal(reworded.findings[0]?.level, 'low');
  const plain = applyRiskRules(
    [now('quiet-channel', 'the channel stayed silent all day')],
    [seen('2026-11-01', 'quiet-channel', 'nobody wrote there the whole day')]
  );
  assert.equal(plain.findings[0]?.level, 'low');
});

test('two findings with no evidence and different keys are both new', async () => {
  // Bug: every prose-only finding fingerprints to the same empty value, so they all repeat each other.
  const { applyRiskRules } = await risk();
  const [finding] = applyRiskRules(
    [now('quiet-channel', 'the channel stayed silent all day')],
    [seen('2026-11-01', 'slow-wake', 'the wake felt slow in the evening')]
  ).findings;
  assert.equal(finding?.level, 'high');
  assert.equal(finding?.repeat, null);
});

test('a difference of a timestamp alone is a repeat and a different failure code is new', async () => {
  // Bug: the owner's two pinned cases go the wrong way round through the rules, whatever the fingerprint alone does.
  const { applyRiskRules } = await risk();
  const history = [seen('2026-11-01', 'rail', `failed with http_500 at 2026-11-01T04:05:06Z`)];
  const stamp = applyRiskRules([now('rail', `failed with http_500 at 2026-11-02T09:10:11Z`)], history);
  assert.equal(stamp.findings[0]?.level, 'low');
  const code = applyRiskRules([now('rail', `failed with http_503 at 2026-11-02T09:10:11Z`)], history);
  assert.equal(code.findings[0]?.level, 'high');
});

test('changed evidence restores the model level and resets the mark, and the count starts from that change', async () => {
  // Bug: a bug that got worse stays low for ever under its old key, or its count runs on from the old failure.
  const { applyRiskRules } = await risk();
  const first = [seen('2026-11-01', 'rail', CODE_500)];
  const [changed] = applyRiskRules([now('rail', CODE_503, 'critical')], first).findings;
  assert.equal(changed?.level, 'critical');
  assert.equal(changed?.repeat, null);
  const [again] = applyRiskRules(
    [now('rail', CODE_503, 'critical')],
    [...first, seen('2026-11-02', 'rail', CODE_503)]
  ).findings;
  assert.equal(again?.level, 'low');
  assert.deepEqual(again?.repeat, { count: 2, firstDay: '2026-11-02' });
});

test('a key seen again after a verified resolution counts as new, and its count starts over', async () => {
  // Bug: a bug that came back is lowered as an old repeat, exactly when it matters that the fix did not hold.
  const { applyRiskRules } = await risk();
  const history = [seen('2026-11-01', 'rail', CODE_500), { day: '2026-11-02', findings: [], resolved: ['rail'] }];
  const [back] = applyRiskRules([now('rail', CODE_500, 'critical')], history).findings;
  assert.equal(back?.level, 'critical');
  assert.equal(back?.repeat, null);
  const [next] = applyRiskRules([now('rail', CODE_500)], [...history, seen('2026-11-03', 'rail', CODE_500)]).findings;
  assert.deepEqual(next?.repeat, { count: 2, firstDay: '2026-11-03' });
});

test('a resolved finding no longer counts under any key, so its evidence under a new name is new too', async () => {
  // Bug: the resolution clears the key only, and a fixed bug that came back under another name is lowered as a repeat.
  const { applyRiskRules } = await risk();
  const history = [seen('2026-11-01', 'rail', CODE_500), { day: '2026-11-02', findings: [], resolved: ['rail'] }];
  const [renamed] = applyRiskRules([now('other-name', CODE_500)], history).findings;
  assert.equal(renamed?.repeat, null);
});

test('the report risk is the highest among new findings and ignores what repeats', async () => {
  // Bug: a repeat keeps the top line at critical for weeks, the same noise the rule exists to remove.
  const { applyRiskRules } = await risk();
  const result = applyRiskRules(
    [now('old', CODE_500, 'critical'), now('a', 'failed with e_one', 'low'), now('b', 'failed with e_two', 'medium')],
    [seen('2026-11-01', 'old', CODE_500)]
  );
  assert.equal(result.risk, 'medium');
  assert.equal(result.newFindings, 2);
  assert.equal(result.repeats, 1);
});

test('the rules change neither their inputs nor anything else', async () => {
  // Bug: the rules write the lowered level back into the history, and the next finding compares against a changed past.
  const { applyRiskRules } = await risk();
  const findings = [now('rail', CODE_500, 'critical')];
  const history = [seen('2026-11-01', 'rail', CODE_500)];
  const before = JSON.stringify({ findings, history });
  applyRiskRules(findings, history);
  assert.equal(JSON.stringify({ findings, history }), before);
});

test('findingsOf reads the two risk subsections of each section, without a mark and without Tasks filed', async () => {
  // Bug: the history counts the engine's filing lines as findings, or keeps the mark and fingerprints its own count.
  const { findingsOf } = await risk();
  const text = templateOf({
    bodies: {
      Errors: {
        'Observed defects': '- [low] rail: failed with http_500 (repeat 2, first 2026-11-01)',
        'Suspicious evidence': '- [medium] hook: a new hook in deploy/x.sh',
        'Inspected without a finding': '- the cursors',
      },
      'Tasks filed': { 'Observed defects': '- T-1 (fix, rail): Rail' },
    },
  });
  assert.deepEqual(findingsOf(text), [
    { section: 'Errors', key: 'rail', level: 'low', text: 'failed with http_500' },
    { section: 'Errors', key: 'hook', level: 'medium', text: 'a new hook in deploy/x.sh' },
  ]);
});

// ---- through an inspection --------------------------------------------------------------------------------------------

const answer = (line: string, drafts: ReadonlyArray<Record<string, unknown>> = []): string =>
  templateOf({ bodies: { Errors: { 'Observed defects': line } } }) + (drafts.length === 0 ? '' : tasksBlock(drafts));

async function saying(rig: InspectionRig, text: string) {
  const { runInspection } = await inspection();
  const result = await runInspection(inspectionDeps(rig, { runAgent: () => Promise.resolve(said(text)) }));
  rig.clock.t += MINUTE;
  return result;
}

function saved(rig: InspectionRig, day = DAY) {
  const read = readReport(rig.reportsDir, day);
  assert.ok(read.ok);
  const checked = reports.checkTemplate(read.report.text);
  assert.ok(checked.ok, checked.ok ? '' : checked.code);
  return { text: read.report.text, metadata: checked.metadata };
}

test('a new finding keeps its level and sets the stamped risk and counts', async () => {
  // Bug: the model's own metadata row stands, and it says none on a day with a critical finding.
  const rig = inspectionRig();
  await saying(rig, answer(`- [high] rail: ${CODE_500}`));
  const { text, metadata } = saved(rig);
  assert.ok(text.includes(`- [high] rail: ${CODE_500}\n`));
  assert.equal(metadata.risk, 'high');
  assert.equal(metadata.newFindings, 1);
  assert.equal(metadata.repeats, 0);
});

test('a repeat is saved as low with its fixed mark, and the stamped risk stays with what is open', async () => {
  // Bug: the rule runs in memory only, and the saved report still says critical.
  const rig = inspectionRig();
  await saying(rig, answer(`- [high] rail: ${CODE_500}`));
  await saying(rig, answer(`- [critical] rail: ${CODE_500}`));
  const { text, metadata } = saved(rig);
  assert.ok(text.includes(`- [low] rail: ${CODE_500} (repeat 2, first ${DAY})\n`), text.slice(0, 900));
  // Changed: `Risk` is the highest open level, by the owner's word after the first real report, so a repeat keeps it high.
  assert.equal(metadata.risk, 'high');
  assert.equal(metadata.newFindings, 0);
  assert.equal(metadata.repeats, 1);
});

test('the mark is never fed back: the third run counts three and keeps one mark, even if the model copies it', async () => {
  // Bug: the fingerprint includes the mark, so a repeat looks new the next day, or marks pile up on one line.
  const rig = inspectionRig();
  await saying(rig, answer(`- [high] rail: ${CODE_500}`));
  await saying(rig, answer(`- [high] rail: ${CODE_500}`));
  await saying(rig, answer(`- [high] rail: ${CODE_500} (repeat 2, first ${DAY})`));
  const { text } = saved(rig);
  assert.ok(text.includes(`- [low] rail: ${CODE_500} (repeat 3, first ${DAY})\n`), text.slice(0, 900));
});

test('a failed attempt is no history: the next sighting is still new', async () => {
  // Bug: a refused report counts as "seen", and a finding is lowered before the owner ever read it.
  const rig = inspectionRig();
  const refused = await saying(rig, `${answer(`- [high] rail: ${CODE_500}`)}\nMore.\n`);
  assert.equal(refused.state, 'failed');
  await saying(rig, answer(`- [high] rail: ${CODE_500}`));
  assert.equal(saved(rig).metadata.risk, 'high');
});

test('a finding repeated on a later day names the first day', async () => {
  // Bug: the history reads the current day only, so yesterday's finding is new again every midnight.
  const rig = inspectionRig();
  await saying(rig, answer(`- [high] rail: ${CODE_500}`));
  rig.clock.t += 24 * 60 * MINUTE;
  await saying(rig, answer(`- [high] rail: ${CODE_500}`));
  const later = new Date(rig.clock.t).toISOString().slice(0, 10);
  const { text } = saved(rig, later);
  assert.ok(text.includes(`(repeat 2, first ${DAY})`));
});

const DRAFT = { kind: 'fix', finding: 'rail', title: 'Retry rail', evidence: 'src/a.ts:1', done: 'It holds' };

test('a draft for a repeated finding files nothing, and one for changed evidence files', async () => {
  // Bug: the board has no open task, so the board check passes and a repeat files a new task every day.
  const { readFilings } = await filing();
  const rig = inspectionRig();
  await saying(rig, answer(`- [high] rail: ${CODE_500}`));
  const repeat = await saying(rig, answer(`- [high] rail: ${CODE_500}`, [DRAFT]));
  assert.equal(rig.fake.rows.length, 0);
  assert.equal(readFilings(rig.dir, repeat.runId)[0]?.state, 'duplicate');
  await saying(rig, answer(`- [high] rail: ${CODE_503}`, [DRAFT]));
  assert.equal(rig.fake.rows.length, 1);
});
