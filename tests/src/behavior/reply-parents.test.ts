import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchReplyParents } from '../../../src/behavior/reply-parents.ts';
import { historyLines } from '../../../src/behavior/lines.ts';
import type { Line } from '../../../src/behavior/lines.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { refTo, world } from '../../fixtures/turn-world.ts';
import { userText as textOf } from '../../../src/behavior/prompt.ts';
import { labels } from '../../fixtures/labels.ts';
import { createDiscordAdapter, createDiscordInterface } from '../../../interfaces/discord/index.ts';
import { createTurnRunner } from '../../fixtures/turn-runner.ts';
import { asRecord } from '../../fixtures/records.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import {
  NOW,
  fakeClient,
  fakeHot,
  fakeLlm,
  fakeStore,
  fakeTurnChannel,
  identityCalibrator,
  normalizedTrigger,
  rawMessage as turnRawMessage,
} from '../../fixtures/turn-kit.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';

type Raw = Record<string, unknown>;

function rawMessage(overrides: Raw = {}): Raw {
  return {
    id: 'm1',
    placeId: 'c1',
    root: { id: 'g1' },
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
  w.renormalize({ media: { video: { sites: ['youtube.com'] } } });
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
  const entries = logs as Array<{ msg?: string; channel?: string; messageId?: string }>;
  const missing = entries.filter((entry) => entry.msg === 'collect: parent missing');
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

// The Discord interface's capabilities object, as src/index.ts injects it.
const DISCORD = createDiscordInterface().capabilities;

// ---------------------------------------------------------------------------
// features.mediaDescriptions -- describing pictures that are not attached.

function fakeDescriber(descriptionsById: Untyped) {
  const calls: Array<{ placeId: Untyped; items: Untyped; options: Untyped }> = [];
  return {
    calls,
    describeMany: async (placeId: string, items: Untyped, options: unknown) => {
      calls.push({ placeId, items, options });
      const descriptions = new Map();
      for (const item of items) {
        if (descriptionsById[item.itemId]) descriptions.set(item.itemId, descriptionsById[item.itemId]);
      }
      return { descriptions, newCount: descriptions.size };
    },
  };
}

/** fakeDescriber plus describeVideos: every candidate in `statesById` gets that state. */
function fakeVideoDescriber(statesById: Untyped, descriptionsById = {}) {
  const base = fakeDescriber(descriptionsById);
  const videoCalls: Array<{ placeId: Untyped; items: Untyped; options: Untyped }> = [];
  return {
    ...base,
    videoCalls,
    describeVideos: async (placeId: string, items: Untyped, options: unknown) => {
      videoCalls.push({ placeId, items, options });
      const videos = new Map();
      for (const item of items) {
        if (statesById[item.itemId]) videos.set(item.itemId, statesById[item.itemId]);
      }
      return { videos, newCount: videos.size };
    },
  };
}

const VIDEO_TURN_CONFIG = {
  media: { maxPerTurn: 6, filePreviewChars: 500, video: { maxPerTurn: 1, sites: ['youtube.com'] } },
};

// ---------------------------------------------------------------------------
// Reply parents outside the window: a reply to a message older than the last
// context.channelMessages lines has its parent fetched by id and prepended.

/** A raw reply to `parentId` (see rawMessage). */
function rawReplyTo(parentId: unknown, fields: Untyped) {
  return { ...turnRawMessage(fields), reference: { messageId: parentId } };
}

/** fakeTurnChannel that also holds `stored` (raw messages outside the window); `fetchedIds` records every message read by id. */
function replyParentChannel(historyMessages: Array<Untyped>, stored: Array<Untyped> = []) {
  // The stored messages are older than the window, which is exactly the lines of `historyMessages`: the history read
  // (the newest `context.channelMessages`, set by runReplyParentTurn) leaves them out and a read by id finds them.
  const channel = fakeTurnChannel({ historyMessages: [...stored, ...historyMessages] });
  const fetchedIds: Array<Untyped> = [];
  world().tap('fetchMessages', ([ref, ids]: Array<Untyped>) => {
    if (asRecord(ref).chatId === channel.id) fetchedIds.push(...ids);
  });
  return Object.assign(channel, { fetchedIds });
}

/** The video-stage hot config. */
function replyParentHot() {
  return fakeHot({}, {}, VIDEO_TURN_CONFIG);
}

const OLD_PARENT_TS = NOW - 2 * 60 * 60 * 1000;

async function runReplyParentTurn({
  hot = replyParentHot(),
  historyMessages,
  stored,
  trigger,
}: Record<string, Untyped>) {
  hot.config.context.channelMessages = historyMessages.length;
  const channel = replyParentChannel(historyMessages, stored);
  const llm = fakeLlm('<msg>ok</msg>');
  const describer = fakeVideoDescriber({});
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    describer,
  });
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' })
  );
  const firstCall = llm.calls[0];
  return { result, logs, channel, describer, userMessage: textOf(firstCall?.[1].content) };
}

test('createTurnRunner: a trigger replying outside the window -- its parent is fetched, prepended, rendered as the reply target, and its link reaches the video stage', async () => {
  const parent = turnRawMessage({
    id: 'p1',
    authorId: 'u2',
    authorName: 'Bob',
    ts: OLD_PARENT_TS,
    content: 'δείτε https://www.youtube.com/watch?v=abc',
  });
  const triggerRaw = rawReplyTo('p1', { id: 'm2', ts: NOW - 1000, content: 'react to the video above' });
  const { result, channel, describer, userMessage } = await runReplyParentTurn({
    historyMessages: [turnRawMessage({ id: 'm1', ts: NOW - 5000, content: 'καλημέρα' }), triggerRaw],
    stored: [parent],
    trigger: { ...normalizedTrigger(triggerRaw), replyToId: 'p1' },
  });

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(channel.fetchedIds, ['p1']);
  assert.ok(userMessage.includes('(replying to #1, Bob: '), 'the reply names the prepended parent as the oldest line');
  assert.ok(!userMessage.includes(labels.transcript.replyToOld));
  assert.ok(userMessage.indexOf('δείτε') < userMessage.indexOf('καλημέρα'), 'the parent is the oldest line');
  const firstVideoCall = describer.videoCalls[0];
  const items = firstVideoCall.items;
  assert.ok(
    items.some(
      (item: Untyped) =>
        item.source === 'link' && item.messageId === 'p1' && item.url === 'https://www.youtube.com/watch?v=abc'
    )
  );
});

test('createTurnRunner: a reply whose parent is inside the window fetches nothing', async () => {
  const parent = turnRawMessage({ id: 'p1', authorId: 'u2', authorName: 'Bob', ts: NOW - 5000, content: 'δείτε' });
  const triggerRaw = rawReplyTo('p1', { id: 'm2', ts: NOW - 1000 });
  const { channel, userMessage } = await runReplyParentTurn({
    historyMessages: [parent, triggerRaw],
    trigger: { ...normalizedTrigger(triggerRaw), replyToId: 'p1' },
  });

  assert.deepEqual(channel.fetchedIds, []);
  assert.ok(userMessage.includes('(replying to #1, Bob: '));
});

test('createTurnRunner: a chain of two outside the window -- the parent and its own parent are both prepended, oldest first', async () => {
  const root = turnRawMessage({ id: 'p1', authorId: 'u3', authorName: 'Chloé', ts: OLD_PARENT_TS, content: 'ρίζα' });
  const middle = rawReplyTo('p1', {
    id: 'p2',
    authorId: 'u2',
    authorName: 'Bob',
    ts: OLD_PARENT_TS + 1000,
    content: 'μέση',
  });
  const triggerRaw = rawReplyTo('p2', { id: 'm2', ts: NOW - 1000 });
  const { channel, userMessage } = await runReplyParentTurn({
    historyMessages: [triggerRaw],
    stored: [root, middle],
    trigger: { ...normalizedTrigger(triggerRaw), replyToId: 'p2' },
  });

  assert.deepEqual(channel.fetchedIds, ['p2', 'p1']);
  assert.ok(userMessage.includes('(replying to #1, Chloé: '), 'the middle line replies to the root');
  assert.ok(userMessage.includes('(replying to #2, Bob: '), 'the trigger replies to the middle line');
  assert.ok(!userMessage.includes(labels.transcript.replyToOld));
});

test('createTurnRunner: the parents fetched for a window are capped at four, the newest lines first', async () => {
  // PR 7d: context.replyParentsMax is the constant 4 (the production value).
  const stored = ['pa', 'pb', 'pc', 'pd', 'pe'].map((id, i) =>
    turnRawMessage({ id, authorId: 'u2', authorName: 'Bob', ts: OLD_PARENT_TS + i })
  );
  const historyMessages = stored.map((parent, i) =>
    rawReplyTo(parent.id, { id: `m${i + 1}`, ts: NOW - (5 - i) * 1000 })
  );
  const { channel } = await runReplyParentTurn({
    historyMessages,
    stored,
    trigger: { ...normalizedTrigger(historyMessages[4]), replyToId: 'pe' },
  });
  assert.deepEqual(channel.fetchedIds, ['pe', 'pd', 'pc', 'pb']);
});

test('createTurnRunner: the window asks the parents of every line and shows them in <chat> before the window', async () => {
  const stored = ['pa', 'pb', 'pc'].map((id, i) =>
    turnRawMessage({ id, authorId: 'u2', authorName: 'Bob', ts: OLD_PARENT_TS + i, content: `γονέας ${id}` })
  );
  const historyMessages = [
    rawReplyTo('pa', { id: 'm1', ts: NOW - 3000 }),
    rawReplyTo('pb', { id: 'm2', ts: NOW - 2000 }),
    rawReplyTo('pc', { id: 'm3', ts: NOW - 1000 }),
  ];
  const hot = replyParentHot();
  const { channel, userMessage } = await runReplyParentTurn({
    hot,
    historyMessages,
    stored,
    trigger: { ...normalizedTrigger(historyMessages[2]), replyToId: 'pc' },
  });
  assert.deepEqual(channel.fetchedIds, ['pc', 'pb', 'pa'], 'every window line, newest first');
  const block = (tag: string) => userMessage.slice(userMessage.indexOf(`<${tag}>`), userMessage.indexOf(`</${tag}>`));
  // Slice 4: a reply has no `<earlier>`, its reply parents stay in `<chat>` before the window, numbered first.
  assert.ok(!userMessage.includes('<earlier>'));
  assert.ok(
    ['pa', 'pb', 'pc'].every((id, i) => block('chat').includes(`#${i + 1} [10:00] Bob: γονέας ${id}`)),
    block('chat')
  );
  assert.ok(block('chat').includes('(replying to #3, Bob: '), 'the chat still names a parent by its number');
});

test('createTurnRunner: a deleted reply parent is skipped and logged, the turn still speaks', async () => {
  const triggerRaw = rawReplyTo('gone', { id: 'm2', ts: NOW - 1000 });
  const { result, logs, channel, userMessage } = await runReplyParentTurn({
    historyMessages: [triggerRaw],
    trigger: { ...normalizedTrigger(triggerRaw), replyToId: 'gone' },
  });

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(channel.fetchedIds, ['gone']);
  const missing = logs.filter((entry) => entry.msg === 'collect: parent missing');
  assert.deepEqual(
    missing.map((entry) => [entry.channel, entry.messageId]),
    [['c1', 'gone']]
  );
  assert.ok(userMessage.includes(labels.transcript.replyToOld));
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['u1']);
