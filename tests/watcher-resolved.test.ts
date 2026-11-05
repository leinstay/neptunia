// A finding is resolved when its filing receipt's task is `done` with a merged pull request (src/watcher/filing.ts). An
// inspection reads that from its receipts and the board, and the same finding seen afterwards is new. With no board there is
// no resolved list that run, and a repeat stays a repeat. Synthetic reports over the fake board; the clock is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readReport } from '../src/watcher/read.ts';
import { checkTemplate } from '../src/watcher/report.ts';
import {
  DAY,
  MINUTE,
  inspectionDeps,
  inspectionRig,
  said,
  templateOf,
  watcherBoard,
} from './fixtures/watcher-inspection-rig.ts';
import type { InspectionRig } from './fixtures/watcher-inspection-rig.ts';
import { tasksBlock } from './fixtures/watcher-rig.ts';

const inspection = () => import('../src/watcher/inspection.ts');

const FINDING = 'the session failed with http_500 in src/memory/db/session.ts:88';
const LINE = `- [high] rail: ${FINDING}`;
const DRAFT = { kind: 'fix', finding: 'rail', title: 'Retry rail', evidence: 'src/a.ts:1', done: 'It holds' };
const answer = (drafts: ReadonlyArray<Record<string, unknown>> = []): string =>
  templateOf({ bodies: { Errors: { 'Observed defects': LINE } } }) + (drafts.length === 0 ? '' : tasksBlock(drafts));

async function saying(rig: InspectionRig, text: string, overrides = {}) {
  const { runInspection } = await inspection();
  const result = await runInspection(
    inspectionDeps(rig, { runAgent: () => Promise.resolve(said(text)), ...overrides })
  );
  rig.clock.t += MINUTE;
  assert.equal(result.state, 'succeeded', result.code ?? '');
  return result;
}

function saved(rig: InspectionRig) {
  const read = readReport(rig.reportsDir, DAY);
  assert.ok(read.ok);
  const checked = checkTemplate(read.report.text);
  assert.ok(checked.ok);
  return { text: read.report.text, metadata: checked.metadata };
}

/** The filed task moves on the board at this moment of the clock. */
function closeTask(rig: InspectionRig, fields: Record<string, unknown>): void {
  const row = rig.fake.rows[0] ?? assert.fail('no task was filed');
  Object.assign(row, { updated_at: new Date(rig.clock.t).toISOString(), ...fields });
  rig.clock.t += MINUTE;
}

const MERGED = { status: 'done', metadata: { merged: { pr: 7 } } };

test('a finding seen again after its task was done with a merged pull request is new, at the level the model gave', async () => {
  // Bug: a fix that did not hold is lowered as an old repeat, exactly when it matters.
  const rig = inspectionRig();
  await saying(rig, answer([DRAFT]));
  closeTask(rig, MERGED);
  await saying(rig, answer());
  const { text, metadata } = saved(rig);
  assert.ok(text.includes(`${LINE}\n`), text.slice(0, 900));
  assert.equal(metadata.risk, 'high');
  assert.equal(metadata.newFindings, 1);
  assert.equal(metadata.repeats, 0);
});

test('after the resolution the count starts over from the sighting that came back', async () => {
  // Bug: the resolution applies once and the old count returns on the next run, or it clears the new sightings too.
  const rig = inspectionRig();
  await saying(rig, answer([DRAFT]));
  closeTask(rig, MERGED);
  await saying(rig, answer());
  await saying(rig, answer());
  assert.ok(saved(rig).text.includes(`- [low] rail: ${FINDING} (repeat 2, first ${DAY})\n`));
});

for (const [name, fields] of [
  ['done with no merged pull request', { status: 'done', metadata: {} }],
  ['failed', { status: 'failed', metadata: { merged: { pr: 7 } } }],
  ['still open', { status: 'in_progress', metadata: {} }],
] as const) {
  test(`a task ${name} resolves nothing, and the finding stays a repeat`, async () => {
    // Bug: any closed task reads as a fix, and a finding nobody fixed comes back at its full level every day.
    const rig = inspectionRig();
    await saying(rig, answer([DRAFT]));
    closeTask(rig, fields);
    await saying(rig, answer());
    assert.ok(saved(rig).text.includes(`- [low] rail: ${FINDING} (repeat 2, first ${DAY})\n`));
  });
}

test('a resolution older than the sighting clears only what came before it', async () => {
  // Bug: "resolved" is a flag on the key, so the first repeat after the fix is new for ever.
  const rig = inspectionRig();
  await saying(rig, answer([DRAFT]));
  closeTask(rig, MERGED);
  await saying(rig, answer());
  await saying(rig, answer());
  await saying(rig, answer());
  assert.ok(saved(rig).text.includes('(repeat 3, first'));
});

test('a board that cannot be reached leaves no resolved list, the repeat stays a repeat and the run succeeds', async () => {
  // Bug: the read of the resolved list fails the run on the day the board is down, or drops the history with it.
  let down = false;
  const rig = inspectionRig(undefined, watcherBoard({ down: () => down }));
  await saying(rig, answer([DRAFT]));
  closeTask(rig, MERGED);
  down = true;
  await saying(rig, answer());
  assert.ok(saved(rig).text.includes(`- [low] rail: ${FINDING} (repeat 2, first ${DAY})\n`));
});

// Changed: the open counts need the resolved list whenever a filed finding may have closed, so only a run with no filed
// finding keeps the board shut.
test('a run with no filed finding never opens the board for the resolved list', async () => {
  // Bug: every run opens a link to the core to read something no finding of this report can use.
  const rig = inspectionRig();
  await saying(rig, answer());
  let opened = 0;
  await saying(rig, templateOf(), {
    openBoard: () => {
      opened += 1;
      return Promise.resolve(rig.fake.board);
    },
  });
  assert.equal(opened, 0);
});
