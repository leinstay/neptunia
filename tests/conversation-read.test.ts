// Tests for conversation.read (src/tools/conversation-read.ts): the selection of her arguments,
// the record reader, the runner over fakes (the three modes, the paging line, the interface's
// history when the record lacks the span, a hidden channel refused), and the registry rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillRegistry } from '../src/tools/registry.ts';
import '../src/tools/operations/index.ts';

import {
  pickSpan,
  readSelection,
  recordMessages,
  runConversationRead,
  sinceMoment,
} from '../src/tools/conversation-read.ts';
import { labels } from './fixtures/labels.ts';
import { createInTurnTools, type InTurnDraft } from '../src/turn/in-turn-tools.ts';
import { callViewOf } from '../src/turn/calls.ts';
import { executeCall, resolveCall } from '../src/tools/executors.ts';
import { turnRoutes } from '../src/behavior/turn-ability-route.ts';
import { frameReadsOver } from '../src/memory/db/frame-reads.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import { addLine, addPerson, addRoom, noteInterface, openWorld, rootId } from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
import { channel, message as eventOf, rig } from './fixtures/reads-rig.ts';
import type { HistoryQuery } from '../src/protocol/adapter.ts';
import type { Untyped } from '../src/tools/types.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from '../src/core.ts';
import type { Llm } from '../src/llm/openrouter.ts';
import { start } from '../src/interface/fake-interface.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { ROOT, SELF, channelInfo, lineEvent, settle, until } from './fixtures/core-over-fake.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { chainsOf } from './fixtures/chains.ts';
import { createRecall } from '../src/behavior/recall-run.ts';
import { quantize } from '../src/memory/vectors.ts';
import { countOf } from './fixtures/media-memory.ts';
import { formatDate } from '../src/format.ts';

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

// Bug: the record reader takes a line as hers only when its row is `said`, and an edit is stored `seen`, so her edited
// line reads as someone else's (named by the author's account) on every interface whose reads go through the record.
test('recordMessages: an edit of her own line, stored seen at the moment of the line, still reads as hers', async () => {
  const at = new Date(NOW - 5 * HOUR).toISOString();
  const record = fakeRecord([
    { ...line('mine', 5, 'before'), kind: 'said', by: undefined, occurredAt: at },
    { ...line('mine', 5, 'after', { revision: 2, occurredAt: at }), by: 'bot-account' },
  ]);
  const found = await recordMessages(record, 'g1', {
    placeId: 'c2',
    from: NOW - 6 * HOUR,
    nameOf: (id) => (id === 'bot-account' ? 'Someone Else' : null),
    selfName: 'Bot',
  });
  assert.deepEqual(
    found.map((m) => [m.content, m.self, m.authorName]),
    [['after', true, 'Bot']]
  );
});

// Bug (production, 2026-11-12): the command line stored her edit with the moment of the edit, so the line read as sent
// 93 minutes later than it was.
test('recordMessages: an edit stored with a later moment is dated by the first revision', async () => {
  const first = new Date(NOW - 5 * HOUR).toISOString();
  const edit = new Date(NOW - 5 * HOUR + 93 * 60_000).toISOString();
  const record = fakeRecord([
    { ...line('mine', 5, 'before'), kind: 'said', by: undefined, occurredAt: first },
    { ...line('mine', 5, 'after', { revision: 2, occurredAt: edit }), by: 'bot-account' },
  ]);
  const found = await recordMessages(record, 'g1', { placeId: 'c2', from: NOW - 6 * HOUR, selfName: 'Bot' });
  assert.deepEqual(
    found.map((m) => [m.content, m.ts, m.self]),
    [['after', Date.parse(first), true]]
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

test('a read whose interface link is closed is a failed call with its code, not one that may have gone through', async () => {
  const closed = runner({
    readRecord: () => Promise.resolve([]),
    fetchLive: () => Promise.resolve({ failed: 'link-closed' }),
  });
  assert.deepEqual(await closed.run({ last: 3 }), { status: 'failed', code: 'link-closed' });
});

test('a read whose adapter threw is a failed call with its code, not one that may have gone through', async () => {
  const threw = runner({
    readRecord: () => Promise.resolve([]),
    fetchLive: () => Promise.resolve({ failed: 'adapter-threw' }),
  });
  assert.deepEqual(await threw.run({ last: 3 }), { status: 'failed', code: 'adapter-threw' });
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

// A group turn reads a sibling channel of the same server through the real core: the real store over a temporary
// database, the fake interface and a scripted model. The line was stored from a received event in channel c2; the turn
// in channel c1 calls `conversation.read` of c2 and the tool result must hold that line.

const REPO = fileURLToPath(new URL('..', import.meta.url));
const STORED = 'the red book is on the shelf';

const CONFIG = {
  bot: {
    timezone: 'UTC',
    owners: ['u1'],
    access: { 'conversation.read': { everyone: false, roles: [], users: [SELF.id] } },
  },
  models: { routes: chainsOf({ video: false }) },
  pace: { settleMs: 0, settleMaxMs: 0 },
  typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], minMs: 0, maxMs: 0 },
  gifs: { backfillMessages: 0 },
};

const FIXED: Record<string, string> = {
  address: 'yes',
  // The lead: split, merge and missed answer in strict JSON (owner, 2026-11-06).
  split: '{"parts":[]}',
  merge: '{"item":null}',
  lookup: 'none',
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  'query-builder': '{"web":null,"history":null,"who":null,"when":null,"when_role":null,"recent":null,"skills":null}',
  'route-channel': 'none',
  'participation-pick': 'none',
  'elsewhere-pick': '{"place":null,"earlier":false,"episodes":[]}',
  'gif-pick': 'none',
  'media-pick': '{"pick":"none","name":null}',
  // The lead: split, merge and missed answer in strict JSON (owner, 2026-11-06).
  missed: '{"verdicts":[{"n":1,"verdict":"uncertain"}]}',
};

const toolResults = (messages: unknown): string =>
  (Array.isArray(messages) ? messages : [])
    .filter(
      (message: unknown): message is { role: string; content: unknown } =>
        (message as { role?: unknown } | null)?.role === 'tool'
    )
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .join('\n');

test('a group turn reads a line stored in another channel of the same server', async () => {
  // Bug: the read looked the stored record up under the channel's native root id instead of the turn's place,
  // so it answered "No messages in that span" while the line was stored.
  const root = mkdtempSync(join(tmpdir(), 'sr-'));
  const dataDir = join(root, 'd');
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  writeFileSync(join(dataDir, 'config', 'config.json'), JSON.stringify(CONFIG));
  let step = 0;
  let read = '';
  const llm: Pick<Llm, 'complete'> = {
    complete: (messages, options = {}) => {
      const fixed = FIXED[String((options as { purpose?: unknown }).purpose)];
      if (fixed !== undefined) return Promise.resolve(toolAnswer(fixed));
      step += 1;
      if (step === 1)
        return Promise.resolve(toolAnswer('', [call('conversation.read', { place: '#room-c2', last: 5 })]));
      if (step === 2) read = toolResults(messages);
      return Promise.resolve(toolAnswer('<skip/>'));
    },
  };
  let live: Awaited<ReturnType<typeof start>> | null = null;
  try {
    await withCapturedLogs(async () => {
      const core = await startCore({
        paths: { rootDir: REPO, privateDir: dataDir, dataDir },
        env: { OPENROUTER_CORE_KEY: 'test-key' },
        interfaces: [
          {
            name: 'fake',
            start: async (host) => (live = await start(host, { self: SELF, root: ROOT })),
          },
        ],
        llm,
        embedder: { embed: () => Promise.resolve([]) },
      });
      try {
        if (live === null) throw new Error('the core never started the fake interface');
        const fake = live;
        fake.adapter.seedChat(channelInfo('c1'));
        fake.adapter.seedChat(channelInfo('c2'));
        await fake.emit(lineEvent({ id: 'b0', chatId: 'c2', text: STORED, at: Date.now() }));
        await settle(200);
        await fake.emit(
          lineEvent({
            id: 'a1',
            chatId: 'c1',
            text: 'Nova, where is the red book?',
            at: Date.now(),
            mention: true,
          })
        );
        await until(() => step >= 2);
      } finally {
        await core.stop();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.ok(read.includes(STORED), read);
});

// A stored place read through the in-turn tools: the memory's lines, a line of which carries two ids as production rows
// do (`sources.native_id`, a uuid, and the platform's id in `extra.$messageLocator.messageId`), joined by the fake
// interface's history. Synthetic names.
const PLACE_NOW = Date.parse('2026-11-02T10:00:00.000Z');
const PLACE_AT = (minute: number): number => Date.parse('2026-11-02T09:00:00.000Z') + minute * 60_000;

/** One stored line of the room: its row id, a uuid-shaped `native_id`, and the platform's message id when it has one. */
type Row = { row: string; uuid: string; platform: string | null; text: string; minute: number };

function seedRoom(world: World, rows: ReadonlyArray<Row>): string {
  noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
  const room = addRoom(world.db, { iface: 'fake', native: 'c7', root: rootId('fake', 'g1'), name: 'garden' });
  addPerson(world.db, {
    id: 'person:eleni',
    accounts: [{ id: 'fake:u1', iface: 'fake', native: 'u1', names: ['Eleni'] }],
  });
  for (const one of rows) {
    addLine(world.db, {
      id: one.row,
      iface: 'fake',
      place: room,
      author: 'fake:u1',
      text: one.text,
      at: new Date(PLACE_AT(one.minute)).toISOString(),
    });
    const extra =
      one.platform === null
        ? null
        : JSON.stringify({
            $messageLocator: { v: 1, origin: 'protocol-message', iface: 'fake', chatId: 'c7', messageId: one.platform },
          });
    world.db.prepare('UPDATE sources SET native_id = ?, extra = ? WHERE id = ?').run(one.uuid, extra, one.row);
  }
  return room;
}

function placeScene(world: World) {
  const io = rig();
  io.fake.seedChat(channel('c7'));
  const draft: InTurnDraft = {};
  const hot = { config: { bot: { timezone: 'UTC' }, features: { coreTools: true } }, prompts: { labels } };
  const tools = createInTurnTools({
    hot,
    store: { listUserProfiles: () => [] },
    recall: null,
    speech: null,
    record: null,
    routes: turnRoutes(hot, null),
    clock: () => PLACE_NOW,
    ifaceReads: io.reads,
    lookup: undefined,
    describer: undefined,
    memberOf: () => null,
    chatOf: (current) => ({ iface: 'tele', chatId: current.id }),
    turnContextOf: () => internalContext(),
    placeReads: frameReadsOver(
      () => world.db,
      () => hot.config
    ),
    linkCalls: (lines) => lines,
    drawTool: () => Promise.reject(new Error('drawing is outside this fixture')),
  });
  const handlers = tools.inTurnTools({
    channel: channel('here'),
    placeId: 'tele-root',
    selfId: 'self',
    selfName: 'Synthetic persona',
    history: [],
    draft,
  });
  const { calls } = io.fake;
  const seedPlatform = (id: string, minute: number, text: string): void =>
    io.fake.seedEvent(eventOf(channel('c7'), id, PLACE_AT(minute), text, { authorId: 'u1', authorName: 'Eleni' }));
  /** The queries that reached the interface's history read, in order. */
  const historyQueries = (): Array<HistoryQuery> =>
    calls.filter((call) => call.op === 'history').map((call) => call.args[1] as HistoryQuery);
  /** The number a read handed out for the line with `text`: her `#N`. */
  const numberOf = (text: string): number => {
    const { searchRefs } = draft;
    const found = [...(searchRefs?.byNumber.entries() ?? [])].filter(([, ref]) =>
      String(loose(ref.message).content).includes(text)
    );
    assert.equal(found.length, 1, `one number for ${text}`);
    return found[0]?.[0] ?? -1;
  };
  const read = async (args: Record<string, unknown>): Promise<{ status: string; data?: { text: string } }> =>
    (await handlers['conversation.read'](args)) as { status: string; data?: { text: string } };
  /** `conversation.read` as her call writes it, `after` a `#N`, resolved and executed as a turn does. */
  const readAfter = async (n: number) => {
    const view = callViewOf({
      channel: { id: 'here', rootId: 'g1' },
      currentIface: 'tele',
      skills: skillRegistry(),
      searchRefs: draft.searchRefs,
    });
    const resolved = resolveCall({ skill: 'conversation.read', args: { after: `#${n}` } }, view);
    if (!resolved.ok) assert.fail(`the call was refused: ${JSON.stringify(resolved)}`);
    return (await executeCall(resolved, {
      inTurn: handlers,
      port: { send: () => Promise.reject(new Error('a read never sends')) },
      refOf: () => ({ iface: 'tele', chatId: 'here' }),
      here: { iface: 'tele', chatId: 'here' },
      opContext: { placeId: 'tele-root' },
    })) as { status: string; data?: { text: string } };
  };
  return { seedPlatform, historyQueries, numberOf, read, readAfter };
}

const ROWS: ReadonlyArray<Row> = [
  { row: 'row-1', uuid: '3f2a9c1e-7b44-4d0a-9e21-5c8b6a1d0f01', platform: 'p1', text: 'the olive harvest', minute: 1 },
  { row: 'row-2', uuid: '8d5e0b72-1c93-4f6e-a3b8-2e47d9c5a102', platform: 'p2', text: 'the wine press', minute: 2 },
  { row: 'row-3', uuid: 'c1b7f4a8-62de-4a35-8f19-7a03e6d8b203', platform: 'p3', text: 'the first frost', minute: 3 },
];

test('returns a line once when the stored row and the platform hold the same message under a uuid and a platform id', async () => {
  // Bug (2026-11-09): `after: #145` of a place gave each later line twice, with two consecutive numbers, because the
  // stored row's id (a uuid) and the platform's id of the same message never matched.
  const world = openWorld();
  try {
    const room = seedRoom(world, ROWS);
    const scene = placeScene(world);
    for (const one of ROWS) scene.seedPlatform(one.platform ?? '', one.minute, one.text);
    const answer = await scene.read({ placeId: room, last: 10 });
    assert.equal(answer.status, 'ok');
    const shown = answer.data?.text ?? '';
    assert.equal(shown.split('the wine press').length - 1, 1, shown);
  } finally {
    world.close();
  }
});

test('sends the platform message id as the anchor when after names a number of an earlier result', async () => {
  // Bug (2026-11-09): the number of a stored line stood for its uuid, and the uuid went to the platform as `after`.
  const world = openWorld();
  try {
    const room = seedRoom(world, ROWS);
    const scene = placeScene(world);
    await scene.read({ placeId: room, last: 10 });
    for (const one of ROWS) scene.seedPlatform(one.platform ?? '', one.minute, one.text);
    await scene.readAfter(scene.numberOf('the olive harvest'));
    const anchors = scene.historyQueries().flatMap((query) => (query.after === undefined ? [] : [query.after]));
    assert.deepEqual(anchors, ['p1']);
  } finally {
    world.close();
  }
});

test('answers from stored lines and sends no anchor when the anchored line has no platform id', async () => {
  // A stored line the platform never held (a line written by the core itself) has no id the platform could take.
  const world = openWorld();
  try {
    const rows = ROWS.map((one) => ({ ...one, platform: null }));
    const room = seedRoom(world, rows);
    const scene = placeScene(world);
    await scene.read({ placeId: room, last: 10 });
    const before = scene.historyQueries().length;
    const answer = await scene.readAfter(scene.numberOf('the olive harvest'));
    assert.equal(scene.historyQueries().length, before, 'the interface was asked again');
    assert.equal(answer.status, 'ok');
    assert.ok((answer.data?.text ?? '').includes('the wine press'));
  } finally {
    world.close();
  }
});

test('a read after a number of a stored line that has a platform id reaches the interface with that id and shows what the platform holds beyond the store', async () => {
  // Regression (2026-11-09, "the server returned 400"): the uuid of the anchor went to the platform, which refused it,
  // so the lines after the anchor that only the platform held never came back.
  const world = openWorld();
  try {
    const room = seedRoom(world, ROWS.slice(0, 2));
    const scene = placeScene(world);
    await scene.read({ placeId: room, last: 10 });
    for (const one of ROWS) scene.seedPlatform(one.platform ?? '', one.minute, one.text);
    const answer = await scene.readAfter(scene.numberOf('the olive harvest'));
    const asked = scene.historyQueries().filter((query) => query.after !== undefined);
    assert.equal(asked.at(-1)?.after, 'p1');
    assert.equal(answer.status, 'ok');
    assert.ok((answer.data?.text ?? '').includes('the first frost'));
  } finally {
    world.close();
  }
});

test('a read after a number of a stored line with no route sends its native id as the anchor when that id is the platform one', async () => {
  // Regression (2026-11-09): lines stored before message routes keep the platform's id in `native_id` and no route;
  // their anchors went to the platform and worked, and must keep doing so.
  const world = openWorld();
  try {
    const rows = ROWS.map((one, i) => ({ ...one, uuid: `11827364509182736${40 + i}`, platform: null }));
    const room = seedRoom(world, rows);
    const scene = placeScene(world);
    await scene.read({ placeId: room, last: 10 });
    await scene.readAfter(scene.numberOf('the olive harvest'));
    const anchors = scene.historyQueries().flatMap((query) => (query.after === undefined ? [] : [query.after]));
    assert.deepEqual(anchors, ['1182736450918273640']);
  } finally {
    world.close();
  }
});

// ---------- one read answers whether a place holds a thing ----------

// `conversation.read` of a stored place with `find`, through the in-turn tools over a real memory and a real recall. The
// fake embedder gives every query the vector CLOSE, and each stored line carries CLOSE or FAR, so the test alone decides
// what is close. The labelled lines are markers of these tests' own under new `tools.tools.conversation` keys.
const NEWEST_MARK = 'NEWEST-MARK {time}';
const NEWEST_FOUND = /NEWEST-MARK (.+)/;
const FIND_NONE_MARK = 'FIND-NONE-MARK';
const FOUND_MARK = 'FOUND-MARK';
const { tools: toolLabels } = L;
const { tools: toolKinds } = toolLabels;
const FIND_LABELS = {
  ...L,
  tools: {
    ...toolLabels,
    tools: {
      ...toolKinds,
      conversation: { ...toolKinds.conversation, newest: NEWEST_MARK, findNone: FIND_NONE_MARK, found: FOUND_MARK },
    },
  },
};
const EMBEDDER = 'test/embedder';
/** The query's own vector: a line stored under it is as close as a line can be. */
const CLOSE = [1, 0, 0];
/** A vector orthogonal to the query: nothing about the line is close. */
const FAR = [0, 0, 1];
const SHIPPED = JSON.parse(readFileSync(join(REPO, 'config', 'config.json'), 'utf8')) as Record<string, object>;
const FIND_CONFIG = {
  ...SHIPPED,
  bot: { ...SHIPPED.bot, timezone: 'UTC' },
  features: { ...SHIPPED.features, coreTools: true, meaningSearch: false, recall: true },
  models: { ...SHIPPED.models, byPurpose: { 'recall-query': EMBEDDER } },
};

/** One stored line of a room for a find: its row, its text, its minute after 09:00 and its vector. */
type FindLine = { row: string; text: string; minute: number; vector: ReadonlyArray<number> };

/** A room `fake:channel:<native>` holding `lines`, each with its vector under the fake embedder's model. */
function findRoom(world: World, native: string, lines: ReadonlyArray<FindLine>): string {
  const room = addRoom(world.db, { iface: 'fake', native, root: rootId('fake', 'g1'), name: native });
  for (const one of lines) {
    addLine(world.db, {
      id: one.row,
      iface: 'fake',
      place: room,
      author: 'fake:u1',
      text: one.text,
      at: new Date(PLACE_AT(one.minute)).toISOString(),
    });
    const { bytes, scale, norm } = quantize([...one.vector]);
    world.db
      .prepare(
        `INSERT INTO vectors (source_rowid, item_id, chunk_key, model, dims, scale, norm, bytes, context, occurred_at, scope_kind, scope_iface, scope_dm)
         SELECT rowid, ?, ?, ?, ?, ?, ?, ?, '{}', occurred_at, scope_kind, scope_iface, scope_dm FROM sources WHERE id = ?`
      )
      .run(one.row, `record:${one.row}:1`, EMBEDDER, one.vector.length, scale, norm, bytes, one.row);
  }
  return room;
}

/** The interface, the person and the in-turn tools over `world`, with a recall whose embedder answers CLOSE. */
function findScene(world: World) {
  noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
  addPerson(world.db, {
    id: 'person:eleni',
    accounts: [{ id: 'fake:u1', iface: 'fake', native: 'u1', names: ['Eleni'] }],
  });
  const io = rig();
  io.fake.seedChat(channel('c7'));
  io.fake.seedChat(channel('c8'));
  const hot = { config: FIND_CONFIG, prompts: { 'recall-summary': 'x', labels: FIND_LABELS } };
  const data = {};
  const store = {
    state: {
      get data() {
        return data;
      },
      markDirty() {},
    },
    listUserProfiles: () => [],
  };
  const recall = createRecall({
    iface: 'discord',
    reads: {
      searchMessages: () => Promise.resolve({ total: 0, hits: [] }),
      searchMembers: () => Promise.resolve({ members: [] }),
      history: () => Promise.resolve({ events: [], complete: true }),
    },
    hot,
    store,
    llm: { capLeft: () => 100, complete: () => Promise.resolve({ text: '' }) },
    now: () => PLACE_NOW,
    memoryDb: { database: () => world.db },
    embed: (texts: Array<string>) => Promise.resolve(texts.map(() => Float32Array.from(CLOSE))),
  } as unknown as Parameters<typeof createRecall>[0]);
  const tools = createInTurnTools({
    hot,
    store,
    recall,
    speech: null,
    record: null,
    routes: turnRoutes(hot, null),
    clock: () => PLACE_NOW,
    ifaceReads: io.reads,
    lookup: undefined,
    describer: undefined,
    memberOf: () => null,
    chatOf: (current) => ({ iface: 'tele', chatId: current.id }),
    turnContextOf: () => internalContext(),
    placeReads: frameReadsOver(
      () => world.db,
      () => hot.config
    ),
    linkCalls: (lines) => lines,
    drawTool: () => Promise.reject(new Error('drawing is outside this fixture')),
  });
  const handlers = tools.inTurnTools({
    channel: channel('here'),
    placeId: 'tele-root',
    selfId: 'self',
    selfName: 'Synthetic persona',
    history: [],
    draft: {},
  });
  /** The text of a `conversation.read` with `args`, failing the test when the read is not ok. */
  return async (args: Record<string, unknown>): Promise<string> => {
    const answer = (await handlers['conversation.read'](args)) as { status: string; data?: { text: string } };
    assert.equal(answer.status, 'ok', JSON.stringify(answer));
    return answer.data?.text ?? '';
  };
}

/** Six lines of a room, minutes 1 to 6, every one far from any query unless `close` names its minute. */
const roomLines = (prefix: string, close: ReadonlyArray<number> = []): Array<FindLine> =>
  [1, 2, 3, 4, 5, 6].map((minute) => ({
    row: `${prefix}-${minute}`,
    text: `${prefix} line ${minute}`,
    minute,
    vector: close.includes(minute) ? CLOSE : FAR,
  }));

test('returns the window and after it a line of the same place that matches find and stands outside the window', async () => {
  const world = openWorld();
  try {
    const read = findScene(world);
    const room = findRoom(world, 'c7', roomLines('garden', [1]));
    const text = await read({ placeId: room, last: 2, find: 'маяк' });
    const window = text.indexOf('garden line 6');
    assert.ok(text.includes('garden line 5') && window >= 0, text);
    assert.ok(text.indexOf('garden line 1') > window, `the match follows the window: ${text}`);
    assert.ok(text.indexOf(FOUND_MARK) > window && text.indexOf(FOUND_MARK) < text.indexOf('garden line 1'), text);
  } finally {
    world.close();
  }
});

test('does not repeat a matching line that stands in the window', async () => {
  const world = openWorld();
  try {
    const read = findScene(world);
    const room = findRoom(world, 'c7', roomLines('garden', [1, 6]));
    const text = await read({ placeId: room, last: 2, find: 'маяк' });
    assert.ok(text.includes('garden line 1'), `the match outside the window comes back: ${text}`);
    assert.equal(countOf(text, 'garden line 6'), 1, text);
  } finally {
    world.close();
  }
});

test('says nothing matches when no line of the place is close to find, and still returns the window', async () => {
  const world = openWorld();
  try {
    const read = findScene(world);
    const room = findRoom(world, 'c7', roomLines('garden'));
    const text = await read({ placeId: room, last: 2, find: 'маяк' });
    assert.ok(text.includes(FIND_NONE_MARK), text);
    assert.ok(text.includes('garden line 5') && text.includes('garden line 6'), `the window stands: ${text}`);
  } finally {
    world.close();
  }
});

test('searches only the place read when find is given: a matching line of another place does not come back', async () => {
  const world = openWorld();
  try {
    const read = findScene(world);
    const room = findRoom(world, 'c7', roomLines('garden', [1]));
    findRoom(world, 'c8', roomLines('cellar', [1, 2, 3, 4, 5, 6]));
    const text = await read({ placeId: room, last: 2, find: 'маяк' });
    assert.ok(text.includes('garden line 1'), `the match of the place read comes back: ${text}`);
    assert.ok(!text.includes('cellar line'), text);
  } finally {
    world.close();
  }
});

test('says the read reached the newest line when its window ends there, and nothing of the kind when a newer line exists', async () => {
  const world = openWorld();
  try {
    const read = findScene(world);
    const room = findRoom(world, 'c7', roomLines('garden'));
    const newest = await read({ placeId: room, last: 2 });
    assert.match(NEWEST_FOUND.exec(newest)?.[1] ?? '', /09:06/, newest);
    const older = await read({ placeId: room, since: '2h', last: 2 });
    assert.ok(older.includes('garden line 1') && !older.includes('garden line 6'), older);
    assert.equal(NEWEST_FOUND.exec(older), null, older);
  } finally {
    world.close();
  }
});

test('names the time of the newest line when a read with since returns nothing', async () => {
  const world = openWorld();
  try {
    const read = findScene(world);
    const room = findRoom(world, 'c7', roomLines('garden'));
    const text = await read({ placeId: room, since: '30m' });
    assert.ok(!text.includes('garden line'), text);
    assert.match(NEWEST_FOUND.exec(text)?.[1] ?? '', /09:06/, text);
  } finally {
    world.close();
  }
});

test('returns at most 8 matches of find, all of them outside the window, when more lines of the place are close', async () => {
  const world = openWorld();
  try {
    const read = findScene(world);
    const lines = Array.from({ length: 12 }, (_, i) => ({
      row: `kite-${i + 1}`,
      text: `kite note ${String(i + 1).padStart(2, '0')}`,
      minute: i + 1,
      vector: CLOSE,
    }));
    const room = findRoom(world, 'c7', lines);
    const text = await read({ placeId: room, last: 2, find: 'маяк' });
    const matches = text.slice(text.indexOf(FOUND_MARK));
    assert.equal(countOf(matches, 'kite note'), 8, text);
    assert.ok(!matches.includes('kite note 11') && !matches.includes('kite note 12'), text);
  } finally {
    world.close();
  }
});

// ---------- a stored place read keeps to the moment it was asked for ----------

// The owner's question about one day (plan 2026-11-10 tools-and-reads, items 5 to 9): a `since` read of a stored place,
// the date a window and its matches open with, the bounds of `find`, and the name of the place read. The stored lines
// are spread over days, each with a vector under the fake embedder of findScene. Synthetic names.

/** One stored line on a day of its own: its row, its text, its moment and its vector. */
type DatedLine = { row: string; text: string; at: string; vector: ReadonlyArray<number> };

/** A room `fake:channel:<native>` named `name` holding `lines`, each with its vector, as findRoom stores them. */
function datedRoom(world: World, native: string, name: string, lines: ReadonlyArray<DatedLine>): string {
  const room = addRoom(world.db, { iface: 'fake', native, root: rootId('fake', 'g1'), name });
  for (const one of lines) {
    addLine(world.db, { id: one.row, iface: 'fake', place: room, author: 'fake:u1', text: one.text, at: one.at });
    const { bytes, scale, norm } = quantize([...one.vector]);
    world.db
      .prepare(
        `INSERT INTO vectors (source_rowid, item_id, chunk_key, model, dims, scale, norm, bytes, context, occurred_at, scope_kind, scope_iface, scope_dm)
         SELECT rowid, ?, ?, ?, ?, ?, ?, ?, '{}', occurred_at, scope_kind, scope_iface, scope_dm FROM sources WHERE id = ?`
      )
      .run(one.row, `record:${one.row}:1`, EMBEDDER, one.vector.length, scale, norm, bytes, one.row);
  }
  return room;
}

/** `count` lines `<prefix> NNN`, one a minute from `start`, every one far from any query unless `close` names its index. */
const linesFrom = (prefix: string, start: string, count: number, close: ReadonlyArray<number> = []): Array<DatedLine> =>
  Array.from({ length: count }, (_, i) => ({
    row: `${prefix}-${i}`,
    text: `${prefix} ${String(i).padStart(3, '0')}`,
    at: new Date(Date.parse(start) + i * 60_000).toISOString(),
    vector: close.includes(i) ? CLOSE : FAR,
  }));

/** The moment `minute` minutes after 09:00 of the place reads' day, as a stored line holds it. */
const PLACE_ISO = (minute: number): string => new Date(PLACE_AT(minute)).toISOString();

/** The date a read writes for the moment `at`, as the transcript of a UTC turn in the fixture's locale writes it. */
const dateOf = (at: string): string => formatDate(Date.parse(at), 'UTC', FIND_LABELS.locale);

test('a since read of a stored place with more lines after the moment than one read holds returns the first lines at that moment', async () => {
  // Bug (2026-11-10): the read took the newest 60 stored lines and kept those after the moment, so `since` two days
  // back began at the newest hour and she read the wrong day.
  const world = openWorld();
  try {
    const read = findScene(world);
    const room = datedRoom(world, 'c7', 'kitchen', linesFrom('dish', '2026-11-01T08:00:00.000Z', 100));
    const text = await read({ placeId: room, since: '2026-11-01', last: 5 });
    assert.ok(text.includes('dish 000') && text.includes('dish 004'), text);
    assert.ok(!text.includes('dish 099'), text);
  } finally {
    world.close();
  }
});

test('a since read of a day that holds no line shows the date of the later lines it returns before the first of them', async () => {
  // Bug (2026-11-10): asked for a day with no line, the read returned the next day's lines under clock times alone, and
  // she took them for the day she was asked about.
  const world = openWorld();
  try {
    const read = findScene(world);
    const lines = [
      ...linesFrom('before', '2026-10-30T12:00:00.000Z', 3),
      ...linesFrom('after', '2026-11-01T12:00:00.000Z', 3),
    ];
    const room = datedRoom(world, 'c7', 'kitchen', lines);
    const text = await read({ placeId: room, since: '2026-10-31', last: 5 });
    const first = text.indexOf('after 000');
    // An answer that the day is empty shows no later line at all; one that shows them names their day first.
    if (first >= 0) {
      const date = text.indexOf(dateOf('2026-11-01T12:00:00.000Z'));
      assert.ok(date >= 0 && date < first, text);
    }
    assert.ok(!text.includes('before 00'), text);
  } finally {
    world.close();
  }
});

test('a window of lines of one day opens with the date of its first line', async () => {
  // Bug (2026-11-10): the transcript writes a date only between two lines of different days, so a window of one day
  // carried clock times and no day.
  const world = openWorld();
  try {
    const read = findScene(world);
    const room = findRoom(world, 'c7', roomLines('garden'));
    const text = await read({ placeId: room, last: 2 });
    const date = text.indexOf(dateOf(new Date(PLACE_AT(5)).toISOString()));
    assert.ok(date >= 0 && date < text.indexOf('garden line 5'), text);
  } finally {
    world.close();
  }
});

test('the matches of find open with the date of their first line', async () => {
  // Bug (2026-11-10): the first match of a find stood with a clock time and no day, so a line of September read as
  // a line of the day she was asked about.
  const world = openWorld();
  try {
    const read = findScene(world);
    const lines = [...linesFrom('old', '2026-09-14T10:00:00.000Z', 1, [0]), ...linesFrom('new', PLACE_ISO(1), 4)];
    const room = datedRoom(world, 'c7', 'kitchen', lines);
    const text = await read({ placeId: room, last: 2, find: 'маяк' });
    const matches = text.slice(text.indexOf(FOUND_MARK));
    const date = matches.indexOf(dateOf('2026-09-14T10:00:00.000Z'));
    assert.ok(text.includes(FOUND_MARK) && matches.includes('old 000'), text);
    assert.ok(date >= 0 && date < matches.indexOf('old 000'), text);
  } finally {
    world.close();
  }
});

test('find with since returns no match older than the moment', async () => {
  // Bug (2026-11-10): `find` searched the whole place whatever `since` said, and the matches of a read of 8 November
  // were lines of September and October.
  const world = openWorld();
  try {
    const read = findScene(world);
    const lines = [
      ...linesFrom('old', '2026-10-01T10:00:00.000Z', 2, [0, 1]),
      ...linesFrom('new', '2026-11-01T10:00:00.000Z', 5, [4]),
    ];
    const room = datedRoom(world, 'c7', 'kitchen', lines);
    const text = await read({ placeId: room, since: '2026-10-15', last: 2, find: 'маяк' });
    assert.ok(text.includes('new 004'), `a match after the moment comes back: ${text}`);
    assert.ok(!text.includes('old 00'), text);
  } finally {
    world.close();
  }
});

test('find with a message-valued before returns no match later than that line', async () => {
  // Bug (2026-11-10): `find` ignored the window's bounds, so a read before a line brought back matches after it.
  const world = openWorld();
  try {
    const read = findScene(world);
    const room = findRoom(world, 'c7', roomLines('garden', [1, 6]));
    const text = await read({ placeId: room, before: 'garden-4', last: 2, find: 'маяк' });
    assert.ok(text.includes('garden line 3'), `the window before the line stands: ${text}`);
    assert.ok(text.includes('garden line 1'), `a match before the line comes back: ${text}`);
    assert.ok(!text.includes('garden line 6'), text);
  } finally {
    world.close();
  }
});

test('the source line of a read of a stored place names the place', async () => {
  // Bug (2026-11-10): the source line knew only the chats of the turn's own tree, so a stored place on another
  // interface read as a source with an empty name and she could not tell which place she had read.
  const world = openWorld();
  try {
    const read = findScene(world);
    const room = datedRoom(world, 'c7', 'orchard', linesFrom('pear', PLACE_ISO(1), 3));
    const text = await read({ placeId: room, last: 3 });
    assert.ok(text.includes('pear 002'), text);
    assert.match(text.split('\n')[0] ?? '', /orchard/, text);
  } finally {
    world.close();
  }
});
