// The watcher's entry (src/watcher/run.ts#runWatcher): brief, agent, check, tasks, report, in that order, with a fake
// runAgent, a fake board and a temp folder. A report that fails its check is never written and files nothing; the
// run is marked failed by a `<day>.failed` marker and a result code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runWatcher } from '../src/watcher/run.ts';
import {
  PLANTED_KEY,
  fakeAgent,
  fakeBoard,
  putReport,
  reportText,
  said,
  taskRow,
  tasksBlock,
  watcherDirs,
} from './fixtures/watcher-rig.ts';

const NOW = Date.parse('2026-11-02T00:05:00Z');
const DAY = '2026-11-02';
const DRAFT = {
  kind: 'chore',
  title: 'Remove the unread setting',
  evidence: 'config/config.json:88 has no reader',
  done: 'The key is gone and tests pass',
};

function setup(answer: string) {
  const dirs = watcherDirs();
  const agent = fakeAgent(said(answer));
  const fake = fakeBoard([], { now: () => NOW });
  const deps = { now: () => NOW, runAgent: agent.run, board: fake.board, reportsDir: dirs.reportsDir };
  return { dirs, agent, fake, deps };
}

const reportFile = (dirs: { reportsDir: string }): string => path.join(dirs.reportsDir, `${DAY}.md`);

test('a good answer is written as the report of the UTC day, and the run says ok', async () => {
  const { dirs, deps } = setup(reportText());
  const result = await runWatcher(deps);
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(reportFile(dirs), 'utf8'), reportText());
});

test('the agent is asked once, under the profile watcher, with a brief that holds the prompt file and the earlier reports', async () => {
  const { dirs, agent, deps } = setup(reportText());
  putReport(dirs, '2026-11-01', reportText({ Memory: 'MARK-YESTERDAY' }));
  await runWatcher(deps);
  assert.equal(agent.calls.length, 1);
  assert.equal(agent.calls[0]?.profile, 'watcher');
  assert.ok(agent.calls[0]?.brief.includes('PROMPT-SENTINEL'));
  assert.ok(agent.calls[0]?.brief.includes('MARK-YESTERDAY'));
});

test('tasks in the answer are filed as watcher and their ids appear under Tasks filed in the written report', async () => {
  const { dirs, fake, deps } = setup(reportText() + tasksBlock([DRAFT]));
  const result = await runWatcher(deps);
  assert.equal(result.ok, true);
  assert.equal(fake.added().length, 1);
  assert.equal(fake.added()[0]?.principal, 'watcher');
  const written = fs.readFileSync(reportFile(dirs), 'utf8');
  assert.ok(written.includes(fake.tasks[0]?.id ?? 'missing'));
  assert.equal(written.includes('```tasks'), false, 'the tasks block is not part of the report');
});

test('a report with a heading missing is refused: no file, no task, the run is failed with a marker', async () => {
  const { dirs, fake, deps } = setup(reportText().replace('## Memory\n\nnothing found\n\n', '') + tasksBlock([DRAFT]));
  const result = await runWatcher(deps);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'missing-heading');
  assert.equal(fs.existsSync(reportFile(dirs)), false);
  assert.equal(fake.added().length, 0);
  assert.ok(fs.readFileSync(path.join(dirs.reportsDir, `${DAY}.failed`), 'utf8').includes('missing-heading'));
});

test('a key planted in the answer refuses the report and is copied nowhere: not the file, the marker or the result', async () => {
  const { dirs, fake, deps } = setup(
    reportText({ 'The server': `journal line: ${PLANTED_KEY}` }) + tasksBlock([{ ...DRAFT, evidence: PLANTED_KEY }])
  );
  const result = await runWatcher(deps);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'secret');
  assert.equal(fake.added().length, 0, 'a task carrying the key is not filed either');
  const everything = [
    JSON.stringify(result),
    ...fs.readdirSync(dirs.reportsDir).map((name) => fs.readFileSync(path.join(dirs.reportsDir, name), 'utf8')),
  ].join('\n');
  assert.equal(everything.includes(PLANTED_KEY), false);
});

test('a bad tasks block fails the run and files nothing', async () => {
  const { dirs, fake, deps } = setup(reportText() + tasksBlock([{ ...DRAFT, kind: 'feature' }]));
  const result = await runWatcher(deps);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'bad-tasks');
  assert.equal(fake.added().length, 0);
  assert.equal(fs.existsSync(reportFile(dirs)), false);
});

test('an agent that fails is a failed run with no report, whatever text it left', async () => {
  const dirs = watcherDirs();
  const agent = fakeAgent({ ok: false, text: reportText(), exitCode: 1 });
  const result = await runWatcher({
    now: () => NOW,
    runAgent: agent.run,
    board: fakeBoard().board,
    reportsDir: dirs.reportsDir,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'agent-failed');
  assert.equal(fs.existsSync(reportFile(dirs)), false);
  assert.ok(fs.existsSync(path.join(dirs.reportsDir, `${DAY}.failed`)));
});

test('a run whose report for the day exists asks no agent and files nothing, so a second start does not file twice', async () => {
  const { dirs, agent, fake, deps } = setup(reportText() + tasksBlock([DRAFT]));
  putReport(dirs, DAY, reportText({ Memory: 'FIRST-RUN' }));
  const result = await runWatcher(deps);
  assert.equal(result.ok, true);
  assert.equal(agent.calls.length, 0);
  assert.equal(fake.added().length, 0);
  assert.ok(fs.readFileSync(reportFile(dirs), 'utf8').includes('FIRST-RUN'));
});

test('a failed marker from an earlier try does not stop the next run, and a good run removes it', async () => {
  const { dirs, deps } = setup(reportText());
  fs.writeFileSync(path.join(dirs.reportsDir, `${DAY}.failed`), 'secret');
  const result = await runWatcher(deps);
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(dirs.reportsDir, `${DAY}.failed`)), false);
});

test('a board that refuses the filing fails the run but keeps the report, because its findings are still worth reading', async () => {
  const dirs = watcherDirs();
  const agent = fakeAgent(said(reportText() + tasksBlock([DRAFT])));
  const fake = fakeBoard([], { failAdd: new Error('watcher may only read the board') });
  const result = await runWatcher({
    now: () => NOW,
    runAgent: agent.run,
    board: fake.board,
    reportsDir: dirs.reportsDir,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'board-failed');
  assert.ok(fs.existsSync(reportFile(dirs)));
});

test('a task filed yesterday for the same evidence is not filed again by the next run', async () => {
  const dirs = watcherDirs();
  const agent = fakeAgent(said(reportText() + tasksBlock([DRAFT])));
  const yesterday = taskRow({
    id: 'T-prev01',
    created_at: '2026-11-01T00:04:00.000Z',
    metadata: { kind: 'chore', evidence: DRAFT.evidence },
  });
  const fake = fakeBoard([yesterday]);
  const result = await runWatcher({
    now: () => NOW,
    runAgent: agent.run,
    board: fake.board,
    reportsDir: dirs.reportsDir,
  });
  assert.equal(result.ok, true);
  assert.equal(fake.added().length, 0);
});

test('a missing prompt file is a failed run before the agent is asked', async () => {
  const dirs = watcherDirs();
  fs.rmSync(path.join(dirs.watcherDir, 'prompt.md'));
  const agent = fakeAgent(said(reportText()));
  const result = await runWatcher({
    now: () => NOW,
    runAgent: agent.run,
    board: fakeBoard().board,
    reportsDir: dirs.reportsDir,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'no-prompt');
  assert.equal(agent.calls.length, 0);
});

test('the day is the UTC day of now, even on a server whose local day is already the next one', async (t) => {
  const before = process.env.TZ;
  process.env.TZ = 'Pacific/Kiritimati';
  t.after(() => {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  });
  const dirs = watcherDirs();
  const late = Date.parse('2026-11-02T23:59:00Z');
  const agent = fakeAgent(said(reportText()));
  await runWatcher({ now: () => late, runAgent: agent.run, board: fakeBoard().board, reportsDir: dirs.reportsDir });
  assert.ok(fs.existsSync(path.join(dirs.reportsDir, '2026-11-02.md')));
});
