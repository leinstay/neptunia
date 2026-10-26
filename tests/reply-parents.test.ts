import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchReplyParents } from '../src/behavior/reply-parents.ts';
import { historyLines } from '../src/behavior/lines.ts';
import type { Line } from '../src/behavior/lines.ts';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { refTo, world } from './fixtures/turn-world.ts';

type Raw = Record<string, unknown>;

function rawMessage(overrides: Raw = {}): Raw {
  return {
    id: 'm1',
    channelId: 'c1',
    guild: { id: 'g1' },
    channel: { name: 'general' },
    author: { id: 'u1', bot: false, globalName: 'Alice', username: 'alice' },
    member: { displayName: 'Alice' },
    cleanContent: 'hello',
    createdTimestamp: 1000,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    messageSnapshots: new Map(),
    flags: { has: () => false },
    ...overrides,
  };
}

/** A raw reply to `parentId` (a plain message when it is null). */
function rawReply(id: string, ts: number, parentId: string | null, overrides: Raw = {}): Raw {
  return rawMessage({ id, createdTimestamp: ts, reference: parentId ? { messageId: parentId } : null, ...overrides });
}

const OPTIONS = { recent: 3, max: 4 };

/**
 * A channel `c1` holding the `stored` messages the window does not show (older than it) and the `window` messages the
 * turn read, the reads' record of the ids it asked for, and the window as lines.
 */
async function scene(stored: ReadonlyArray<Raw>, window: ReadonlyArray<Raw>) {
  const w = world();
  w.channel({ id: 'c1' });
  w.renormalize({ media: { embedTextChars: 200, video: { sites: ['youtube.com'] } } });
  const asked: Array<string> = [];
  w.tap('fetchMessages', ([, ids]) => {
    asked.push(...(ids as Array<string>));
  });
  w.seed('c1', stored);
  w.seed('c1', window);
  const history = await historyLines(w.reads, refTo({ id: 'c1' }), { limit: window.length });
  return { reads: w.reads, ref: refTo({ id: 'c1' }), asked, history };
}

function ids(lines: ReadonlyArray<Line>): Array<string> {
  return lines.map((line) => line.id);
}

test('fetchReplyParents reads the parent of a trigger that replies outside the window like a history line', async () => {
  const parent = rawMessage({
    id: 'p1',
    createdTimestamp: 100,
    cleanContent: 'regarde https://www.youtube.com/watch?v=abc',
  });
  const { reads, ref, asked, history } = await scene([parent], [rawReply('m1', 5000, 'p1')]);
  const parents = await fetchReplyParents(reads, ref, history, { ...OPTIONS, trigger: history[0] ?? null });
  assert.deepEqual(asked, ['p1']);
  assert.deepEqual(ids(parents), ['p1']);
  assert.equal(parents[0]?.content, 'regarde https://www.youtube.com/watch?v=abc');
  assert.equal((parents[0]?.links as Array<{ url: string }>)[0]?.url, 'https://www.youtube.com/watch?v=abc');
});

test('fetchReplyParents never asks for a parent that lies inside the window', async () => {
  const { reads, ref, asked, history } = await scene(
    [],
    [rawMessage({ id: 'p1', createdTimestamp: 10 }), rawReply('m1', 5000, 'p1')]
  );
  const parents = await fetchReplyParents(reads, ref, history, { ...OPTIONS, trigger: history[1] ?? null });
  assert.deepEqual(parents, []);
  assert.deepEqual(asked, []);
});

test('fetchReplyParents adds the parent of the fetched parent, one level only, oldest first', async () => {
  const stored = [rawMessage({ id: 'p0', createdTimestamp: 50 }), rawReply('p1', 80, 'p0'), rawReply('p2', 100, 'p1')];
  const { reads, ref, asked, history } = await scene(stored, [rawReply('m1', 5000, 'p2')]);
  const parents = await fetchReplyParents(reads, ref, history, { ...OPTIONS, trigger: history[0] ?? null });
  assert.deepEqual(ids(parents), ['p1', 'p2']);
  assert.deepEqual(asked, ['p2', 'p1']);
});

test('fetchReplyParents reads the parents of the last recent lines only, newest first', async () => {
  const stored = ['pa', 'pb', 'pc', 'pd'].map((id, i) => rawMessage({ id, createdTimestamp: 10 + i }));
  const window = [
    rawReply('m1', 1000, 'pa'),
    rawReply('m2', 2000, 'pb'),
    rawReply('m3', 3000, 'pc'),
    rawReply('m4', 4000, 'pd'),
  ];
  const { reads, ref, asked, history } = await scene(stored, window);
  const parents = await fetchReplyParents(reads, ref, history, { ...OPTIONS, recent: 3, trigger: null });
  assert.deepEqual(asked, ['pd', 'pc', 'pb']);
  assert.deepEqual(ids(parents), ['pb', 'pc', 'pd']);
});

test('fetchReplyParents stops at max lines and takes the chain of the trigger first', async () => {
  const stored = [
    rawMessage({ id: 'p0', createdTimestamp: 1 }),
    rawReply('p1', 2, 'p0'),
    rawMessage({ id: 'pb', createdTimestamp: 3 }),
    rawMessage({ id: 'pc', createdTimestamp: 4 }),
  ];
  const window = [rawReply('m2', 2000, 'pb'), rawReply('m3', 3000, 'pc'), rawReply('m4', 4000, 'p1')];
  const { reads, ref, asked, history } = await scene(stored, window);
  const parents = await fetchReplyParents(reads, ref, history, { ...OPTIONS, max: 3, trigger: history[2] ?? null });
  assert.deepEqual(asked, ['p1', 'p0', 'pc']);
  assert.deepEqual(ids(parents), ['p0', 'p1', 'pc']);
});

test('fetchReplyParents skips a deleted parent and logs it once with ids only', async () => {
  const { reads, ref, asked, history } = await scene([], [rawReply('m1', 1000, 'gone'), rawReply('m2', 2000, 'gone')]);
  const { result, logs } = await withCapturedLogs(() =>
    fetchReplyParents(reads, ref, history, { ...OPTIONS, trigger: history[1] ?? null })
  );
  assert.deepEqual(result, []);
  assert.deepEqual(asked, ['gone']);
  const missing = logs.filter((entry: { msg: string }) => entry.msg === 'collect: parent missing');
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.channel, 'c1');
  assert.equal(missing[0]?.messageId, 'gone');
});

test('fetchReplyParents asks for nothing when max is 0', async () => {
  const { reads, ref, asked, history } = await scene(
    [rawMessage({ id: 'p1', createdTimestamp: 1 })],
    [rawReply('m1', 1000, 'p1')]
  );
  const parents = await fetchReplyParents(reads, ref, history, { ...OPTIONS, max: 0, trigger: history[0] ?? null });
  assert.deepEqual(parents, []);
  assert.deepEqual(asked, []);
});
