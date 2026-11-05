// src/watcher/news.ts: when the selfimprovement wake carries nothing of the watcher, over a report and receipts a real
// inspection left: with the report older than the past day, with the watcher off, and with its folder gone. Each test first
// shows the same report does reach her, so it fails for its own reason. What she hears is in
// tests/watcher-versions.test.ts. The clock is injected. Each test names the bug it catches.
// Changed: these cases wrote report files by hand, and a report with no receipts now gives nothing whatever else holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runInspection } from '../src/watcher/inspection.ts';
import { watcherNews } from '../src/watcher/news.ts';
import { DAY, NOW, answerOf, inspectionDeps, inspectionRig, said } from './fixtures/watcher-inspection-rig.ts';
import type { InspectionRig } from './fixtures/watcher-inspection-rig.ts';

const DRAFT = { kind: 'fix', finding: 'rail', title: 'Retry rail', evidence: 'src/a.ts:1', done: 'It holds' };
const HOUR = 60 * 60 * 1000;
const ON = { watcher: { enabled: true } };

/** A rig whose inspection at NOW filed one finding, and the proof that it reaches her at that moment. */
async function inspected(): Promise<InspectionRig> {
  const rig = inspectionRig();
  await runInspection(inspectionDeps(rig, { runAgent: () => Promise.resolve(said(answerOf({}, [DRAFT]))) }));
  const news = watcherNews({ config: ON, rootDir: rig.root, now: NOW });
  assert.equal(news?.day, DAY);
  assert.deepEqual(
    news?.findings.map((one) => one.title),
    [DRAFT.title]
  );
  return rig;
}

test("yesterday's report still reaches her, and one older than the past day does not", async () => {
  // Catches: a stale report from a watcher that stopped days ago is shown to her every day as if it were new, or a wake
  // just after midnight misses the report of the evening before.
  const rig = await inspected();
  assert.equal(watcherNews({ config: ON, rootDir: rig.root, now: NOW + 24 * HOUR })?.day, DAY);
  assert.equal(watcherNews({ config: ON, rootDir: rig.root, now: NOW + 48 * HOUR }), null);
});

test('with the watcher off its report on disk reaches her no more', async () => {
  // Catches: the block appears although the owner switched the watcher off in setup.
  const rig = await inspected();
  const config = { watcher: { enabled: false } };
  assert.equal(watcherNews({ config, rootDir: rig.root, now: NOW }), null);
});

test('a watcher folder that is gone gives nothing and throws nothing', async () => {
  // Catches: a deployment whose folder is missing throws while building the wake, and the wake loses all its facts.
  const rig = await inspected();
  fs.rmSync(rig.dir, { recursive: true });
  assert.equal(watcherNews({ config: ON, rootDir: rig.root, now: NOW }), null);
});
