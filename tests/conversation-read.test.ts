// Tests for conversation.read (src/tools/conversation-read.ts): the selection of her arguments,
// the record reader, the runner over fakes (the three modes, the paging line, the interface's
// history when the record lacks the span, a hidden channel refused), and the registry rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/tools/impl/index.ts';
import { skillRegistry } from '../src/tools/registry.ts';
import { IN_TURN_TOOLS } from '../src/tools/tools.ts';
import {
  pickSpan,
  readSelection,
  recordMessages,
  runConversationRead,
  sinceMoment,
} from '../src/tools/conversation-read.ts';
import { labels } from './fixtures/labels.ts';
import type { Untyped } from '../src/tools/types.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

const NOW = Date.parse('2026-10-17T12:00:00Z');
const HOUR = 3_600_000;

const L = {
  ...labels,
  tools: {
    ...labels.tools,
    tools: {
      ...labels.tools.tools,
      conversation: {
        source: 'from conversation.read #{channel}',
        handles: 'lines carry message numbers',
        none: 'no messages',
        cut: '({dropped} lines cut)',
        earlier: 'earlier: before=#{n}',
        later: 'later: after=#{n}',
      },
    },
  },
};

/** A normalized chat message at `NOW - ago` hours. */
function message(id: string, hoursAgo: number, text: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    placeId: 'c2',
    authorId: 'u7',
    authorName: 'Éloïse',
    self: false,
    bot: false,
    content: text,
    ts: NOW - hoursAgo * HOUR,
    replyToId: null,
    mentionedAccountIds: [],
    mentionedChannelIds: [],
    attachments: [],
    links: [],
    forwarded: [],
    stickers: [],
    emojis: [],
    reactions: [],
    ...extra,
  };
}

const CHAT = Array.from({ length: 30 }, (_, i) => message(`m${i}`, 30 - i, `γραμμή ${i}`));

function render() {
  return { timezone: 'UTC', gapMinutes: 24 * 60, maxChars: 800, selfName: 'Bot', labels: L };
}

function registry() {
  const taken: Array<{ n: number; id: string; placeId: string }> = [];
  return { taken, next: () => 40 + taken.length, take: (shown: typeof taken) => taken.push(...shown) };
}

// The text of a read's data; the data is typed unknown, and the tests read the text of the one that has it.
const textOf = (result: { data?: unknown }): string => String(loose(result.data).text);

function runner(overrides = {}) {
  const calls = { record: [] as Array<Untyped>, live: [] as Array<Untyped> };
  const deps = {
    labels: L,
    config: { bot: { timezone: 'UTC' } },
    placeId: 'c1',
    channelNameOf: (id: string) => (id === 'c2' ? 'jardin' : 'general'),
    allowed: () => true,
    readRecord: async (request: Untyped) => (calls.record.push(request), CHAT.filter((m) => m.ts >= request.from)),
    fetchLive: async (request: Untyped) => (calls.live.push(request), []),
    render,
    now: NOW,
    ...overrides,
  };
  return { calls, run: (args: Untyped) => runConversationRead({ ...deps, args }) };
}

test('registry: conversation.read is a read skill and an in-turn tool, with the options of the spec', () => {
  const skill = skillRegistry().get('conversation.read');
  assert.equal(loose(skill).kind, 'read');
  // Slice 7: the tool argument `channel` is named `place`.
  assert.deepEqual(Object.keys(loose(skill).argsSchema.properties), [
    'place',
    'around',
    'before',
    'after',
    'since',
    'last',
  ]);
  assert.equal(loose(skill).argsSchema.properties.last.maximum, 60);
  assert.ok(IN_TURN_TOOLS.includes('conversation.read'));
});

test('sinceMoment: a delay back, the latest clock time, a date-time', () => {
  assert.equal(sinceMoment('2h', NOW), NOW - 2 * HOUR);
  assert.equal(sinceMoment('09:00', NOW), Date.parse('2026-10-17T09:00:00Z'));
  assert.equal(sinceMoment('13:00', NOW), Date.parse('2026-10-16T13:00:00Z'));
  assert.equal(sinceMoment('2026-10-15T08:30:00Z', NOW), Date.parse('2026-10-15T08:30:00Z'));
  assert.equal(sinceMoment('whenever', NOW), null);
});

test('readSelection: the three modes, their defaults and caps, and the arguments that do not fit', () => {
  const at = { now: NOW };
  assert.deepEqual(readSelection({}, at), { mode: 'last', n: 20 });
  assert.deepEqual(readSelection({ last: 500 }, at), { mode: 'last', n: 60 });
  assert.deepEqual(readSelection({ around: 'm5' }, at), { mode: 'around', anchor: 'm5', before: 10, after: 10 });
  assert.deepEqual(readSelection({ around: 'm5', before: '3', after: '99' }, at), {
    mode: 'around',
    anchor: 'm5',
    before: 3,
    after: 30,
  });
  assert.deepEqual(readSelection({ since: '2h', last: 5 }, at), { mode: 'since', since: NOW - 2 * HOUR, n: 5 });
  assert.deepEqual(readSelection({ before: 'm9' }, at), { mode: 'before', anchor: 'm9', n: 20 });
  assert.deepEqual(readSelection({ after: 'm9', last: 7 }, at), { mode: 'after', anchor: 'm9', n: 7 });
  assert.equal(loose(readSelection({ around: 'm5', since: '2h' }, at)).error, 'args:exclusive');
  assert.equal(loose(readSelection({ before: '5' }, at)).error, 'args.around:required');
  assert.equal(loose(readSelection({ since: 'never' }, at)).error, 'args.since:value');
  assert.equal(loose(readSelection({ last: 0 }, at)).error, 'args.last:range');
});

test('pickSpan: each mode takes its part and says whether the list holds all of it', () => {
  const ids = (picked: Untyped) => picked.slice.map((m: Untyped) => m.id);
  assert.deepEqual(ids(pickSpan(CHAT, { mode: 'last', n: 3 })), ['m27', 'm28', 'm29']);
  assert.equal(pickSpan(CHAT.slice(-2), { mode: 'last', n: 3 }).enough, false);
  assert.deepEqual(ids(pickSpan(CHAT, { mode: 'around', anchor: 'm10', before: 2, after: 1 })), [
    'm8',
    'm9',
    'm10',
    'm11',
  ]);
  assert.equal(pickSpan(CHAT, { mode: 'around', anchor: 'm1', before: 5, after: 1 }).enough, false);
  assert.deepEqual(ids(pickSpan(CHAT, { mode: 'before', anchor: 'm10', n: 2 })), ['m8', 'm9']);
  assert.deepEqual(ids(pickSpan(CHAT, { mode: 'after', anchor: 'm10', n: 2 })), ['m11', 'm12']);
  assert.deepEqual(ids(pickSpan(CHAT, { mode: 'since', since: NOW - 3 * HOUR, n: 2 })), ['m27', 'm28']);
  assert.deepEqual(pickSpan(CHAT, { mode: 'around', anchor: 'gone', before: 1, after: 1 }), {
    slice: [],
    enough: false,
  });
});

/** A record line of channel c2. */
function line(id: string, hoursAgo: number, text: string, extra: Record<string, unknown> = {}) {
  const at = new Date(NOW - hoursAgo * HOUR).toISOString();
  return {
    kind: 'seen',
    messageId: id,
    revision: 1,
    occurredAt: at,
    recordedAt: at,
    scope: { channel: 'c2' },
    by: 'u7',
    text,
    media: [],
    mentions: [],
    ...extra,
  };
}

function fakeRecord(lines: Array<{ scope: { channel: string }; occurredAt: string } & Record<string, unknown>>) {
  const reads: Array<Untyped> = [];
  return {
    reads,
    iterate: async function* iterate(placeId: string, query: { placeIds?: Array<string>; from?: string }) {
      reads.push(query);
      for (const entry of lines) {
        if (query.placeIds && !query.placeIds.includes(entry.scope.channel)) continue;
        if (query.from && Date.parse(entry.occurredAt) < Date.parse(query.from)) continue;
        yield entry;
      }
    },
  };
}

test('recordMessages: the newest revision stands with the edited stamp, a deleted message is a placeholder, media rides as its kinds', async () => {
  const record = fakeRecord([
    line('a', 5, 'first'),
    line('b', 4, 'before the edit'),
    line('b', 4, 'after the edit', { revision: 2, recordedAt: new Date(NOW - 3 * HOUR).toISOString() }),
    line('c', 3, 'gone soon'),
    {
      kind: 'deleted',
      messageId: 'c',
      occurredAt: new Date(NOW - 3 * HOUR).toISOString(),
      scope: { channel: 'c2' },
      participants: ['u7'],
    },
    line('d', 2, 'with a picture', { media: ['image'] }),
    { ...line('e', 1, 'mine'), kind: 'said', by: undefined },
    { ...line('z', 1, 'elsewhere'), scope: { channel: 'c9' } },
  ]);
  const found = await recordMessages(record, 'g1', {
    placeId: 'c2',
    from: NOW - 6 * HOUR,
    nameOf: (id) => (id === 'u7' ? 'Éloïse' : null),
    selfName: 'Bot',
  });
  assert.deepEqual(
    found.map((m) => m.id),
    ['a', 'b', 'c', 'd', 'e']
  );
  const [a, b, c, d, e] = found;
  assert.equal(a.authorName, 'Éloïse');
  assert.equal(b.content, 'after the edit');
  assert.equal(b.editedAt, NOW - 3 * HOUR);
  assert.equal(c.deleted, true);
  assert.equal(c.content, '');
  assert.equal(loose(d.attachments).length, 1);
  assert.deepEqual([e.self, e.authorName], [true, 'Bot']);
  assert.deepEqual(
    await recordMessages(
      {
        iterate: async function* iterate() {
          throw new Error('boom');
        },
      },
      'g1',
      { placeId: 'c2', from: 0 }
    ),
    [],
    'a failed read gives none'
  );
});

test('last: the newest lines from the record with their handles, the paging line, no history asked', async () => {
  const refs = registry();
  const { calls, run } = runner({ refs });
  const result = await run({ last: 3 });
  assert.equal(result.status, 'ok');
  assert.equal(calls.live.length, 0);
  assert.equal(calls.record.length, 1, 'the first rung held it');
  const lines = textOf(result).split('\n');
  assert.equal(lines[0], 'from conversation.read #general');
  assert.equal(lines[1], 'lines carry message numbers');
  assert.match(lines[2], /^#40 \[\d\d:\d\d\] Éloïse: γραμμή 27$/);
  assert.match(lines[4], /^#42 .*γραμμή 29$/);
  assert.equal(lines[5], 'earlier: before=#40');
  assert.equal(lines.length, 6, 'the newest lines have nothing later');
  assert.deepEqual(
    refs.taken.map((ref) => [ref.n, ref.id, ref.placeId]),
    [
      [40, 'm27', 'c1'],
      [41, 'm28', 'c1'],
      [42, 'm29', 'c1'],
    ]
  );
});

test('around: the lines each side of the message, both ways to read on', async () => {
  const refs = registry();
  const { run } = runner({ refs });
  const result = await run({ placeId: 'c2', around: 'm10', before: '2', after: '1' });
  const text = textOf(result);
  assert.ok(text.startsWith('from conversation.read #jardin\n'));
  assert.deepEqual(
    [...text.matchAll(/γραμμή (\d+)/g)].map((m) => Number(m[1])),
    [8, 9, 10, 11]
  );
  assert.ok(text.includes('earlier: before=#40'), text);
  assert.ok(text.endsWith('later: after=#43'), text);
  assert.deepEqual(
    refs.taken.map((ref) => ref.placeId),
    ['c2', 'c2', 'c2', 'c2'],
    'handles name the channel that was read'
  );
});

test('since: the lines from that moment on, cut at last with a way to read on', async () => {
  const { run, calls } = runner({ refs: registry() });
  const result = await run({ since: '3h', last: 2 });
  assert.deepEqual(
    [...textOf(result).matchAll(/γραμμή (\d+)/g)].map((m) => Number(m[1])),
    [27, 28]
  );
  assert.ok(textOf(result).endsWith('later: after=#41'), textOf(result));
  assert.equal(calls.record[0].from, NOW - 3 * HOUR, 'the record is read from the moment asked');
});

test('before and after a message: the paging a closing line hands over', async () => {
  const { run } = runner({ refs: registry() });
  const earlier = await run({ before: 'm10', last: 2 });
  assert.deepEqual(
    [...textOf(earlier).matchAll(/γραμμή (\d+)/g)].map((m) => Number(m[1])),
    [8, 9]
  );
  const later = await run({ after: 'm10', last: 2 });
  assert.deepEqual(
    [...textOf(later).matchAll(/γραμμή (\d+)/g)].map((m) => Number(m[1])),
    [11, 12]
  );
});

test('the room: lines that do not fit are cut from the far end and counted, only the shown ones get a handle', async () => {
  const refs = registry();
  const { run } = runner({ refs, maxChars: 700 });
  const result = await run({ last: 20 });
  const shown = refs.taken.length;
  assert.ok(shown > 0 && shown < 20, String(shown));
  assert.ok(textOf(result).includes(`(${20 - shown} lines cut)`), textOf(result));
  assert.equal(refs.taken.at(-1)?.id, 'm29', 'the newest lines stay');
  assert.ok(textOf(result).length <= 700 + 200);
});

test('the record lacks the span: the history is asked and joins, the answer comes from both', async () => {
  const live = [message('l1', 0.5, 'από το ιστορικό'), message('l2', 0.25, 'και άλλη μία')];
  const { run, calls } = runner({
    readRecord: async () => [],
    fetchLive: async (request: Untyped) => (calls.live.push(request), live),
  });
  const result = await run({ placeId: 'c2', last: 2 });
  assert.equal(calls.live.length, 1);
  assert.deepEqual(calls.live[0], { placeId: 'c2', mode: 'last', anchor: null, limit: 2, minTs: 0 });
  assert.ok(textOf(result).includes('από το ιστορικό') && textOf(result).includes('και άλλη μία'));
});

test('an anchor in neither the record nor the history is an unknown message; a history that failed with an empty record is a failure', async () => {
  const none = runner({ readRecord: async () => [], fetchLive: async () => [] });
  assert.deepEqual(await none.run({ around: 'nope' }), {
    status: 'invalid',
    code: 'unknown-message',
    reason: 'args.around',
  });
  const broken = runner({ readRecord: async () => [], fetchLive: async () => null });
  assert.deepEqual(await broken.run({ last: 3 }), { status: 'failed', code: 'error' });
});

test('an empty span says so; arguments that do not fit are invalid; a hidden channel is denied before anything is read', async () => {
  const empty = runner({ readRecord: async () => [], fetchLive: async () => [] });
  assert.equal(loose((await empty.run({ last: 3 })).data).text, 'from conversation.read #general\nno messages');
  assert.deepEqual(await empty.run({ around: 'm1', since: '2h' }), {
    status: 'invalid',
    code: 'invalid-args',
    reason: 'args:exclusive',
  });
  const hidden = runner({ allowed: (id: string) => id !== 'c9' });
  assert.deepEqual(await hidden.run({ placeId: 'c9' }), { status: 'denied', code: 'channel-not-visible' });
  assert.equal(hidden.calls.record.length + hidden.calls.live.length, 0, 'nothing was read');
});
