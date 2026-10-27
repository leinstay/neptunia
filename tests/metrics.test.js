import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createMetrics, metricsTap, SPEED_METRICS } from '../src/tools/impl/metrics.ts';
import { log, onLog } from '../src/log.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { tempDir } from './fixtures/tmp.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function tmpDir() {
  return tempDir('nep-metrics-');
}

/** A clock the test moves by hand. */
function clock(start = Date.parse('2026-10-14T12:00:00.000Z')) {
  const state = { at: start };
  const now = () => state.at;
  now.advance = (ms) => {
    state.at += ms;
  };
  return now;
}

test('metrics: summary gives the count, the median and the mean of the samples', () => {
  const metrics = createMetrics({ dataDir: tmpDir(), now: clock() });
  for (const ms of [100, 300, 200, 1000]) metrics.record('reply', ms);
  assert.deepEqual(metrics.summary('reply', 24), { n: 4, median: 250, mean: 400 });
  metrics.record('reply', 50);
  assert.deepEqual(metrics.summary('reply', 24), { n: 5, median: 200, mean: 330 });
  assert.deepEqual(metrics.summary('planner', 24), { n: 0, median: null, mean: null }, 'a metric with no sample');
});

test('metrics: a sample that is no duration is refused', () => {
  const metrics = createMetrics({ dataDir: tmpDir(), now: clock() });
  for (const bad of [Number.NaN, -1, Infinity, '12', null]) assert.equal(metrics.record('reply', bad), false);
  assert.equal(metrics.record('', 5), false);
  assert.equal(metrics.summary('reply', 24).n, 0);
});

test('metrics: only the samples inside the window count, and nothing older than 24 h is kept', () => {
  const now = clock();
  const metrics = createMetrics({ dataDir: tmpDir(), now });
  metrics.record('reply', 1000);
  now.advance(2 * HOUR);
  metrics.record('reply', 10);
  assert.deepEqual(metrics.summary('reply', 1), { n: 1, median: 10, mean: 10 }, 'the last hour');
  assert.equal(metrics.summary('reply', 24).n, 2);
  now.advance(23 * HOUR);
  assert.deepEqual(metrics.summary('reply', 24), { n: 1, median: 10, mean: 10 }, 'the first sample is past 24 h');
  assert.equal(metrics.summary('reply', 48).n, 1, 'a wider window still never reaches past 24 h');
});

test('metrics: a metric keeps at most 2000 samples, the oldest dropped', () => {
  const metrics = createMetrics({ dataDir: tmpDir(), now: clock() });
  for (let i = 0; i < 2000; i += 1) metrics.record('analyzer batch', 1);
  for (let i = 0; i < 2000; i += 1) metrics.record('analyzer batch', 9);
  assert.deepEqual(metrics.summary('analyzer batch', 24), { n: 2000, median: 9, mean: 9 });
});

test('metrics: saved at most once a minute (write-temp + rename), forced on shutdown, loaded at start', async () => {
  const dataDir = tmpDir();
  const now = clock();
  const metrics = createMetrics({ dataDir, now });
  const file = path.join(dataDir, 'metrics.json');
  assert.equal(await metrics.save(), false, 'nothing recorded: nothing written');
  assert.equal(fs.existsSync(file), false);

  metrics.record('reply', 400);
  assert.equal(await metrics.save(), true);
  assert.ok(fs.existsSync(file));
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'the temp file was renamed');

  metrics.record('reply', 600);
  now.advance(30_000);
  assert.equal(await metrics.save(), false, 'less than a minute since the last write');
  assert.equal(await metrics.save({ force: true }), true, 'the shutdown write');
  now.advance(MINUTE);
  assert.equal(await metrics.save(), false, 'nothing new since');

  const loaded = createMetrics({ dataDir, now });
  assert.deepEqual(loaded.summary('reply', 24), { n: 2, median: 500, mean: 500 });

  now.advance(25 * HOUR);
  assert.equal(createMetrics({ dataDir, now }).summary('reply', 24).n, 0, 'samples past 24 h are dropped on load');
});

test('metrics: a missing or broken file starts empty', () => {
  const dataDir = tmpDir();
  assert.equal(createMetrics({ dataDir, now: clock() }).summary('reply', 24).n, 0);
  fs.writeFileSync(path.join(dataDir, 'metrics.json'), '{not json');
  assert.equal(createMetrics({ dataDir, now: clock() }).summary('reply', 24).n, 0);
  fs.writeFileSync(
    path.join(dataDir, 'metrics.json'),
    JSON.stringify({ v: 1, samples: { reply: [[1, 'x'], 'junk'] } })
  );
  assert.equal(createMetrics({ dataDir, now: clock() }).summary('reply', 24).n, 0);
});

test('log: a listener gets each entry after it is written; a throwing listener is ignored', async () => {
  const seen = [];
  const offThrow = onLog(() => {
    throw new Error('listener failure');
  });
  const off = onLog((entry) => seen.push(entry));
  try {
    const { logs } = await withCapturedLogs(() => log.info('test: tapped', { ms: 12 }));
    assert.equal(logs.length, 1, 'the line was written');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].msg, 'test: tapped');
    assert.equal(seen[0].ms, 12);
    assert.equal(seen[0].level, 'info');
  } finally {
    off();
    offThrow();
  }
  await withCapturedLogs(() => log.info('test: after'));
  assert.equal(seen.length, 1, 'an unsubscribed listener hears nothing');
});

/** Log entries as src/log.js builds them, at `atMs`. */
function entry(msg, fields, atMs) {
  return { level: 'info', time: new Date(atMs).toISOString(), msg, ...fields };
}

test('metricsTap: the log events feed the speed metrics', () => {
  const now = clock();
  const metrics = createMetrics({ dataDir: tmpDir(), now });
  const tap = metricsTap(metrics);
  const t0 = now();

  // A turn with a recall: the search during the turn, the timings, two messages sent.
  tap(
    entry(
      'recall: searched',
      { channel: 'c1', ms: 900, meaningMs: 120, discordMs: 500, recordMs: 30, memoryMs: 15 },
      t0 + 1000
    )
  );
  tap(entry('recall: summary', { channel: 'c1', ms: 2000, totalMs: 2900, answer: 'text' }, t0 + 3000));
  tap(entry('turn: timings', { channel: 'c1', totalMs: 6000, stages: {} }, t0 + 6000));
  tap(entry('turn: sent', { channel: 'c1', secondsSinceTrigger: 8.5 }, t0 + 8500));
  tap(entry('turn: sent', { channel: 'c1', secondsSinceTrigger: 11 }, t0 + 11000));
  // A turn without one on another channel.
  tap(entry('turn: timings', { channel: 'c2', totalMs: 2000, stages: {} }, t0 + 20000));
  tap(entry('turn: sent', { channel: 'c2', secondsSinceTrigger: 3.2 }, t0 + 21000));
  // A recall run of an earlier turn on c2 does not mark the next turn there.
  tap(
    entry(
      'recall: searched',
      { channel: 'c2', ms: 100, meaningMs: 0, discordMs: 0, recordMs: 0, memoryMs: 0 },
      t0 + 30000
    )
  );
  tap(entry('turn: timings', { channel: 'c2', totalMs: 1000, stages: {} }, t0 + 40000));
  tap(entry('turn: sent', { channel: 'c2', secondsSinceTrigger: 1 }, t0 + 41000));
  tap(entry('planner: classified', { channel: 'c1', ms: 700 }, t0));
  tap(entry('memory: update applied', { guildId: 'g1', ms: 40000 }, t0));
  tap(entry('memory: private update applied', { guildId: 'g1', ms: 20000 }, t0));
  tap(entry('embedder: flushed', { embedded: 64, dropped: 0, left: 0, ms: 1500 }, t0));
  tap(entry('embedder: flushed', { embedded: 0, dropped: 3, left: 0, ms: 2 }, t0));
  tap(entry('recall: summary', { channel: 'c1', ms: 0, answer: 'fallback', summary: 'skipped' }, t0));

  const n = (name) => metrics.summary(name, 24).n;
  const median = (name) => metrics.summary(name, 24).median;
  assert.equal(n('reply'), 3, 'the first message of each turn only');
  assert.equal(median('reply'), 3200);
  assert.deepEqual(metrics.summary('reply with recall', 24), { n: 1, median: 8500, mean: 8500 });
  assert.equal(n('reply without recall'), 2, 'the late recall of an earlier turn counts as none');
  assert.equal(median('recall total'), 2900);
  assert.equal(median('discord search'), 500);
  assert.equal(median('record match'), 30);
  assert.equal(median('memory match'), 15);
  assert.equal(median('meaning search'), 120);
  assert.equal(n('meaning search'), 1, 'a search that did not run is no sample');
  assert.deepEqual(
    metrics.summary('recall summary', 24),
    { n: 1, median: 2000, mean: 2000 },
    'a skipped summary is no sample'
  );
  assert.equal(median('planner'), 700);
  assert.equal(n('analyzer batch'), 2);
  assert.deepEqual(
    metrics.summary('embedding flush', 24),
    { n: 1, median: 1500, mean: 1500 },
    'a flush that sent nothing is no sample'
  );
  for (const name of metrics.names()) assert.ok(SPEED_METRICS.includes(name), name);
});

test('metricsTap: subscribed to the log, it records what the log writes', async () => {
  const metrics = createMetrics({ dataDir: tmpDir(), now: clock() });
  const off = onLog(metricsTap(metrics));
  try {
    await withCapturedLogs(() => log.info('planner: classified', { channel: 'c9', ms: 321 }));
  } finally {
    off();
  }
  assert.deepEqual(metrics.summary('planner', 24), { n: 1, median: 321, mean: 321 });
});
