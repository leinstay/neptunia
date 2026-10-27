// verbatim.js and requests.js (operational rows), and the registry of index.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as verbatim from '../src/memory/db/map/verbatim.js';
import * as requests from '../src/memory/db/map/requests.js';
import { MAPPERS, classify, kindOfPath } from '../src/memory/db/map/index.js';
import { assertRoundTrip, roundTrip } from './fixtures/memory-db/roundtrip.js';

test('a whole file is one operational row whose kind says which file it is', () => {
  const cases = [
    ['voice.json', [], 'voice'],
    ['buffer.json', [], 'buffer'],
    [
      'inner.json',
      {
        v: 1,
        stopped: false,
        stoppedAt: null,
        queue: [],
        handled: { inner: { 'wake:intention_due:i1:1': { at: 1, outcome: 'done' } } },
      },
      'inner',
    ],
    [
      'missed.json',
      { v: 1, candidates: [{ messageId: '1', question: true, turnIds: [], verdict: null }], lastRecoveryAt: { 1: 5 } },
      'missed',
    ],
    ['forgotten.json', { ids: ['1'] }, 'forgotten'],
    ['forgetting/100000000000000001.json', { userId: '100000000000000001', at: 'x', step: 'vectors' }, 'forgetting'],
    ['record/2026-10/ids.json', ['400000000000000001:1'], 'record_ids'],
    [
      'record/backfill.json',
      { selfId: '1', channels: { 2: 'a' }, cursors: { 2: { resume: null, last: null, written: 0, doneUntil: 'x' } } },
      'record_backfill',
    ],
    ['archive/2026-10.ids.json', ['rc-1:rv-1'], 'archive_ids'],
    ['backfill/state.json', { extract: { done: [], windows: 1 } }, 'backfill'],
    ['backfill/manifest-2026-10.json', { guildId: '3', messages: [{ id: '1', channelId: '2' }] }, 'backfill'],
    ['journal/requests/tools/abcdef.json', [{ type: 'function', function: { name: 'x' } }], 'request_tools'],
    ['private/100000000000000001/record/2026-10/ids.json', [], 'record_ids'],
  ];
  for (const [rel, value, kind] of cases) {
    const rows = assertRoundTrip(verbatim, rel, value);
    assert.equal(rows.operational[0].kind, kind, rel);
    assert.equal(rows.operational[0].owner, rel);
    assert.equal(rows.operational[0].owner_file, rel);
  }
});

test('a text file and every JSON value come back as they were', () => {
  assertRoundTrip(verbatim, 'journal/.running', '{"startedAt":"2026-10-24T00:24:59.730Z"}');
  assertRoundTrip(verbatim, 'journal/.running', '');
  assertRoundTrip(verbatim, 'voice.json', null);
  assertRoundTrip(verbatim, 'voice.json', 'Καλημέρα');
  assertRoundTrip(verbatim, 'missed.json', { a: [1, null, { b: 0.1, c: '' }], d: -0 === 0 });
});

test('a line of a JSONL file is owned by its path and position', () => {
  const trace = {
    at: '2026-10-20T10:00:00.000Z',
    channelId: '2',
    forms: ['x'],
    who: [],
    when: null,
    hits: 0,
    summary: { answer: null },
  };
  const a = roundTrip(verbatim, 'recall-trace.jsonl', trace, { position: 0 });
  const b = roundTrip(verbatim, 'recall-trace.jsonl', trace, { position: 1 });
  assert.deepEqual(a.back, trace);
  assert.equal(a.rows.operational[0].kind, 'recall_trace');
  assert.equal(a.rows.operational[0].owner, 'recall-trace.jsonl#0');
  assert.notEqual(a.rows.operational[0].owner, b.rows.operational[0].owner);
  assertRoundTrip(verbatim, 'archive/pending.jsonl', { id: 'a', entry: { id: 'rc-1' } }, { position: 3 });
  assertRoundTrip(verbatim, 'backfill/candidates.jsonl', { kind: 'episode', mentioned: [] }, { position: 0 });
});

const dump = (extra = {}) => ({
  v: 1,
  turnId: 'turn-1',
  attemptId: 0,
  step: 2,
  recordedAt: '2026-10-23T10:00:00.000Z',
  system: 'rules',
  parts: [{ type: 'text', text: 'hi', cacheSegment: 'a' }],
  raw: '<think>she waits</think>Hello',
  usage: { prompt: 1, cached: 0, cacheWrite: 0, completion: 2 },
  toolCalls: [{ id: 'c1', name: 'recall', arguments: '{}', parsed: {}, parseError: null }],
  later: [{ role: 'tool', content: [{ type: 'text', text: 'x' }], tool_call_id: 'c1' }],
  ...extra,
});

test("a request dump is kept verbatim and also yields the step's answer source", () => {
  const rel = 'journal/requests/2026-10-23/turn-1-s2.json';
  const { rows, back } = roundTrip(requests, rel, dump());
  assert.deepEqual(back, dump());
  assert.equal(rows.operational[0].kind, 'request_dump');
  const [source] = rows.sources;
  assert.equal(source.id, 'src:turn:turn-1:0:s2');
  assert.equal(source.kind, 'answer');
  assert.equal(source.think, 'she waits');
  assert.equal(source.text, '<think>she waits</think>Hello');
  assert.equal(source.turn_id, 'turn-1');
  assert.equal(source.scope_kind, 'internal');
  assert.equal(requests.stepSourceBelongsTo(source.id), 'src:turn:turn-1:0');
  assert.equal(requests.stepSourceId('t', 1, 3), 'src:turn:t:1:s3');
});

test('a dump without a think block or without turn fields still round trips', () => {
  const rel = 'journal/requests/2026-10-23/x.json';
  const plain = roundTrip(requests, rel, dump({ raw: 'no thinking here' }));
  assert.equal(plain.rows.sources[0].think, null);
  assert.deepEqual(plain.back, dump({ raw: 'no thinking here' }));
  const bare = roundTrip(requests, rel, { v: 1, raw: 'x' });
  assert.equal(bare.rows.sources, undefined);
  assert.deepEqual(bare.back, { v: 1, raw: 'x' });
  assertRoundTrip(requests, rel, [1, 2]);
});

test('classify names the mapper and format of every memory path', () => {
  const cases = [
    ['record/2026-10/2026-10-20.jsonl', 'record', 'jsonl'],
    ['private/1/record/2026-10/2026-10-20.jsonl', 'record', 'jsonl'],
    ['record/2026-10/ids.json', 'verbatim', 'json'],
    ['journal/2026-10-20.jsonl', 'journal', 'jsonl'],
    ['journal/.running', 'verbatim', 'text'],
    ['journal/requests/2026-10-23/t-s1.json', 'requests', 'json'],
    ['journal/requests/tools/abc.json', 'verbatim', 'json'],
    ['archive/2026-10.jsonl', 'archive', 'jsonl'],
    ['private/1/archive/2026-10.jsonl', 'archive', 'jsonl'],
    ['archive/2026-10.ids.json', 'verbatim', 'json'],
    ['archive/pending.jsonl', 'verbatim', 'jsonl'],
    ['archive/pending-done.jsonl', 'verbatim', 'jsonl'],
    ['vectors/2026-10/manifest.json', 'vectors', 'vectors'],
    ['vectors/2026-10/3.i8', 'vectors', 'vectors'],
    ['private/1/vectors/2026-10/3.jsonl', 'vectors', 'vectors'],
    ['versions/users/1.json', 'versions', 'json'],
    ['users/1.json', 'user', 'json'],
    ['private/1.json', 'private', 'json'],
    ['channels/2.json', 'channel', 'json'],
    ['guild.json', 'guild', 'json'],
    ['lore.json', 'lore', 'json'],
    ['participation.json', 'participation', 'json'],
    ['recent.json', 'recent', 'json'],
    ['diary.json', 'diary', 'json'],
    ['intentions.json', 'intentions', 'json'],
    ['intentions-archive.jsonl', 'intentions', 'jsonl'],
    ['errands.json', 'errands', 'json'],
    ['errands.jsonl', 'errands', 'jsonl'],
    ['media.json', 'media', 'json'],
    ['gifs.json', 'gifs', 'json'],
    ['voice.json', 'verbatim', 'json'],
    ['buffer.json', 'verbatim', 'json'],
    ['inner.json', 'verbatim', 'json'],
    ['missed.json', 'verbatim', 'json'],
    ['recall-trace.jsonl', 'verbatim', 'jsonl'],
    ['forgotten.json', 'verbatim', 'json'],
    ['forgetting/5.json', 'verbatim', 'json'],
    ['backfill/candidates.jsonl', 'verbatim', 'jsonl'],
    ['backfill/state.json', 'verbatim', 'json'],
    ['record/backfill.json', 'verbatim', 'json'],
  ];
  for (const [rel, kind, format] of cases) {
    const found = classify(rel);
    assert.ok(found && !found.skipped, rel);
    assert.equal(found.kind, kind, rel);
    assert.equal(found.format, format, rel);
    assert.equal(found.mapper, MAPPERS[kind], rel);
    assert.equal(kindOfPath(rel), kind, rel);
  }
});

test('classify gives a month directory as the unit of vectors files and strips a guild prefix', () => {
  assert.equal(classify('vectors/2026-10/manifest.json').unit, 'vectors/2026-10');
  assert.equal(classify('vectors/2026-10/1.i8').unit, 'vectors/2026-10');
  const prefixed = classify('guilds/300000000000000001/diary.json');
  assert.equal(prefixed.kind, 'diary');
  assert.equal(prefixed.guildId, '300000000000000001');
  assert.equal(prefixed.unit, 'diary.json');
});

test('paths that are not memory are listed as skipped, and unknown ones are null', () => {
  for (const rel of [
    'state.json',
    'usage.json',
    'metrics.json',
    'mentor/run-1.json',
    'recall-eval/q.json',
    'vision-compare/a/b.json',
    'state.json.bak-20260921-124355',
    'guild.json.bak-20260924110639',
    'media.json.bak-20260923-143629',
    'intentions.json.unreadable-1792000000000',
  ]) {
    const found = classify(rel);
    assert.equal(found?.skipped, true, rel);
    assert.equal(typeof found.reason, 'string');
  }
  assert.equal(classify('something/else.txt'), null);
  assert.equal(kindOfPath('state.json'), null);
});
