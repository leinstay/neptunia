// Repeated inspections of one day (src/watcher/read.ts, brief.ts, news.ts, src/tools/impl/watcher.ts): each successful
// run keeps an immutable report, `<day>.md` is the latest successful view for the day readers, the next inspection
// reads the one before it, a failed attempt replaces nothing, and her wake hears only safe findings. The clock is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runServiceHere } from '../bin/neptunia-service.ts';
import { createDiscordInterface } from '../interfaces/discord/index.ts';
import { createOpsEnv } from '../src/tools/impl/env.ts';
import { runOpPrechecked } from '../src/tools/impl/index.ts';
import { createReportReader, readReport } from '../src/watcher/read.ts';
import * as reads from '../src/watcher/read.ts';
import { watcherNews } from '../src/watcher/news.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { tempDir } from './fixtures/tmp.ts';
import {
  DAY,
  MINUTE,
  NOW,
  answerOf,
  inspectionDeps,
  inspectionRig,
  said,
  watcherBoard,
} from './fixtures/watcher-inspection-rig.ts';
import type { InspectionRig } from './fixtures/watcher-inspection-rig.ts';

const inspection = () => import('../src/watcher/inspection.ts');
const filing = () => import('../src/watcher/filing.ts');

const REPO = fileURLToPath(new URL('..', import.meta.url));

/** One successful inspection saying `mark` under The project; the clock moves on after it. */
async function inspected(rig: InspectionRig, mark: string): Promise<string> {
  const { runInspection } = await inspection();
  const result = await runInspection(
    inspectionDeps(rig, { runAgent: () => Promise.resolve(said(answerOf({ Project: mark }))) })
  );
  rig.clock.t += MINUTE;
  assert.equal(result.state, 'succeeded');
  return result.runId;
}

test('two inspections of a day keep two immutable reports, and the day shows the newer', async () => {
  // Bug: `a day with a report does nothing` stays, or the second write overwrites the first and calibration loses it.
  const rig = inspectionRig();
  const first = await inspected(rig, 'MARK-FIRST');
  const second = await inspected(rig, 'MARK-SECOND');
  assert.deepEqual(
    reads.reportVersions(rig.reportsDir, DAY).map((one) => one.runId),
    [first, second]
  );
  const old = reads.readReportRun(rig.reportsDir, first);
  assert.ok(old.ok && old.report.text.includes('MARK-FIRST'));
  assert.equal(old.ok && old.report.text.includes('MARK-SECOND'), false);
  const day = readReport(rig.reportsDir, DAY);
  assert.ok(day.ok && day.report.text.includes('MARK-SECOND'));
  assert.equal(day.ok && day.report.runId, second);
});

test('day readers still see one day, with no version mistaken for another date', async () => {
  // Bug: suffixed files show up in reportDays or are skipped, which leaves every day reader blind.
  const rig = inspectionRig();
  await inspected(rig, 'MARK-FIRST');
  await inspected(rig, 'MARK-SECOND');
  assert.deepEqual(reads.reportDays(rig.reportsDir), [DAY]);
});

test('a daily file from before versions reads as before, with no run identity', () => {
  // Bug: the reports of an installed watcher vanish after the update.
  const rig = inspectionRig();
  fs.writeFileSync(path.join(rig.reportsDir, '2026-11-01.md'), '# old\n');
  const read = readReport(rig.reportsDir, '2026-11-01');
  assert.ok(read.ok);
  assert.equal(read.report.text, '# old\n');
  assert.equal(read.report.runId, undefined);
  assert.deepEqual(reads.reportVersions(rig.reportsDir, '2026-11-01'), []);
});

for (const [name, runId] of [
  ['unknown', 'run-71'],
  ['climbing out of the folder', '../../keys'],
] as const) {
  test(`a run identity that is ${name} is not found`, () => {
    // Bug: the identity goes into a path unchecked, and `report ../../keys` prints a file outside the reports.
    const rig = inspectionRig();
    fs.writeFileSync(path.join(rig.root, 'keys.md'), 'MARK-OUTSIDE');
    assert.deepEqual(reads.readReportRun(rig.reportsDir, runId), { ok: false, code: 'not-found' });
  });
}

test('a failed attempt replaces nothing: the day and its versions stay on the last success', async () => {
  // Bug: the view is written before validation, so a bad morning run erases the good night one.
  const { runInspection } = await inspection();
  const rig = inspectionRig();
  const good = await inspected(rig, 'MARK-GOOD');
  await runInspection(inspectionDeps(rig, { runAgent: () => Promise.resolve(said('## Her day\n\nMARK-BAD\n')) }));
  const day = readReport(rig.reportsDir, DAY);
  assert.ok(day.ok && day.report.text.includes('MARK-GOOD'));
  assert.deepEqual(
    reads.reportVersions(rig.reportsDir, DAY).map((one) => one.runId),
    [good]
  );
});

test('the next inspection reads the preceding successful report of the same day, never a failed attempt', async () => {
  // Bug: brief.ts leaves out the run day, so a second inspection cannot compare with the morning's findings.
  const { runInspection } = await inspection();
  const rig = inspectionRig();
  await inspected(rig, 'MARK-MORNING');
  await runInspection(inspectionDeps(rig, { runAgent: () => Promise.resolve(said('## Her day\n\nMARK-BAD\n')) }));
  const briefs: Array<string> = [];
  await runInspection(
    inspectionDeps(rig, {
      runAgent: (brief) => {
        briefs.push(brief);
        return Promise.resolve(said(answerOf()));
      },
    })
  );
  assert.ok(briefs[0]?.includes('MARK-MORNING'));
  assert.equal(briefs[0]?.includes('MARK-BAD'), false);
});

// ---- the readers ------------------------------------------------------------------------------------------------

/** `where` of a CLI call: the rig's persona root as the private and data folders, the checkout as the root. */
const whereOf = (rig: InspectionRig) => ({ rootDir: REPO, privateDir: rig.root, dataDir: rig.root });

test('services watcher report of a day names its run and the other runs of that day', async () => {
  // Bug: the owner sees a day's text with no way to reach the morning's report beside it.
  const rig = inspectionRig();
  const first = await inspected(rig, 'MARK-FIRST');
  const second = await inspected(rig, 'MARK-SECOND');
  const done = await runServiceHere({ name: 'services.watcher.report', args: { target: DAY } }, whereOf(rig), false);
  assert.equal(done.status, 'ok', done.text.slice(0, 200));
  assert.ok(done.text.includes('MARK-SECOND'));
  assert.ok(done.text.includes(first));
  assert.ok(done.text.includes(second));
});

test('services watcher report of a run identity shows that run, in the shell and with no core', async () => {
  // Bug: commands.ts refuses anything but a date, so `report <run>` answers "reports are kept by date".
  const rig = inspectionRig();
  const first = await inspected(rig, 'MARK-FIRST');
  await inspected(rig, 'MARK-SECOND');
  const done = await runServiceHere({ name: 'services.watcher.report', args: { target: first } }, whereOf(rig), false);
  assert.equal(done.status, 'ok', done.text.slice(0, 200));
  assert.ok(done.text.includes('MARK-FIRST'));
  assert.equal(done.text.includes('MARK-SECOND'), false);
});

function opsEnv(rig: InspectionRig) {
  return createOpsEnv({
    discord: createDiscordInterface().capabilities,
    hot: {
      config: { bot: { owners: ['42'], access: {} }, features: {} },
      prompts: { labels: {} },
      rootDir: tempDir('nep-versions-root-'),
      reloadConfig: () => true,
    },
    store: { state: { data: {}, markDirty() {} } },
    client: { channels: { cache: new Map() } },
    spontaneous: {},
    calibrator: { ratio: 1 },
    isServedCommunity: (id: unknown) => id === 'g1',
    board: null,
    watcher: createReportReader(rig.reportsDir),
  });
}

async function watcherRead(rig: InspectionRig, args: Record<string, unknown>) {
  const { result } = await withCapturedLogs(() =>
    runOpPrechecked('watcher.read', args, {
      env: opsEnv(rig),
      placeId: 'g1',
      conversationId: 'c1',
      accountId: null,
      roleIds: [],
      actor: 'persona',
    })
  );
  return result as { status: string; summary?: string; data?: { day?: string; text?: string; runId?: string } };
}

test('watcher.read answers the latest with its run identity, and an earlier run by that identity', async () => {
  // Bug: `watcher.read` follows the day view alone, so she and the owner read different versions of the same day.
  const rig = inspectionRig();
  const first = await inspected(rig, 'MARK-FIRST');
  const second = await inspected(rig, 'MARK-SECOND');
  const latest = await watcherRead(rig, {});
  assert.equal(latest.data?.runId, second);
  const earlier = await watcherRead(rig, { run: first });
  assert.equal(earlier.status, 'ok');
  assert.equal(earlier.data?.runId, first);
  assert.ok(earlier.data?.text?.includes('MARK-FIRST'));
});

// ---- what her wake hears ------------------------------------------------------------------------------------------

const SENSITIVE = 'SENSITIVE-listener-on-10.0.0.9-root-owned-backup';
const DRAFT = {
  kind: 'fix',
  finding: 'retry-rail',
  title: 'MARK-SAFE-TITLE',
  evidence: `journal of the server unit, ${SENSITIVE}`,
  done: 'One retry per turn',
};
const SECRET_BODIES = { 'The server': SENSITIVE, 'For the owner': `Rotate it: ${SENSITIVE}`, Memory: SENSITIVE };

async function reported(rig: InspectionRig, mark = 'x'): Promise<string> {
  const { runInspection } = await inspection();
  const result = await runInspection(
    inspectionDeps(rig, {
      runAgent: () => Promise.resolve(said(answerOf({ ...SECRET_BODIES, Project: mark }, [DRAFT]))),
    })
  );
  return result.runId;
}

const newsOf = (rig: InspectionRig) =>
  watcherNews({ config: { watcher: { enabled: true } }, rootDir: rig.root, now: rig.clock.t });

test('her wake hears the safe finding and its run, and no owner section or evidence', async () => {
  // Bug: news.ts copies `For the owner` into her context, with whatever server detail the report holds.
  const rig = inspectionRig();
  const runId = await reported(rig);
  const news = newsOf(rig);
  assert.equal(news?.runId, runId);
  assert.equal(news?.day, DAY);
  assert.deepEqual(
    news?.findings.map((one) => [one.title, one.state, one.taskId]),
    [['MARK-SAFE-TITLE', 'filed', rig.fake.rows[0]?.id]]
  );
  assert.equal(JSON.stringify(news).includes(SENSITIVE), false);
});

test('a report with no finding carries nothing of its owner section to her', async () => {
  // Bug: an empty findings list falls back to the owner section, which is the leak again by another door.
  const { runInspection } = await inspection();
  const rig = inspectionRig();
  await runInspection(inspectionDeps(rig, { runAgent: () => Promise.resolve(said(answerOf(SECRET_BODIES))) }));
  const news = newsOf(rig);
  assert.deepEqual(news?.findings ?? [], []);
  assert.equal(JSON.stringify(news).includes(SENSITIVE), false);
});

test('a report from before versions carries nothing of its sections to her', () => {
  // Bug: the old day file has no receipts, so news falls back to its sections on the first wake after the update.
  const rig = inspectionRig();
  fs.writeFileSync(path.join(rig.reportsDir, `${DAY}.md`), `## For the owner\n\n${SENSITIVE}\n`);
  assert.equal(JSON.stringify(newsOf(rig) ?? null).includes(SENSITIVE), false);
});

test('a repeated delivery says the same and files nothing twice', async () => {
  // Bug: every wake re-presents a finding as new, or reading the news drains the filing queue again.
  const { retryFilings } = await filing();
  const rig = inspectionRig();
  await reported(rig);
  const first = newsOf(rig);
  await retryFilings({ dir: rig.dir, board: rig.fake.board, now: rig.store.now });
  const second = newsOf(rig);
  assert.deepEqual(second, first);
  assert.equal(rig.fake.rows.length, 1);
});

test('a deferred finding reaches her as deferred with no task id, then with the id once it is filed', async () => {
  // Bug: she reads "filed" for a task that does not exist yet, and files it herself.
  const { retryFilings } = await filing();
  let down = true;
  const rig = inspectionRig(NOW, watcherBoard({ down: () => down }));
  await reported(rig);
  assert.deepEqual(
    newsOf(rig)?.findings.map((one) => [one.state, one.taskId]),
    [['deferred', null]]
  );
  down = false;
  await retryFilings({ dir: rig.dir, board: rig.fake.board, now: rig.store.now });
  assert.deepEqual(
    newsOf(rig)?.findings.map((one) => [one.state, one.taskId]),
    [['filed', rig.fake.rows[0]?.id]]
  );
});
