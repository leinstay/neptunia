// The rework after the watcher's first real report: `For the owner` opens with `### Decisions needed`, the metadata counts what this
// report still holds open, `Misunderstandings` cites its turns, and the evidence
// page brings the diary's mirrors, selfreflection and the CI of `main`. Synthetic reports and rows, the board and the
// commands are fakes, the clock is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.ts';
import { localConfigPath } from '../src/config/files.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { serviceFamily } from '../src/service/commands.ts';
import { runInspection } from '../src/watcher/inspection.ts';
import { readReport } from '../src/watcher/read.ts';
import * as reports from '../src/watcher/report.ts';
import {
  DAY,
  METADATA,
  MINUTE,
  inspectionDeps,
  inspectionRig,
  said,
  sectionOf,
  templateOf,
} from './fixtures/watcher-inspection-rig.ts';
import type { InspectionRig } from './fixtures/watcher-inspection-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.parse('2026-11-05T12:00:00Z');
const iso = (at: number): string => new Date(at).toISOString();

const codeOf = (text: string): string => {
  const checked = reports.checkTemplate(text);
  return checked.ok ? 'passed' : checked.code;
};

const FINDING = 'the session failed with http_500 in src/memory/db/session.ts:88';
const answerSaying = (line: string): string => templateOf({ bodies: { Errors: { 'Observed defects': line } } });

async function saying(rig: InspectionRig, text: string, overrides = {}) {
  const result = await runInspection(
    inspectionDeps(rig, { runAgent: () => Promise.resolve(said(text)), ...overrides })
  );
  rig.clock.t += MINUTE;
  return result;
}

function saved(rig: InspectionRig) {
  const read = readReport(rig.reportsDir, DAY);
  assert.ok(read.ok, 'a report was saved');
  const checked = reports.checkTemplate(read.report.text);
  assert.ok(checked.ok, checked.ok ? '' : checked.code);
  return { text: read.report.text, metadata: checked.metadata };
}

const OWNER = '### Decisions needed\n\nnone\n\n';

for (const [name, change, code] of [
  ['with no Decisions needed', (text: string) => text.replace(OWNER, ''), 'missing-heading'],
  [
    'with Decisions needed after another subheading',
    (text: string) => {
      const [head = '', tail = ''] = text.split('## For the owner\n\n');
      const moved = tail.replace(OWNER, '').replace('### Suspicious evidence', `${OWNER}### Suspicious evidence`);
      return `${head}## For the owner\n\n${moved}`;
    },
    'heading-order',
  ],
  [
    'with Decisions needed in another section',
    (text: string) => text.replace('## Memory\n\n', `## Memory\n\n${OWNER}`),
    'extra-heading',
  ],
] as const) {
  test(`a report ${name} is refused as ${code}`, () => {
    // Bug: what the owner must decide sits anywhere or nowhere, and he reads a whole report to find it.
    assert.equal(codeOf(change(templateOf())), code);
  });
}

const decisions = (line: string): string => templateOf({ bodies: { 'For the owner': { 'Decisions needed': line } } });

test('a decision line with its level and key passes, and so does the one empty word', () => {
  // Bug: the check refuses the form the prompt asks for, and every report with a decision fails.
  assert.equal(codeOf(decisions('- [high] local-prompt: delete data/agents/watcher/prompt.md')), 'passed');
  assert.equal(codeOf(decisions('none')), 'passed');
});

for (const [name, line] of [
  ['no level', '- local-prompt: delete the file'],
  ['the level none', '- [none] local-prompt: delete the file'],
  ['no key', '- [high] delete the file'],
  ['a plain sentence', 'Delete the file.'],
] as const) {
  test(`a decision line with ${name} is refused as bad-risk`, () => {
    // Bug: a decision with no level or key cannot be sorted or found again the next day.
    assert.equal(codeOf(decisions(line)), 'bad-risk');
  });
}

test('a decision is no finding: it counts for nothing and keeps its line', async () => {
  // Bug: the owner's list feeds the repeat rule, so a decision he has not taken yet reads "low, repeat 5".
  const rig = inspectionRig();
  const text = decisions(`- [high] rail: ${FINDING}`);
  await saying(rig, text);
  await saying(rig, text);
  const { text: report, metadata } = saved(rig);
  assert.ok(report.includes(`- [high] rail: ${FINDING}\n`));
  assert.equal(metadata.newFindings, 0);
  assert.equal(metadata.repeats, 0);
  assert.deepEqual(metadata.open, { critical: 0, high: 0, medium: 0, low: 0 });
});

// ---- 3. open findings ---------------------------------------------------------------------------------------------------

const withRow = (label: string, value: string): Array<readonly [string, string]> =>
  METADATA.map((row) => (row[0] === label ? ([label, value] as const) : row));

test('the template reads the open counts in fixed names', () => {
  // Bug: a caller scrapes the row again, or a level is left out of the answer.
  const checked = reports.checkTemplate(
    templateOf({ metadata: withRow('Open findings', 'critical 1, high 2, medium 3, low 4') })
  );
  assert.ok(checked.ok);
  assert.deepEqual(checked.metadata.open, { critical: 1, high: 2, medium: 3, low: 4 });
});

for (const [name, value] of [
  ['levels in another order', 'high 2, critical 1, medium 3, low 4'],
  ['a level missing', 'critical 1, high 2, medium 3'],
  ['a count that is no number', 'critical some, high 2, medium 3, low 4'],
  ['the word none', 'none'],
] as const) {
  test(`an Open findings row with ${name} is refused as bad-metadata`, () => {
    // Bug: the top line of the report drifts into free text, and a month of reports cannot be compared.
    assert.equal(codeOf(templateOf()), 'passed');
    assert.equal(codeOf(templateOf({ metadata: withRow('Open findings', value) })), 'bad-metadata');
  });
}

test('a repeat counts open at the level it came in at, and Risk stays with the new findings', async () => {
  // Bug: a repeat counts at the low the code gave it and hides a high defect, or keeps the header loud every day.
  const rig = inspectionRig();
  await saying(rig, answerSaying(`- [high] rail: ${FINDING}`));
  await saying(rig, answerSaying(`- [critical] rail: ${FINDING}`));
  const { metadata } = saved(rig);
  assert.deepEqual(metadata.open, { critical: 0, high: 1, medium: 0, low: 0 });
  assert.equal(metadata.risk, 'none');
  assert.equal(metadata.newFindings, 0);
  assert.equal(metadata.repeats, 1);
});

test('a repeat keeps its level through later runs, where the saved line already says low', async () => {
  // Bug: the level is read from the last saved line, so the third run counts the high defect as low.
  const rig = inspectionRig();
  for (let run = 0; run < 3; run += 1) await saying(rig, answerSaying(`- [high] rail: ${FINDING}`));
  assert.deepEqual(saved(rig).metadata.open, { critical: 0, high: 1, medium: 0, low: 0 });
});

test('a finding the latest report omits is closed', async () => {
  // Bug: the count can only grow, so a month of reports says more is open each day whatever happened.
  const rig = inspectionRig();
  await saying(rig, answerSaying(`- [high] rail: ${FINDING}`));
  await saying(rig, templateOf());
  const { metadata } = saved(rig);
  assert.deepEqual(metadata.open, { critical: 0, high: 0, medium: 0, low: 0 });
  assert.equal(metadata.risk, 'none');
});

test('new and repeated findings count together, and Risk reads the new one alone', async () => {
  // Bug: the two numbers are drawn from one list, and either the old high lifts the header or leaves the count.
  const rig = inspectionRig();
  await saying(rig, answerSaying(`- [high] rail: ${FINDING}`));
  const both = `- [high] rail: ${FINDING}\n- [medium] drift: the build failed in src/b.ts:2`;
  await saying(rig, answerSaying(both));
  const { metadata } = saved(rig);
  assert.deepEqual(metadata.open, { critical: 0, high: 1, medium: 1, low: 0 });
  assert.equal(metadata.risk, 'medium');
  assert.equal(metadata.newFindings, 1);
  assert.equal(metadata.repeats, 1);
});

test('changed evidence under one key counts once, at the level of the change', async () => {
  // Bug: every new fingerprint adds a finding, and one bug that moved reads as five.
  const rig = inspectionRig();
  await saying(rig, answerSaying(`- [low] rail: ${FINDING}`));
  await saying(rig, answerSaying(`- [high] rail: ${FINDING.replace('http_500', 'http_503')}`));
  const { metadata } = saved(rig);
  assert.deepEqual(metadata.open, { critical: 0, high: 1, medium: 0, low: 0 });
  assert.equal(metadata.newFindings, 1);
  assert.equal(metadata.risk, 'high');
});

test('the same evidence under a new key is one repeat at the level it came in at', async () => {
  // Bug: a rename adds a second open finding for one defect, or loses the level the first name carried.
  const rig = inspectionRig();
  await saying(rig, answerSaying(`- [high] rail: ${FINDING}`));
  await saying(rig, answerSaying(`- [medium] another-name: ${FINDING}`));
  assert.deepEqual(saved(rig).metadata.open, { critical: 0, high: 1, medium: 0, low: 0 });
});

test('a failed attempt adds nothing open', async () => {
  // Bug: a refused report's findings count, though the owner can never read them.
  const rig = inspectionRig();
  await saying(rig, templateOf());
  const refused = await saying(rig, `${answerSaying(`- [high] rail: ${FINDING}`)}\nMore.\n`);
  assert.equal(refused.state, 'failed');
  await saying(rig, templateOf());
  const { metadata } = saved(rig);
  assert.deepEqual(metadata.open, { critical: 0, high: 0, medium: 0, low: 0 });
  assert.equal(metadata.risk, 'none');
});

test('the engine stamps the open counts and the risk over what the agent wrote', async () => {
  // Bug: the model's own tally stands, and it says what it remembers.
  const rig = inspectionRig();
  await saying(rig, templateOf({ metadata: withRow('Open findings', 'critical 9, high 9, medium 9, low 9') }));
  assert.deepEqual(saved(rig).metadata.open, { critical: 0, high: 0, medium: 0, low: 0 });
});

// ---- 4. Misunderstandings cite turns ---------------------------------------------------------------------------------------

const understood = (sub: string, line: string): string =>
  templateOf({ bodies: { Misunderstandings: { [sub]: line } } });

for (const sub of ['Observed defects', 'Suspicious evidence']) {
  test(`a line under ${sub} of Misunderstandings with no turn id is refused as missing-turn-ref`, () => {
    // Bug: a finding about her words cites nothing the owner can open, and invites a retelling of the chat.
    assert.equal(codeOf(understood(sub, '- [medium] joke-missed: she took a joke literally')), 'missing-turn-ref');
    assert.equal(codeOf(understood(sub, '- [medium] joke-missed: she took a joke literally in t-b344f36f')), 'passed');
  });
}

test('a line under Inspected without a finding of Misunderstandings needs its turn too', () => {
  // Bug: the retelling moves one subsection down, where the first real report had it.
  const sub = 'Inspected without a finding';
  assert.equal(codeOf(understood(sub, '- She took a joke literally and was corrected.')), 'missing-turn-ref');
  assert.equal(codeOf(understood(sub, '- One correction, settled in t-1b1931d4.')), 'passed');
  assert.equal(codeOf(understood(sub, 'none')), 'passed');
});

test('an unavailable check in Misunderstandings names no turn, and another section needs none', () => {
  // Bug: "the chat could not be read" is refused for citing no turn, and the report fails for being honest.
  assert.equal(codeOf(understood('Unavailable checks', '- The journal is closed to this account.')), 'passed');
  const elsewhere = templateOf({ bodies: { 'Her day': { 'Inspected without a finding': '- A quiet day.' } } });
  assert.equal(codeOf(elsewhere), 'passed');
});

test('a word that only looks like a turn id does not pass', () => {
  // Bug: a loose match lets `t-shirt` through, and the line cites nothing.
  assert.equal(
    codeOf(understood('Observed defects', '- [low] joke-missed: she answered about a t-shirt')),
    'missing-turn-ref'
  );
});

test('an inspection whose Misunderstandings cite no turn fails and keeps the last view', async () => {
  // Bug: the check exists and the run does not call it.
  const rig = inspectionRig();
  await saying(rig, templateOf({ bodies: { Memory: 'MARK-GOOD' } }));
  const refused = await saying(
    rig,
    understood('Observed defects', '- [medium] joke-missed: she took a joke literally')
  );
  assert.equal(refused.state, 'failed');
  assert.equal(refused.code, 'missing-turn-ref');
  assert.ok(saved(rig).text.includes('MARK-GOOD'));
});

// ---- the prompt holds each rule ----------------------------------------------------------------------------------------

const PROMPT = fs.readFileSync(path.join(REPO, 'agents', 'watcher', 'prompt.md'), 'utf8');
const promptOf = (heading: string): string => sectionOf(PROMPT, heading);

test('the prompt gives the decisions block', () => {
  // Bug: the agent leaves the owner's decisions in prose.
  // Changed: the watcher files no task (owner, 2026-11-09), so the filing threshold left the prompt and this test.
  assert.ok(PROMPT.includes('### Decisions needed'));
  assert.ok(promptOf('For the owner').includes('Decisions needed'));
});

// ---- 4 and 5. the evidence page ------------------------------------------------------------------------------------------

function evidenceRig(options: { db?: boolean } = {}) {
  const data = tempDir('nep-rework-');
  fs.mkdirSync(path.dirname(localConfigPath(data)), { recursive: true });
  fs.writeFileSync(localConfigPath(data), '{}');
  fs.mkdirSync(path.join(data, 'agents', 'watcher', 'reports'), { recursive: true });
  if (options.db !== false) openMemoryDb(path.join(data, 'memory.db')).close();
  return data;
}

async function evidenceOf(data: string) {
  const answer = await serviceFamily(
    {
      rootDir: REPO,
      privateDir: data,
      dataDir: data,
      config: () => readConfig(REPO, { privateDir: data }),
      now: () => NOW,
      env: { NEPTUNIA_UNIT_SCOPE: 'user', XDG_CONFIG_HOME: data },
      coreUp: false,
      run: () => Promise.resolve({ code: 1, stdout: '', stderr: 'unavailable here' }),
    },
    'service.watcher.evidence',
    {}
  );
  assert.equal(answer.status, 'ok', answer.text.slice(0, 200));
  return {
    text: answer.text,
    page: JSON.parse(answer.text) as {
      gaps: Array<{ kind: string }>;
      selfreflection: Record<string, unknown> | null;
      mirrors: Array<Record<string, unknown>> | null;
    },
  };
}

const ENTRY_TEXT = 'ENTRY-WORDS-OF-THE-DIARY';
const GIST_TEXT = 'GIST-WORDS-OF-THE-DIARY';
const RENDERED = 'RENDERED-WORDS-OF-THE-POST';
const PLACE_NAME = 'place:diary';

/** A diary with two entries and one mirror, with a publication in each state the facts count. */
function selfreflectionScene(data: string): void {
  const handle = openMemoryDb(path.join(data, 'memory.db'));
  const db = dbOf(handle);
  db.prepare("INSERT INTO places (id, iface, kind, native_id) VALUES (?, 'discord', 'channel', 'c1')").run(PLACE_NAME);
  db.prepare(
    `INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by, backfill_enabled, backfill_high_water, backfill_next_due_at)
     VALUES ('mirror:1', 'selfreflection', ?, 1, ?, 'owner', 1, 'entry-1', ?)`
  ).run(PLACE_NAME, iso(NOW - 86_400_000), NOW + 60_000);
  const entry = db.prepare(
    "INSERT INTO selfreflection (id, at_ms, kind, gist, text, status) VALUES (?, ?, 'entry', ?, ?, 'written')"
  );
  entry.run('entry-1', NOW - 7_200_000, GIST_TEXT, ENTRY_TEXT);
  entry.run('entry-2', NOW - 3_600_000, GIST_TEXT, ENTRY_TEXT);
  const publication = db.prepare(
    `INSERT INTO publications (id, row_kind, row_id, content_hash, rendered, destination_place_id, status, idempotency_key, created_at, sent_at)
     VALUES (?, 'selfreflection', ?, 'hash', ?, ?, ?, ?, ?, ?)`
  );
  const rows: ReadonlyArray<readonly [string, string, string | null]> = [
    ['p-sent', 'sent', iso(NOW - 3_000_000)],
    ['p-queued', 'queued', null],
    ['p-failed', 'failed', null],
    ['p-unknown', 'unknown', null],
    ['p-incomplete', 'incomplete', null],
  ];
  for (const [id, status, sent] of rows) {
    publication.run(id, 'entry-2', RENDERED, PLACE_NAME, status, `key-${id}`, iso(NOW - 3_600_000), sent);
  }
  handle.close();
}

test('the evidence gives each mirror its last entry, counts and backfill, and no words', async () => {
  // Bug: the report cannot say whether the diary reaches its channel, or says it by quoting her diary.
  const data = evidenceRig();
  selfreflectionScene(data);
  const { page, text } = await evidenceOf(data);
  const [mirror] = page.mirrors ?? [];
  assert.equal(mirror?.place, PLACE_NAME);
  assert.equal(mirror?.enabled, true);
  assert.equal(mirror?.lastSentAt, iso(NOW - 3_000_000));
  assert.equal(mirror?.queued, 1);
  assert.equal(mirror?.failed, 1);
  assert.equal(mirror?.uncertain, 2);
  assert.deepEqual(mirror?.backfill, {
    enabled: true,
    highWater: 'entry-1',
    nextDueAt: iso(NOW + 60_000),
    completedAt: null,
  });
  for (const words of [ENTRY_TEXT, GIST_TEXT, RENDERED]) assert.equal(text.includes(words), false, words);
});

test('the evidence gives selfreflection its last entry and the totals, and no words', async () => {
  // Bug: the facts come per mirror only, and a diary with no mirror looks as if it never wrote.
  const data = evidenceRig();
  selfreflectionScene(data);
  const { page } = await evidenceOf(data);
  assert.deepEqual(page.selfreflection, {
    lastEntryId: 'entry-2',
    lastEntryAt: iso(NOW - 3_600_000),
    queued: 1,
    failed: 1,
    uncertain: 2,
  });
});

test('a diary with no entry and no mirror says so plainly', async () => {
  // Bug: empty reads as a failure, or the fields go missing and the agent invents them.
  const { page } = await evidenceOf(evidenceRig());
  assert.deepEqual(page.mirrors, []);
  assert.deepEqual(page.selfreflection, {
    lastEntryId: null,
    lastEntryAt: null,
    queued: 0,
    failed: 0,
    uncertain: 0,
  });
});

test('with no database the facts are null beside the named gap, never zero', async () => {
  // Bug: a missing database reads as "nothing queued, nothing failed", the healthiest possible answer.
  const { page } = await evidenceOf(evidenceRig({ db: false }));
  assert.equal(page.mirrors, null);
  assert.equal(page.selfreflection, null);
  assert.ok(page.gaps.some((gap) => gap.kind === 'memory-unavailable'));
});

// The CI of `main` is no part of the evidence page since stage AA: development mode reads it (tests/watcher-ci*.test.ts).
