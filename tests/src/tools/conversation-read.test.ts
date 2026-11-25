// Tests for conversation.read (src/tools/conversation-read.ts): the selection of the persona's arguments,
// the record reader, the runner over fakes (the three modes, the paging line, the interface's
// history when the record lacks the span, a hidden channel refused), and a group turn of the real core that reads a
// line stored in another channel.
import { test, after, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import '../../../src/tools/operations/index.ts';
import {
  pickSpan,
  readSelection,
  recordMessages,
  runConversationRead,
  sinceMoment,
} from '../../../src/tools/conversation-read.ts';
import { labels } from '../../fixtures/labels.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from '../../../src/core.ts';
import type { Llm } from '../../../src/llm/openrouter.ts';
import { start } from '../../../scripts/lib/fake-interface.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { ROOT, SELF, channelInfo, lineEvent, settle, until } from '../../fixtures/core-over-fake.ts';
import { call, toolAnswer, completionOf } from '../../fixtures/tool-answers.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { noMediaNames } from '../../fixtures/media-namer.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import { createInTurnTools } from '../../../src/turn/in-turn-tools.ts';
import type { InTurnDraft } from '../../../src/turn/in-turn-tools.ts';
import { callViewOf } from '../../../src/turn/calls.ts';
import { executeCall, resolveCall } from '../../../src/tools/executors.ts';
import { turnRoutes } from '../../../src/behavior/turn-ability-route.ts';
import { frameReadsOver } from '../../../src/memory/db/frame-reads.ts';
import { internalContext, issueContext } from '../../../src/memory/db/scope.ts';
import {
  addLine,
  addPerson,
  addRoom,
  noteInterface,
  openWorld,
  rootId,
  addDm,
  addClaim,
} from '../../fixtures/memory-db/mind-world.ts';
import type { World } from '../../fixtures/memory-db/mind-world.ts';
import { channel, message as eventOf, rig, message as rigMessage } from '../../fixtures/reads-rig.ts';
import type { Rig } from '../../fixtures/reads-rig.ts';
import type { HistoryQuery } from '../../../src/protocol/adapter.ts';
import type { MediaName } from '../../../src/memory/store-media-names.ts';
import { createAppendStore } from '../../../src/memory/append-store.ts';
import { createArchive } from '../../../src/memory/archive.ts';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { createMemoryDb } from '../../../src/memory/db/service.ts';
import type { MemoryDbService } from '../../../src/memory/db/service.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import type { Db } from '../../../src/memory/db/types.ts';
import { createJournal } from '../../../src/memory/journal.ts';
import { createRecord, toRecordLine } from '../../../src/memory/record.ts';
import { createStore } from '../../../src/memory/store.ts';
import { createVectors } from '../../../src/memory/vectors.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import { addAccount, addDmPlace, addGroupPlace } from '../../fixtures/memory-db/opaque-people.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { seedExisting, useIface, world as turnConversationReadWorld } from '../../fixtures/turn-world.ts';
import {
  NIKOS,
  TEXT,
  TURN_NOW,
  ZOE,
  heartbeatWorld,
  serviceTurn,
  serviceWake,
  C1_CHAT,
  blockOf,
  replyRun,
  serviceWorld,
  CLI_CHAT,
} from '../../fixtures/service-turn.ts';
import type { ReplyChat, ReplyLine, ReplyRun, ReplyStep } from '../../fixtures/service-turn.ts';
import { handleOf } from '../../../src/behavior/handles.ts';
import { applyMemoryWrite } from '../../../src/memory/db/session-write.ts';
import { notOk } from '../../../src/protocol/actions.ts';
import { OWNER_PERSON } from '../../fixtures/owner-accounts.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createTurnRunner } from '../../fixtures/turn-runner.ts';
import { createAdmin } from '../../../src/admin.ts';
import { fill } from '../../../src/format.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

const NOW = Date.parse('2026-10-17T12:00:00Z');

const HOUR = 3_600_000;

const SHIPPED_TOOLS = labels.tools;

const L = {
  ...labels,
  tools: {
    ...labels.tools,
    tools: {
      ...SHIPPED_TOOLS.tools,
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
  return { mediaNameOf: noMediaNames, timezone: 'UTC', gapMinutes: 24 * 60, maxChars: 800, selfName: 'Bot', labels: L };
}

function registry() {
  const taken: Array<{ n: number; id: string; placeId: string }> = [];
  return {
    taken,
    next: () => 40 + taken.length,
    take: (shown: typeof taken) => taken.push(...shown),
    shown: () => null,
  };
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

// Bug: the record reader takes a line as the persona's only when its row is `said`, and an edit is stored `seen`, so
// the persona's edited line reads as someone else's (named by the author's account) on every interface whose reads go
// through the record.
test("recordMessages: an edit of the persona's own line, stored seen at the moment of the line, still reads as theirs", async () => {
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

// Bug: the command line stored the persona's edit with the moment of the edit, so the line read as sent 93 minutes
// later than it was.
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
  const firstRead = loose(calls.record[0]);
  assert.equal(firstRead.from, NOW - 3 * HOUR, 'the record is read from the moment asked');
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
  const { calls: hiddenCalls } = hidden;
  assert.equal(hiddenCalls.record.length + hiddenCalls.live.length, 0, 'nothing was read');
});

// A group turn reads a sibling channel of the same server through the real core: the real store over a temporary
// database, the fake interface and a scripted model. The line was stored from a received event in channel c2; the turn
// in channel c1 calls `conversation.read` of c2 and the tool result must hold that line.

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

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
  // The lead: split, merge and missed answer in strict JSON.
  split: '{"parts":[]}',
  merge: '{"item":null}',
  lookup: 'none',
  'route-channel': 'none',
  'participation-pick': 'none',
  'elsewhere-pick': '{"place":null,"earlier":false,"episodes":[]}',
  'gif-pick': 'none',
  'classify/pick': '{"pick":"none","name":null}',
  // The lead: split, merge and missed answer in strict JSON.
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

// conversation.read of a stored place through the in-turn tools (src/turn/in-turn-tools.ts over
// src/tools/conversation-read.ts): the platform's message ids as anchors, `find`, and the moment and the day a read
// keeps to. The cases of src/tools/conversation-read.ts alone are in tests/src/tools/conversation-read.test.ts.

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const conversationReadLoose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

const CONVERSATION_READ_NOW = Date.parse('2026-10-17T12:00:00Z');

const CONVERSATION_READ_HOUR = 3_600_000;

const { tools: toolsValue } = labels.tools;
const CONVERSATION_READ_L = {
  ...labels,
  tools: {
    ...labels.tools,
    tools: {
      ...toolsValue,
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
function conversationReadMessage(id: string, hoursAgo: number, text: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    placeId: 'c2',
    authorId: 'u7',
    authorName: 'Éloïse',
    self: false,
    bot: false,
    content: text,
    ts: CONVERSATION_READ_NOW - hoursAgo * CONVERSATION_READ_HOUR,
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

const CONVERSATION_READ_CHAT = Array.from({ length: 30 }, (_, i) =>
  conversationReadMessage(`m${i}`, 30 - i, `γραμμή ${i}`)
);

function conversationReadRender() {
  return {
    mediaNameOf: noMediaNames,
    timezone: 'UTC',
    gapMinutes: 24 * 60,
    maxChars: 800,
    selfName: 'Bot',
    labels: CONVERSATION_READ_L,
  };
}

// The text of a read's data; the data is typed unknown, and the tests read the text of the one that has it.
const conversationReadTextOf = (result: { data?: unknown }): string => String(conversationReadLoose(result.data).text);

function conversationReadRunner(overrides = {}) {
  const calls = { record: [] as Array<Untyped>, live: [] as Array<Untyped> };
  const deps = {
    labels: CONVERSATION_READ_L,
    config: { bot: { timezone: 'UTC' } },
    placeId: 'c1',
    channelNameOf: (id: string) => (id === 'c2' ? 'jardin' : 'general'),
    allowed: () => true,
    readRecord: async (request: Untyped) => (
      calls.record.push(request),
      CONVERSATION_READ_CHAT.filter((m) => m.ts >= request.from)
    ),
    fetchLive: async (request: Untyped) => (calls.live.push(request), []),
    render: conversationReadRender,
    now: CONVERSATION_READ_NOW,
    ...overrides,
  };
  return { calls, run: (args: Untyped) => runConversationRead({ ...deps, args }) };
}

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
    store: { mediaNameOf: noMediaNames, listUserProfiles: () => [] },
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
  /** The number a read handed out for the line with `text`: the persona's `#N`. */
  const numberOf = (text: string): number => {
    const { searchRefs } = draft;
    const found = [...(searchRefs?.byNumber.entries() ?? [])].filter(([, ref]) =>
      String(conversationReadLoose(ref.message).content).includes(text)
    );
    assert.equal(found.length, 1, `one number for ${text}`);
    return found[0]?.[0] ?? -1;
  };
  const read = async (args: Record<string, unknown>): Promise<{ status: string; data?: { text: string } }> =>
    (await handlers['conversation.read'](args)) as { status: string; data?: { text: string } };
  /** `conversation.read` as the persona's call writes it, `after` a `#N`, resolved and executed as a turn does. */
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

test('a read keeps the legend of its kept lines when the room cuts its first lines', async () => {
  const blob: MediaName = {
    name: 'e5',
    kind: 'emoji',
    iface: 'discord',
    nativeId: 'emo-5',
    platformName: 'blob',
    animated: false,
  };
  const emojis = [{ id: 'emo-5', name: 'e5', animated: false, told: { text: 'a round blob' } }];
  const chat = CONVERSATION_READ_CHAT.map((one) => (one.id === 'm29' ? { ...one, content: 'end :e5:', emojis } : one));
  const legendL = {
    ...CONVERSATION_READ_L,
    legend: { line: '{name} {platformName}: {text}', lineNoText: '', unreadable: '' },
  };
  const { run } = conversationReadRunner({
    labels: legendL,
    maxChars: 700,
    readRecord: (request: Untyped) => Promise.resolve(chat.filter((one) => one.ts >= request.from)),
    render: () => ({
      ...conversationReadRender(),
      labels: legendL,
      mediaNameOf: (name: string) => (name === 'e5' ? blob : null),
    }),
  });
  const text = conversationReadTextOf(await run({ last: 20 }));
  assert.ok(text.includes('lines cut)'), text);
  // The block of custom emoji and stickers is <media>.
  assert.ok(text.includes('<media>\n<discord><emojis>\n:e5: blob: a round blob\n'), text);
  assert.ok(text.indexOf('</media>') < text.indexOf('end :e5:'), text);
});

// What a direct message leaves in the journal, the record, the archive and the meaning index reaches its partner alone. A
// journal line of a DM names only its chat (`scope: { channel }`) and carries no private mark, so every reader
// that branched on the mark falls through to the channel rule or to none. Each test seeds one synthetic secret word through
// the writer a turn uses, over the real service and database, then reads as another reader: a group turn, another
// partner's private turn, the persona's own wake. Where the answer could be empty for want of a row, an internal context
// checks first that the row exists, so an empty answer means refused and never means unwritten. The last group asserts
// the converse: the partner's own private turn still reads their own lines.

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const DM_JOURNAL_PRIVACY_NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const SECRET = 'xylophonewhisper';

// A first-generation DM on the home authority: the place and the person are spelled from the native id.
const PARTNER = 'n1';
const PARTNER_ACCOUNT = 'discord:n1';
const PARTNER_PERSON = 'person:discord:n1';
const DM = 'discord:dm:n1';
const DM_CHAT = 'dm-chat-n1';
// Another partner on the same interface.
const OTHER = 'n2';
const OTHER_PERSON = 'person:discord:n2';
const OTHER_DM = 'discord:dm:n2';
const GROUP = 'discord:channel:room-1';
const SERVER = 'discord:server:g1';
// A partner with the same native id under another authority of the interface: the place's id spells nothing.
const STRANGER_ACCOUNT = 'account:other-authority';
const STRANGER_PERSON = 'person:elsewhere';
const STRANGER_DM = 'place:dm-other-authority';

/** Lets the journal's unawaited writes reach the writer, which runs on this thread here. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

const opened: Array<MemoryDbService> = [];

function seedWorld(db: Db): void {
  addAccount(db, {
    id: PARTNER_ACCOUNT,
    iface: 'discord',
    authority: 'discord/global',
    native: PARTNER,
    person: PARTNER_PERSON,
  });
  addAccount(db, {
    id: 'discord:n2',
    iface: 'discord',
    authority: 'discord/global',
    native: OTHER,
    person: OTHER_PERSON,
  });
  addAccount(db, {
    id: STRANGER_ACCOUNT,
    iface: 'discord',
    authority: 'discord/other',
    native: PARTNER,
    person: STRANGER_PERSON,
  });
  addDmPlace(db, {
    id: DM,
    iface: 'discord',
    authority: 'discord/global',
    account: PARTNER_ACCOUNT,
    person: PARTNER_PERSON,
  });
  addDmPlace(db, {
    id: OTHER_DM,
    iface: 'discord',
    authority: 'discord/global',
    account: 'discord:n2',
    person: OTHER_PERSON,
  });
  addDmPlace(db, {
    id: STRANGER_DM,
    iface: 'discord',
    authority: 'discord/other',
    account: STRANGER_ACCOUNT,
    person: STRANGER_PERSON,
  });
  addGroupPlace(db, GROUP, 'discord', 'discord/global');
  db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, chat, scope_kind)
     VALUES (?, 'discord', 'server', 'g1', 'server:g1', 'discord/global', 1, 'group', 'group')`
  ).run(SERVER);
}

function world() {
  const dataDir = tempDir('nep-dm-privacy-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  seedWorld(dbOf(seed));
  seed.close();
  const hot = { config: { memoryDb: { session: { mode: 'off' } }, context: { memory: { openPrivate: false } } } };
  const memoryDb = createMemoryDb({
    hot,
    dataDir,
    log: quiet,
    worker: false,
    iface: () => 'discord',
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const read = (): Db => dbOf(wrongly<Parameters<typeof dbOf>[0]>(memoryDb.readHandle()));
  const journal = createJournal({ dataDir, memoryDb, now: () => DM_JOURNAL_PRIVACY_NOW, log: quiet });
  const record = createRecord({ dataDir, memoryDb, now: () => DM_JOURNAL_PRIVACY_NOW, log: quiet });
  const appendStore = createAppendStore({ fsyncMs: 0, log: quiet });
  const archive = createArchive({ appendStore, dataDir, memoryDb, now: () => DM_JOURNAL_PRIVACY_NOW, log: quiet });
  const vectors = createVectors({ dataDir, memoryDb, now: () => DM_JOURNAL_PRIVACY_NOW, log: quiet });
  const store = createStore({ dataDir, archive, memoryDb });
  const contexts = {
    group: memoryDb.issueContext({ kind: 'group', iface: 'discord', destination: GROUP }),
    other: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: OTHER_PERSON, place: OTHER_DM }),
    partner: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: PARTNER_PERSON, place: DM }),
    stranger: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: STRANGER_PERSON, place: STRANGER_DM }),
  };
  return { dataDir, hot, memoryDb, read, journal, record, archive, vectors, store, contexts };
}

/** A record line of a chat: what a person said there. */
const lineSaid = (id: string, chat = DM_CHAT, by = PARTNER) =>
  toRecordLine(
    {
      id,
      placeId: chat,
      authorId: by,
      authorName: 'Partner',
      content: `the ${SECRET} plan`,
      ts: DM_JOURNAL_PRIVACY_NOW - 60_000,
    },
    { now: () => DM_JOURNAL_PRIVACY_NOW }
  );
describe('privacy of a dm journal', () => {
  after(async () => {
    for (const service of opened) await service.close();
  });

  test("a record read of a group by a DM's chat id yields no line of that DM", async () => {
    // Bug: `recordMessages` carries no `allowLine` on `conversation.read`, so only its place keeps the DM out.
    const w = world();
    await w.record.append(DM, [lineSaid('m-dm')]);
    await settled();
    const lines = await recordMessages(wrongly(w.record), GROUP, {
      placeId: DM_CHAT,
      from: DM_JOURNAL_PRIVACY_NOW - 3_600_000,
    });
    assert.equal(JSON.stringify(lines).includes(SECRET), false);
  });
});

// The service turns on the template of the turn frame (plan 2026-11-06-turn-frame, slice 5, "The services as one
// template" and "The service trees"): a heartbeat runs with `chat: null`, its
// request holds the service list (no `<chat>`, no `<surroundings>`), `<meanwhile>` holds the persona's last
// `context.memory.serviceMessages` lines over the rooms of every group of every interface and no direct chat, and
// `<memory>` reads as the persona.
// The shapes the specifier chose:
//   runTurn({ chat: null, mode: 'inner', triggerKind: 'inner', inner: { wake, currentChannel, shadow, mayAct } })
//     is a service turn nowhere.
//   The persona's journal is read at `journal.read(PERSONA_ID, { day, kind: 'turn' })`.

const INNER_TURN_SERVICE_HOUR = 3_600_000;
const MIN = 60_000;
const THINK = '<think>STEP 4. So: nothing.</think>';

/** The `#N` numbers the last tool result of a request put before its lines, in order. */
const shownNumbers = (request: string): Array<number> =>
  [...request.slice(request.lastIndexOf('Call succeeded')).matchAll(/^#(\d+) /gm)].map((match) => Number(match[1]));

/** The texts of the lines the last tool result of a request showed. */
const shownTexts = (request: string): Array<string> =>
  [...request.slice(request.lastIndexOf('Call ')).matchAll(/ΠΑΛΙΑ-(\d+)/g)].map((match) => match[0]);

/** The handle of the room `γενικά` in a heartbeat request. */
const roomHandle = (request: string): string => /#c[0-9a-z]+(?=: "γενικά")/.exec(request)?.[0] ?? '';

/**
 * A heartbeat over the heartbeat world whose room `γενικά` holds `long` more stored lines `ΠΑΛΙΑ-0` to `ΠΑΛΙΑ-<long-1>`,
 * an hour apart and before Ελένη's line there; each step calls conversation.read with the arguments `steps` give, a
 * function of the request it answers.
 */
const LONG = 90;
async function readingHeartbeat(steps: ReadonlyArray<(request: string) => Record<string, unknown>>, long = LONG) {
  const world = heartbeatWorld();
  for (let i = 0; i < long; i += 1)
    addLine(world.db, {
      id: `p${i}`,
      iface: 'fake',
      place: 'fake:channel:c1',
      author: 'fake:111',
      text: `ΠΑΛΙΑ-${i}`,
      at: new Date(TURN_NOW - (long - i) * INNER_TURN_SERVICE_HOUR).toISOString(),
    });
  return serviceTurn({
    wake: serviceWake('heartbeat'),
    answers: [
      ...steps.map((args) => (request: string) => toolAnswer(THINK, [call('conversation.read', args(request))])),
      '<skip/>',
    ],
    chat: null,
    world,
  });
}
describe('an inner turn of a service', () => {
  before(() => {
    useIface('fake');
  });
  after(() => {
    useIface('discord');
  });

  test('a heartbeat reads the direct chat of a person the persona names by handle', async () => {
    // Bug: the read with `person` counts as naming no place and is refused PLACE_REQUIRED in a turn with no place,
    // though the same chat read by its place handle passes.
    const run = await serviceTurn({
      wake: serviceWake('heartbeat'),
      answers: [toolAnswer(THINK, [call('conversation.read', { person: `@${handleOf(ZOE)}`, last: 5 })]), '<skip/>'],
      chat: null,
    });
    assert.equal(run.actions[0], 'conversation.read:executed:ok');
    assert.ok((run.requests[1] ?? '').includes(TEXT.ownPrivate), 'the line of the direct chat');
  });

  test('a heartbeat read of a person with no direct chat answers PLACE_NOT_FOUND', async () => {
    // Bug: the person read is refused PLACE_REQUIRED before it looks for the person's direct chat.
    const run = await serviceTurn({
      wake: serviceWake('heartbeat'),
      answers: [toolAnswer(THINK, [call('conversation.read', { person: `@${handleOf(NIKOS)}`, last: 5 })]), '<skip/>'],
      chat: null,
      world: heartbeatWorld(),
    });
    const [action = ''] = run.actions;
    assert.equal(action.split(':')[2], 'PLACE_NOT_FOUND', action);
  });

  test('a heartbeat reads on after the last line a read showed when the chat holds newer lines', async () => {
    // Bug: the read of the room gave its last line a number and said to read on after it, and `after` of that number was
    // refused unknown-message: a stored place was read from its newest lines only, so a line older than those was no anchor.
    const run = await readingHeartbeat([
      (request) => ({ place: roomHandle(request), since: '2026-10-30' }),
      (request) => ({ place: roomHandle(request), after: `#${shownNumbers(request).at(-1)}` }),
    ]);
    assert.deepEqual(run.actions.slice(0, 2), ['conversation.read:executed:ok', 'conversation.read:executed:ok']);
    assert.equal(shownTexts(run.requests[1] ?? '').at(-1), 'ΠΑΛΙΑ-25');
    assert.equal(shownTexts(run.requests[2] ?? '')[0], 'ΠΑΛΙΑ-26');
  });

  test('a heartbeat reads on before the first line a read showed', async () => {
    // Bug: `before` of the first number a read of a stored place gave was refused when that line was older than its newest lines.
    const run = await readingHeartbeat([
      (request) => ({ place: roomHandle(request), since: '2026-10-30' }),
      (request) => ({ place: roomHandle(request), before: `#${shownNumbers(request)[0]}` }),
    ]);
    assert.equal(run.actions[1], 'conversation.read:executed:ok');
    assert.equal(shownTexts(run.requests[1] ?? '')[0], 'ΠΑΛΙΑ-6');
    assert.deepEqual(shownTexts(run.requests[2] ?? ''), [
      'ΠΑΛΙΑ-0',
      'ΠΑΛΙΑ-1',
      'ΠΑΛΙΑ-2',
      'ΠΑΛΙΑ-3',
      'ΠΑΛΙΑ-4',
      'ΠΑΛΙΑ-5',
    ]);
  });

  test('two reads of the same lines in one heartbeat show each line under one number', async () => {
    // Bug: every read numbered its lines on from the next free number, so a line read again took a new number.
    const run = await readingHeartbeat([
      (request) => ({ place: roomHandle(request), last: 3 }),
      (request) => ({ place: roomHandle(request), last: 2 }),
    ]);
    const first = shownNumbers(run.requests[1] ?? '');
    assert.equal(first.length, 3);
    assert.deepEqual(shownNumbers(run.requests[2] ?? ''), first.slice(1));
  });

  test('a heartbeat read after the newest line of a chat succeeds and shows no line', async () => {
    // Bug: `after` of the number of the chat's newest line was refused as an invalid call when the interface gave that line
    // and the record does not hold it yet: the interface has nothing after it and the record has no such anchor.
    const run = await readingHeartbeat(
      [
        (request) => {
          seedExisting('c1', 'r2', { authorId: '111', ts: TURN_NOW - MIN });
          return { place: roomHandle(request), last: 5 };
        },
        (request) => ({ place: roomHandle(request), after: `#${shownNumbers(request).at(-1)}` }),
      ],
      0
    );
    assert.equal(shownNumbers(run.requests[1] ?? '').length, 2, 'the stored line and the one only the interface gave');
    assert.deepEqual(run.actions.slice(0, 2), ['conversation.read:executed:ok', 'conversation.read:executed:ok']);
    assert.deepEqual(shownNumbers(run.requests[2] ?? ''), []);
  });
});

// The address of a direct chat is the interface's: the core stores the chat id a `message.received` carries on the
// place (`places.native_id`), for a direct chat as for a channel, and hands it back as it is for every read of the
// place. A direct chat whose place holds no address yet is opened once through the `dm.chat` read and the answer is
// stored through the one writer. A read that fails tells the persona the interface's code. Real temporary databases, the fake
// interface, synthetic names.

const PLACE_CHAT_NOW = Date.parse('2026-11-02T10:00:00.000Z');
const OWNER = 'person:owner';
const PLACE_CHAT_PARTNER = '777';
const PLACE_CHAT_DM_CHAT = 'dm-chat-41';
const LINE = 'a line of the owner in the direct chat';

/** The owner with a direct chat on the fake interface whose place holds `address`; the turn stands in the command line. */
function ownerWorld(address: string | null): { world: World; place: string } {
  const world = openWorld();
  noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
  addPerson(world.db, {
    id: OWNER,
    accounts: [
      { id: 'fake:777', iface: 'fake', native: PLACE_CHAT_PARTNER, names: ['Orestis'] },
      { id: 'cli:owner', iface: 'cli', native: 'owner', names: ['Orestis'] },
    ],
  });
  const place = addDm(world.db, { iface: 'fake', native: PLACE_CHAT_PARTNER, person: OWNER, account: 'fake:777' });
  addDm(world.db, { iface: 'cli', native: 'owner', person: OWNER, account: 'cli:owner' });
  world.db.prepare('UPDATE places SET native_id = ? WHERE id = ?').run(address, place);
  return { world, place };
}

/** The fake interface holding the owner's direct chat `DM_CHAT` with one line of the owner. */
function dmRig(): Rig {
  const io = rig();
  const dm = channel(PLACE_CHAT_DM_CHAT, { kind: 'dm', rootId: null, public: false });
  io.fake.seedChat(dm);
  io.fake.seedEvent(
    rigMessage(dm, 'm1', PLACE_CHAT_NOW - 60_000, LINE, { authorId: PLACE_CHAT_PARTNER, authorName: 'Orestis' })
  );
  return io;
}

type ReadAnswer = { status: string; code?: string; values?: Record<string, unknown>; data?: { text: string } };

/** One conversation.read of the place `place` from the command line chat, through the in-turn tools. */
async function readPlace(world: World, io: Rig, place: string): Promise<ReadAnswer> {
  const hot = { config: { bot: { timezone: 'UTC' }, features: { coreTools: true } }, prompts: { labels } };
  const tools = createInTurnTools({
    hot,
    store: {
      mediaNameOf: noMediaNames,
      listUserProfiles: () => [],
      notePlaceAddress: (placeId: string, address: string) =>
        Promise.resolve(applyMemoryWrite(world.db, { kind: 'place-address', placeId, address })),
    },
    recall: null,
    speech: null,
    record: null,
    routes: turnRoutes(hot, null),
    clock: () => PLACE_CHAT_NOW,
    ifaceReads: io.reads,
    lookup: undefined,
    describer: undefined,
    memberOf: () => null,
    chatOf: (current) => ({ iface: 'cli', chatId: current.id }),
    turnContextOf: () => internalContext(),
    placeReads: frameReadsOver(
      () => world.db,
      () => hot.config
    ),
    linkCalls: (lines) => lines,
    drawTool: () => Promise.reject(new Error('drawing is outside this fixture')),
  });
  const handlers = tools.inTurnTools({
    channel: channel('cli:dm:owner'),
    placeId: 'cli:dm:owner',
    selfId: 'self',
    selfName: 'Synthetic persona',
    history: [],
    draft: {},
  });
  return (await handlers['conversation.read']({ placeId: place, last: 10 })) as ReadAnswer;
}

/** The address the place holds. */
const addressOf = (world: World, place: string): unknown => {
  const row = world.db.prepare('SELECT native_id FROM places WHERE id = ?').get(place);
  return row?.native_id;
};

const chatsAsked = (io: Rig): Array<unknown> => io.asked('history').map((ref) => (ref as { chatId: string }).chatId);

test("a read of a direct chat reaches the interface's chat through the address its place holds", async () => {
  // Bug: the read asked the interface for a chat named by the partner's user id, which the platform answers with 404.
  const { world, place } = ownerWorld(PLACE_CHAT_DM_CHAT);
  try {
    const io = dmRig();
    const read = await readPlace(world, io, place);
    assert.equal(read.status, 'ok', JSON.stringify(read));
    const { data } = read;
    assert.ok(data?.text.includes(LINE), JSON.stringify(read));
    assert.deepEqual(chatsAsked(io), [PLACE_CHAT_DM_CHAT]);
    assert.equal(io.asked('dmChatOf').length, 0);
  } finally {
    world.close();
  }
});

test('a direct chat whose place holds no address is opened once through dm.chat and the answer is stored', async () => {
  // Bug: a direct chat seen before addresses were stored can never be read, or every read opens the chat again.
  const { world, place } = ownerWorld(null);
  try {
    const io = dmRig();
    io.fake.seedDmChat(PLACE_CHAT_PARTNER, PLACE_CHAT_DM_CHAT);
    const first = await readPlace(world, io, place);
    assert.equal(first.status, 'ok', JSON.stringify(first));
    const { data } = first;
    assert.ok(data?.text.includes(LINE), JSON.stringify(first));
    assert.equal(addressOf(world, place), PLACE_CHAT_DM_CHAT);
    const second = await readPlace(world, io, place);
    assert.equal(second.status, 'ok', JSON.stringify(second));
    assert.equal(io.asked('dmChatOf').length, 1);
    assert.deepEqual(chatsAsked(io), [PLACE_CHAT_DM_CHAT, PLACE_CHAT_DM_CHAT]);
  } finally {
    world.close();
  }
});

test("a read the interface answers with 404 tells the persona the interface's status, not a bare error", async () => {
  // Bug: every failed history read reached the persona as `error`, so the persona could not tell a gone chat from a broken engine.
  const { world, place } = ownerWorld(PLACE_CHAT_DM_CHAT);
  try {
    const io = dmRig();
    io.fake.failNext('history', notOk('failed', 'http-404'));
    const read = await readPlace(world, io, place);
    assert.deepEqual([read.status, read.code, read.values?.status], ['failed', 'http', '404'], JSON.stringify(read));
  } finally {
    world.close();
  }
});

// A line of `<chat>` keeps one number for as long as it stays in the window (plan 2026-11-10
// tools-and-reads, item 30; contract .agents/docs/specs/2026-11-11-chat-numbers-contract.md). The number is the line's
// place among the stored lines of its place, the oldest being 1, the number the owner's chat draws
// (src/memory/db/chat-lines.ts), so a turn adds lines at the end and renumbers none. Reply turns over the service world
// (tests/fixtures/service-turn.ts) with a window of three lines, a scripted model and synthetic names in Greek. Every
// line is written to the world's memory before its turn, as the memory writer stores what the interface observes,
// except where a test says otherwise.

const REPLY_TURN_CHAT_NUMBERS_MIN = 60_000;
const REPLY_TURN_CHAT_NUMBERS_THINK = '<think>STEP 4. So: answer.</think>';
const SKIP = `${REPLY_TURN_CHAT_NUMBERS_THINK}<skip/>`;
// The head moves with every line in these tests: the step of the head has its own tests below.
const WINDOW = { channelMessages: 3, chatHeadStep: 0 };
const iso = (at: number): string => new Date(at).toISOString();

/** The texts of the lines, each unique so a test finds its line in one block. */
const REPLY_TURN_CHAT_NUMBERS_TEXT = {
  room: 'ΓΡΑΜΜΗ-ΤΟΥ-ΓΕΝΙΚΑ',
  alpha: 'ΑΛΦΑ-ΓΡΑΜΜΗ',
  beta: 'ΒΗΤΑ-ΓΡΑΜΜΗ',
  gamma: 'ΓΑΜΜΑ-ΓΡΑΜΜΗ',
  delta: 'ΔΕΛΤΑ-ΓΡΑΜΜΗ',
  garden: 'ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ',
} as const;

/** The lines that join `c1` after the world's `r1` (five minutes before the turns' clock), one minute apart. */
const ALPHA: ReplyLine = {
  id: 'a1',
  text: REPLY_TURN_CHAT_NUMBERS_TEXT.alpha,
  at: TURN_NOW - 4 * REPLY_TURN_CHAT_NUMBERS_MIN,
};
const BETA: ReplyLine = {
  id: 'b1',
  text: REPLY_TURN_CHAT_NUMBERS_TEXT.beta,
  at: TURN_NOW - 3 * REPLY_TURN_CHAT_NUMBERS_MIN,
};
const GAMMA: ReplyLine = {
  id: 'c1x',
  text: REPLY_TURN_CHAT_NUMBERS_TEXT.gamma,
  at: TURN_NOW - 2 * REPLY_TURN_CHAT_NUMBERS_MIN,
};

/** Writes `lines` to the world's memory as lines of `chat`'s place, by Ελένη, as the memory writer stores them. */
const store = (world: World, chat: ReplyChat, lines: ReadonlyArray<ReplyLine>): void => {
  for (const replyTurnChatNumbersLine of lines)
    addLine(world.db, {
      id: `src:${chat.iface}:${replyTurnChatNumbersLine.id}:1`,
      iface: chat.iface,
      place: chat.place,
      author: `${chat.iface}:${replyTurnChatNumbersLine.authorId ?? '111'}`,
      text: replyTurnChatNumbersLine.text,
      at: iso(replyTurnChatNumbersLine.at),
    });
};

/** A step whose lines and trigger are stored before its turn. */
const storedStep = (world: World, chat: ReplyChat, step: ReplyStep): ReplyStep => ({
  ...step,
  before: () => {
    step.before?.();
    store(world, chat, [...(step.lines ?? []), step.trigger]);
  },
});

/** Reply turns in `c1` with a window of three lines, over a world made for the run. */
async function inRoom(
  steps: (world: World) => ReadonlyArray<ReplyStep>,
  options: { restartBefore?: number; world?: () => World } = {}
): Promise<ReplyRun> {
  const world = (options.world ?? serviceWorld)();
  try {
    return await replyRun({
      world,
      context: WINDOW,
      steps: steps(world).map((step) => storedStep(world, C1_CHAT, step)),
      ...(options.restartBefore === undefined ? {} : { restartBefore: options.restartBefore }),
    });
  } finally {
    world.close();
  }
}

/** The user text of request `step` of turn `turn` of a run, '' when there is none. */
const requestOf = (run: ReplyRun, turn: number, step = 0): string => {
  const requests = run.requests[turn] ?? [];
  return requests[step] ?? '';
};
/** The rows of a text. */
const rowsOf = (text: string): Array<string> => text.split('\n');
/** The row of `text` that holds `marker`, '' when none does. */
const rowWith = (text: string, marker: string): string => rowsOf(text).find((row) => row.includes(marker)) ?? '';
/** The `#N` that opens the row of `text` holding `marker`, null when that row opens with none. */
const numberOf = (text: string, marker: string): string | null => /^#\d+\b/.exec(rowWith(text, marker))?.[0] ?? null;
/** What follows the `<task>` of a request: the persona's answers and the results of the calls in a tool round. */
const afterTask = (request: string): string => request.split('</task>').slice(1).join('</task>');
/** How many times `marker` stands in `text`. */
const countOf = (text: string, marker: string): number => text.split(marker).length - 1;
describe('chat numbers of a reply turn', () => {
  before(() => {
    useIface('fake');
  });
  after(() => {
    useIface('discord');
  });

  test('a conversation.read around a number of the turn before reads the line that number named', async () => {
    // Bug: a number the persona carries into the next turn resolves through that turn's window, which has moved, so the read
    // opens on another line.
    let alpha = '#0';
    const run = await inRoom(() => [
      {
        lines: [ALPHA],
        trigger: BETA,
        answers: [
          (request: string): string => {
            alpha = numberOf(blockOf(request, 'chat'), REPLY_TURN_CHAT_NUMBERS_TEXT.alpha) ?? '#0';
            return SKIP;
          },
        ],
      },
      {
        trigger: GAMMA,
        answers: [
          (): unknown =>
            toolAnswer(REPLY_TURN_CHAT_NUMBERS_THINK, [
              call('conversation.read', { around: alpha, before: '0', after: '0' }),
            ]),
          SKIP,
        ],
      },
    ]);
    const result = afterTask(requestOf(run, 1, 1));
    assert.equal(countOf(result, REPLY_TURN_CHAT_NUMBERS_TEXT.alpha), 1, result);
    assert.equal(
      countOf(result, REPLY_TURN_CHAT_NUMBERS_TEXT.beta),
      0,
      'the read opened on the line the number named and no other'
    );
  });
});

// One handle per person and per place across the persona's request (spec 2026-11-10 one-handle-per-person-and-place, slice 2;
// contract .agents/docs/specs/2026-11-10-one-handle-contract.md). A person's handle comes from the meta-person, so the
// same handle stands for every account of the person on every interface; every line of every block names its author
// by that handle, a mention in a stored text reads as it, and the persona's own `@handle` mentions the person's account on the
// interface the persona writes to. A place reads as its handle and name wherever it is named, and no raw place id or account id
// reaches the request. Reply turns of the real turn runner over the service world's memory
// (tests/fixtures/service-turn.ts#replyRun), in the room `c1` of the fake interface and on the owner's command line, a
// scripted model, synthetic names in Greek.
//
// The facts are read off the request without its wording: an entry of `<people>` opens with the person's `@u…` handle,
// a place entry of `<places>` with its `#c…` handle, and the author of a line is every `@u…` token that stands on the
// line before its text.

const REPLY_TURN_HANDLES_MIN = 60_000;
const REPLY_TURN_HANDLES_THINK = '<think>STEP 4. So: answer.</think>';
const SAY = `${REPLY_TURN_HANDLES_THINK}<msg>εντάξει</msg>`;
const replyTurnHandlesIso = (at: number): string => new Date(at).toISOString();

const REPLY_TURN_HANDLES_NIKOS = 'person:fake:4242';
const GIANNIS = 'person:tele:88';
/** The texts of the world's lines, each unique so a test finds its line in one block. */
const REPLY_TURN_HANDLES_LINE = {
  ownerGarden: 'ΠΕΤΡΟΣ-ΣΤΟΝ-ΚΗΠΟ',
  ownerRoom: 'ΠΕΤΡΟΣ-ΣΤΟ-ΓΕΝΙΚΑ',
  ownerCli: 'ΠΟΙΟΣ-ΕΓΡΑΨΕ-ΣΤΟΝ-ΚΗΠΟ',
  giannisHarbour: 'ΓΙΑΝΝΗΣ-ΣΤΟ-ΛΙΜΑΝΙ',
  eleniGarden: 'ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ',
  nikosOne: 'ΝΙΚΟΣ-ΑΠΟ-ΤΟ-ΕΝΑ',
  nikosTwo: 'ΝΙΚΟΣ-ΑΠΟ-ΤΟ-ΔΥΟ',
} as const;
/** The name the owner's command line account carries, and the one the owner's account on the fake interface carries. */
const OWNER_CLI_NAME = 'ΠΕΤΡΟΣ-ΚΟΝΣΟΛΑ';
const OWNER_FAKE_NAME = 'Πέτρος';

/**
 * The service world, with the owner holding an account on the command line and one on the fake interface, the owner's line in
 * the garden `c2` right after the persona's, and Γιάννης, who has an account on `tele` alone and wrote in the harbour `k1` right
 * after the persona's line there. Ελένη's line before the persona's in the garden mentions nobody; the owner's mentions Ελένη.
 */
function handleWorld(): World {
  const world = serviceWorld();
  addPerson(world.db, {
    id: OWNER_PERSON,
    accounts: [
      { id: 'cli:owner', iface: 'cli', native: 'owner', names: [OWNER_CLI_NAME] },
      { id: 'fake:u1', iface: 'fake', native: 'u1', names: [OWNER_FAKE_NAME] },
    ],
  });
  addDm(world.db, { iface: 'cli', native: 'owner', person: OWNER_PERSON, account: 'cli:owner' });
  addLine(world.db, {
    id: 'o1',
    iface: 'fake',
    place: 'fake:channel:c2',
    author: 'fake:u1',
    text: `${REPLY_TURN_HANDLES_LINE.ownerGarden} <@111>`,
    at: replyTurnHandlesIso(TURN_NOW - 49 * REPLY_TURN_HANDLES_MIN),
  });
  addPerson(world.db, { id: GIANNIS, accounts: [{ id: 'tele:88', iface: 'tele', native: '88', names: ['Γιάννης'] }] });
  addLine(world.db, {
    id: 'y1',
    iface: 'tele',
    place: 'tele:channel:k1',
    author: 'tele:88',
    text: REPLY_TURN_HANDLES_LINE.giannisHarbour,
    at: replyTurnHandlesIso(TURN_NOW - 39 * REPLY_TURN_HANDLES_MIN),
  });
  addPerson(world.db, {
    id: REPLY_TURN_HANDLES_NIKOS,
    accounts: [
      { id: 'fake:4242', iface: 'fake', native: '4242', names: ['Νίκος'] },
      { id: 'fake:4243', iface: 'fake', native: '4243', names: ['Νικόλαος'] },
    ],
  });
  return world;
}

/** The owner's line on the command line. */
const ownerSays = (id: string, text: string, at: number) => ({ id, text, at, authorId: 'owner', authorName: 'owner' });

/** Reply turns on the owner's command line over a fresh handle world. */
async function onCli(steps: ReadonlyArray<ReplyStep>): Promise<ReplyRun> {
  const world = handleWorld();
  try {
    return await replyRun({ world, chat: CLI_CHAT, steps });
  } finally {
    world.close();
  }
}

/** The user text of request `step` of turn `turn` of a run, '' when there is none. */
const replyTurnHandlesRequestOf = (run: ReplyRun, turn: number, step: number): string => {
  const requests = run.requests[turn] ?? [];
  return requests[step] ?? '';
};

/** The bodies of every `<people>` of a text: the request's own and the one a read result carries. */
const peopleBodies = (text: string): Array<string> =>
  [...text.matchAll(/<people>\n?([\s\S]*?)\n?<\/people>/g)].map((match) => match[1] ?? '');

/** The entries of every `<people>` of a text, one text each. */
const entriesOf = (text: string): Array<string> =>
  peopleBodies(text).flatMap((body) => body.split(/\n\s*\n/).filter((entry) => entry.trim() !== ''));

/** The `@u…` handle an entry opens with, null when its first line holds none. */
const entryHandle = (entry: string): string | null => /@u[0-9a-z]+/.exec(entry.split('\n')[0] ?? '')?.[0] ?? null;

/** The handles of every entry of every `<people>` of a text. */
const entryHandles = (text: string): Array<string> =>
  entriesOf(text).flatMap((entry) => {
    const handle = entryHandle(entry);
    return handle === null ? [] : [handle];
  });

/** The line of `text` that holds `marker`, '' when none does. */
const lineWith = (text: string, marker: string): string => text.split('\n').find((line) => line.includes(marker)) ?? '';

/** The part of a line before `marker`: its number, time and author. */
const headOf = (text: string, marker: string): string => {
  const line = lineWith(text, marker);
  return line.slice(0, Math.max(0, line.indexOf(marker)));
};

/** The `@u…` handles that stand on the line of `marker` before it: the line's author. */
const authorOf = (text: string, marker: string): Array<string> => headOf(text, marker).match(/@u[0-9a-z]+/g) ?? [];

/** What follows the `<task>` of a request: the persona's answer and the results of the calls in a tool round. */
const replyTurnHandlesAfterTask = (request: string): string => request.split('</task>').slice(1).join('</task>');

/**
 * The `#c…` handle of the place entry of `<places>` whose heading holds `name` in quotes.
 * A place reads as the interface's noun and the quoted name, `#c…: channel "name", ...`.
 */
function placeHandle(request: string, name: string): string {
  const places = /<places>\n?([\s\S]*?)\n?<\/places>/.exec(request)?.[1] ?? '';
  const entry = places.split(/\n\s*\n/).find((one) => (one.split('\n')[0] ?? '').includes(`"${name}"`)) ?? '';
  return /#c[0-9a-z]+/.exec(entry)?.[0] ?? '';
}

/** A turn on the command line in which the persona reads the garden by its name, finding the owner's line, then answers. */
const READ_GARDEN: ReplyStep = {
  trigger: ownerSays('m1', REPLY_TURN_HANDLES_LINE.ownerCli, TURN_NOW - 3 * REPLY_TURN_HANDLES_MIN),
  answers: [toolAnswer(REPLY_TURN_HANDLES_THINK, [call('conversation.read', { place: 'κήπος', last: 10 })]), SAY],
};
describe('handles of a reply turn', () => {
  before(() => {
    useIface('fake');
  });
  after(() => {
    useIface('discord');
  });

  test('every author of a line of a stored place read is the handle of an entry of the request', async () => {
    // Bug: a place read names its authors by the stored display name, so the lines the persona read tie to nobody the persona knows.
    const run = await onCli([READ_GARDEN]);
    const request = replyTurnHandlesRequestOf(run, 0, 1);
    const result = replyTurnHandlesAfterTask(request);
    assert.ok(result.includes(REPLY_TURN_HANDLES_LINE.ownerGarden), 'the read returned the owner line');
    const handles = entryHandles(request);
    for (const marker of [REPLY_TURN_HANDLES_LINE.ownerGarden, REPLY_TURN_HANDLES_LINE.eleniGarden]) {
      const author = authorOf(result, marker);
      assert.equal(author.length, 1, `the line ${marker} names one handle`);
      assert.ok(handles.includes(author[0] ?? ''), `the author of ${marker} opens an entry`);
    }
  });

  test('the source line of a place read names the place by its handle and its name', async () => {
    // Bug: the source line names the place by its name alone, so the read ties to no entry of <places>.
    const run = await onCli([READ_GARDEN]);
    const request = replyTurnHandlesRequestOf(run, 0, 1);
    const garden = placeHandle(request, 'κήπος');
    assert.match(garden, /^#c[0-9a-z]+$/, 'the garden has an entry with a handle');
    const source = lineWith(replyTurnHandlesAfterTask(request), 'conversation.read');
    assert.ok(source.includes(garden) && source.includes('κήπος'), source);
  });
});

// Names shown without emoji (spec 2026-11-12 names-across-scripts, slice 2): a request that shows the name of a place or
// of a person leaves the emoji of the name out, and shows them when `context.names.emoji` is `true`. Reply turns of the
// real turn runner over a small world whose names carry emoji (tests/fixtures/service-turn.ts#replyRun), a scripted
// model, made-up names. The stored name is the world's row and stays as written.
//
// The setting travels as `config.context.names.emoji`: `replyRun({ context: { names: { emoji: true } } })` lays it over
// the rig's `context`, and the request builder reads it from the config it is given at each request.

const REQUEST_NAMES_EMOJI_MIN = 60_000;
const REQUEST_NAMES_EMOJI_THINK = '<think>STEP 4. So: answer.</think>';
const REQUEST_NAMES_EMOJI_SAY = `${REQUEST_NAMES_EMOJI_THINK}<msg>εντάξει</msg>`;
const requestNamesEmojiIso = (at: number): string => new Date(at).toISOString();
const EMOJI = /\p{Extended_Pictographic}/u;

/** A room with a leading emoji, a garden with one between its words, a person whose names and alias carry emoji. */
function emojiWorld(): World {
  const world = openWorld();
  noteInterface(world, 'fake', [{ id: 'g1', name: 'Αγορά' }]);
  const room = addRoom(world.db, { iface: 'fake', native: 'c1', root: rootId('fake', 'g1'), name: '🌿 γενικά' });
  const garden = addRoom(world.db, {
    iface: 'fake',
    native: 'c2',
    root: rootId('fake', 'g1'),
    name: 'ωραίος 🌱 κήπος',
  });
  addPerson(world.db, {
    id: 'person:fake:111',
    accounts: [{ id: 'fake:111', iface: 'fake', native: '111', names: ['🍀 Ελένη', 'Ελένη 🍀 Λένα'] }],
  });
  addClaim(world.db, {
    id: 'claim:alias:111',
    person: 'person:fake:111',
    kind: 'alias',
    text: '🌟 Ελενάκι',
    audience: { group: 'fake' },
  });
  addLine(world.db, {
    id: 'r1',
    iface: 'fake',
    place: room,
    author: 'fake:111',
    text: 'ΓΡΑΜΜΗ-ΔΩΜΑΤΙΟΥ',
    at: requestNamesEmojiIso(TURN_NOW - 5 * REQUEST_NAMES_EMOJI_MIN),
  });
  addLine(world.db, {
    id: 'g0',
    iface: 'fake',
    place: garden,
    author: 'fake:111',
    text: 'ΓΡΑΜΜΗ-ΚΗΠΟΥ',
    at: requestNamesEmojiIso(TURN_NOW - 51 * REQUEST_NAMES_EMOJI_MIN),
  });
  return world;
}

/** The `#c…` handle of the entry of `<places>` that holds `word`. */
function requestNamesEmojiPlaceHandle(request: string, word: string): string {
  const places = blockOf(blockOf(request, 'memory'), 'places');
  const entry = places.split(/\n\s*\n/).find((one) => (one.split('\n')[0] ?? '').includes(word)) ?? '';
  return /#c[0-9a-z]+/.exec(entry)?.[0] ?? '';
}

/** Two turns in the room: the persona reads the garden by its handle in the first, the second shows the read in `<recall>`. */
async function run(emoji: boolean | undefined): Promise<{ first: string; read: string }> {
  const world = emojiWorld();
  try {
    const out = await replyRun({
      world,
      ...(emoji === undefined ? {} : { context: { names: { emoji } } }),
      steps: [
        {
          trigger: { id: 'r2', text: 'τι έγινε στον κήπο;', at: TURN_NOW - 3 * REQUEST_NAMES_EMOJI_MIN },
          answers: [
            (request: string) =>
              toolAnswer(REQUEST_NAMES_EMOJI_THINK, [
                call('conversation.read', { place: requestNamesEmojiPlaceHandle(request, 'κήπος'), last: 10 }),
              ]),
            REQUEST_NAMES_EMOJI_SAY,
          ],
        },
      ],
    });
    const requests = out.requests[0] ?? [];
    return { first: requests[0] ?? '', read: requests[1] ?? '' };
  } finally {
    world.close();
  }
}

const hidden = run(undefined);

/** The line of `text` that holds `marker`. */
const requestNamesEmojiLineWith = (text: string, marker: string): string =>
  text.split('\n').find((line) => line.includes(marker)) ?? '';
describe('emoji names of a request', () => {
  before(() => {
    useIface('fake');
  });
  after(() => {
    useIface('discord');
  });

  test('a name with an emoji between two words keeps both words and one space in the source line of a read', async () => {
    // Bug: the source line of a read names the place by its stored name, and the emoji stands in it.
    const { read } = await hidden;
    const source = requestNamesEmojiLineWith(read.split('</task>').slice(1).join('</task>'), 'conversation.read');
    assert.ok(source.includes('"ωραίος κήπος"'), source);
    assert.doesNotMatch(source, EMOJI);
  });
});

// conversation.read in a turn (features.coreTools, src/behavior/turn.ts): the persona's call reads a channel
// from the record first and the interface's history when the record lacks the span, the lines
// carry handles that resolve in the next steps (message calls, before=/around= paging), a channel
// the pull rail hides is refused. Over a real admin and the fake interface adapter; no network.

const TURN_CONVERSATION_READ_NOW = Date.parse('2026-10-17T12:00:00Z');
const TURN_CONVERSATION_READ_HOUR = 3_600_000;
const { tools: toolsValue3 } = labels.tools;
const TURN_CONVERSATION_READ_L = {
  ...labels,
  tools: {
    ...labels.tools,
    tools: {
      ...toolsValue3,
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

function rawMessage({
  id,
  authorId = 'u1',
  authorName = 'Alice',
  ts = TURN_CONVERSATION_READ_NOW - 1000,
  content = 'hey bot',
  placeId = 'c1',
}: {
  id: string;
  authorId?: string;
  authorName?: string;
  ts?: number;
  content?: string;
  placeId?: string;
}) {
  return {
    id,
    placeId,
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

function normalizedTrigger(raw: ReturnType<typeof rawMessage>) {
  return {
    id: raw.id,
    placeId: raw.placeId,
    authorId: raw.author.id,
    authorName: raw.author.globalName,
    self: false,
    bot: false,
    content: raw.cleanContent,
    ts: raw.createdTimestamp,
    replyToId: null,
    attachments: [],
    stickers: [],
  };
}

/**
 * The server: #general (c1, the turn's), #jardin (c2, readable), #secret (c3, the bot cannot read it), in the world of
 * the test. `fetches` lists the history reads made of each.
 */
function fakeServer(history: Array<Record<string, unknown>>, jardinLive: Array<Record<string, unknown>> = []) {
  const fetches: Record<string, Array<unknown>> = { c1: [], c2: [], c3: [] };
  turnConversationReadWorld().tap('history', ([ref, query]) => {
    fetches[(ref as { chatId: string }).chatId]?.push(query);
  });
  const channels = new Map([
    ['c1', turnConversationReadWorld().channel({ id: 'c1', name: 'general', placeId: 'g1', historyMessages: history })],
    [
      'c2',
      turnConversationReadWorld().channel({ id: 'c2', name: 'jardin', placeId: 'g1', historyMessages: jardinLive }),
    ],
    [
      'c3',
      turnConversationReadWorld().channel({ id: 'c3', name: 'secret', placeId: 'g1', permissions: { read: false } }),
    ],
  ]);
  return { channels, fetches };
}

function fakeStore() {
  const profiles = [{ id: 'u7', names: ['Éloïse'] }];
  return {
    getPlace: () => ({}),
    getUser: (id: string) => profiles.find((profile) => profile.id === id) ?? null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => profiles,
    countUsers: () => profiles.length,
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
    state: { data: {}, markDirty() {} },
  };
}

function hotWith(allowed: Array<string>, features: Record<string, unknown>) {
  return {
    config: {
      bot: {
        timezone: 'UTC',
        dryRunChannelId: '',
        owners: ['u1'],
        access: Object.fromEntries(allowed.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }])),
      },
      context: {
        channelMessages: 100,
        neighborMessages: 5,
        neighborMaxAgeMinutes: 60,
        neighborMaxChannels: 8,
        maxMessageChars: 800,
        gapMarkerMinutes: 20,
        otherProfiles: 6,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: {
          maxImages: 2,
          tokensPerImage: 400,
          imageSize: 512,
          recentImages: 0,
          recentImageMinutes: 0,
          maxBytes: 1_500_000,
          fetchTimeoutMs: 10_000,
        },
        pull: { scanMessages: 20, maxChannels: 1, sameAudience: false },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: {
        memory: true,
        reactions: true,
        multiMessage: true,
        typingSimulation: false,
        vision: false,
        callMarkers: true,
        coreTools: true,
        record: true,
        ...features,
      },
      models: { routes: chainsOf({ analyzer: 'x/text' }) },
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      gifs: { maxPerDay: 40 },
      tools: {
        safeMode: false,
        resultMaxChars: 2000,
        callTimeoutMs: 120000,
        loop: { maxSteps: 4, timeBudgetMs: 20000, maxCallsPerStep: 4 },
      },
    },
    prompts: {
      main: 'You are a regular member of this chat, not an assistant.',
      persona: 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      'turn/reply': 'Someone called you: {{author}}.',
      interject: 'Jump into the chat.',
      initiate: 'Start a topic.',
      lookup: 'Decide whether {{name}} needs to look something up.',
      labels: TURN_CONVERSATION_READ_L,
    },
  };
}

function sequenceLlm(answers: Array<unknown>) {
  const calls: Array<Array<{ role: string; content: unknown }>> = [];
  return {
    calls,
    complete: async (messages: Array<{ role: string; content: string }>) => {
      const { content } = messages[0];
      if (content.startsWith('Decide whether') || content.startsWith('Pick a second look'))
        return { text: 'none', usage: {}, estimated: 5 };
      calls.push(messages);
      return completionOf(answers[Math.min(calls.length - 1, answers.length - 1)]);
    },
  };
}

/** A record line of channel `channel`, `hoursAgo` before NOW. */
function turnConversationReadLine(
  id: string,
  hoursAgo: number,
  text: string,
  {
    channel = 'c2',
    kind = 'seen',
    by = 'u7',
    revision = 1,
  }: { channel?: string; kind?: string; by?: string; revision?: number } = {}
) {
  const at = new Date(TURN_CONVERSATION_READ_NOW - hoursAgo * TURN_CONVERSATION_READ_HOUR).toISOString();
  return {
    kind,
    messageId: id,
    revision,
    occurredAt: at,
    recordedAt: at,
    scope: { channel },
    ...(kind === 'said' ? {} : { by }),
    text,
    media: [],
    mentions: [],
  };
}

function turnConversationReadFakeRecord(lines: Array<Record<string, unknown>>) {
  const reads: Array<{ placeIds?: Array<string>; from?: string }> = [];
  return {
    reads,
    append: async () => ({ written: 0, duplicates: 0 }),
    iterate: async function* iterate(placeId: string, query: { placeIds?: Array<string>; from?: string }) {
      reads.push(query);
      for (const entry of lines) {
        if (query.placeIds && !query.placeIds.includes((entry.scope as { channel: string }).channel)) continue;
        if (query.from && Date.parse(entry.occurredAt as string) < Date.parse(query.from)) continue;
        yield entry;
      }
    },
  };
}

const JARDIN = [
  turnConversationReadLine('q0', 6, 'παλιότερη γραμμή'),
  turnConversationReadLine('q2', 5, 'ξένο κείμενο'),
  turnConversationReadLine('q1', 4, 'παλιό κείμενο', { kind: 'said' }),
  turnConversationReadLine('q3', 3, 'πριν την αλλαγή'),
  turnConversationReadLine('q3', 3, 'μετά την αλλαγή', { revision: 2 }),
  turnConversationReadLine('q4', 2, 'θα διαγραφεί'),
  {
    kind: 'deleted',
    messageId: 'q4',
    occurredAt: new Date(TURN_CONVERSATION_READ_NOW - 2 * TURN_CONVERSATION_READ_HOUR).toISOString(),
    scope: { channel: 'c2' },
    participants: ['u7'],
  },
  turnConversationReadLine('q5', 1, 'η τελευταία'),
];

/** One mention in #general answered with `answers` in turn; `record` and `jardinLive` are what the record and the history of #jardin hold. */
async function turn({
  answers,
  allowed = ['conversation.read'],
  record = turnConversationReadFakeRecord(JARDIN),
  jardinLive = [],
  features = {},
  seeds = [],
  memoryContext,
}: {
  answers: Array<unknown>;
  allowed?: Array<string>;
  record?: ReturnType<typeof turnConversationReadFakeRecord>;
  jardinLive?: Array<Record<string, unknown>>;
  features?: Record<string, unknown>;
  seeds?: Array<{ chatId: string; authorId: string; messageId: string; text: string }>;
  memoryContext?: ReturnType<typeof issueContext>;
}) {
  const history = [
    rawMessage({
      id: 'm0',
      ts: TURN_CONVERSATION_READ_NOW - 5000,
      authorId: 'u2',
      authorName: 'Zoë',
      content: 'καλημέρα',
    }),
    rawMessage({ id: 'm1', content: 'διάβασε το jardin' }),
  ];
  const hot = hotWith(allowed, features);
  const server = fakeServer(history, jardinLive);
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => TURN_CONVERSATION_READ_NOW });
  for (const seed of seeds) port.seed(seed.chatId, seed);
  const client = { user: { id: 'self-id', username: 'Bot' } };
  const store = fakeStore();
  const admin = createAdmin({
    hot,
    store,
    client,
    isServedRoot: (id: unknown) => id === 'g1',
    reads: turnConversationReadWorld().adopt(port),
    port,
  });
  const llm = sequenceLlm(answers);
  const calibrator = { ratio: 1, apply: (value: number) => value, observe: () => {} };
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator,
    now: () => TURN_CONVERSATION_READ_NOW,
    port,
    skills: skillRegistry(),
    journal: null,
    record,
    runOp: admin.runSkillOp,
    runOwnOp: admin.runOwnSkillOp,
  });
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({
      channel: server.channels.get('c1'),
      mode: 'reply',
      trigger: normalizedTrigger(history[1]),
      triggerKind: 'mention',
      ...(memoryContext === undefined ? {} : { memoryContext }),
    })
  );
  return { result, logs, llm, port, server, record };
}

/** What the persona read of the calls in request `i`: the content of each tool message, in order. */
const toolReads = (llm: { calls: Array<Array<{ role: string; content: unknown }>> }, i: number) => {
  const request = llm.calls[i];
  return request
    .filter((message) => message.role === 'tool')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : (message.content as Array<{ text: string }>).map((part) => part.text).join('')
    );
};
const requestText = (llm: { calls: Array<Array<{ role: string; content: unknown }>> }, i: number) =>
  toolReads(llm, i).join('\n');
const turnConversationReadHandleOf = (text: string, needle: string) =>
  Number(new RegExp(`^#(\\d+) .*${needle}`, 'm').exec(text)?.[1]);
describe('conversation reads in a turn', () => {
  before(() => {
    useIface('fake');
  });
  after(() => {
    useIface('discord');
  });

  test('conversation.read in a turn: the channel comes from the record with the edit and deletion marks, nothing is fetched from the history', async () => {
    const run = await turn({
      answers: [toolAnswer('', [call('conversation.read', { place: 'jardin', last: 6 })]), '<skip/>'],
    });
    const text = requestText(run.llm, 1);
    const { result } = labels.tools;
    assert.ok(text.startsWith(result.ok), text);
    assert.ok(text.includes('from conversation.read #jardin'), text);
    assert.ok(text.includes('lines carry message numbers'), text);
    assert.match(text, /^#\d+ \[\d\d:\d\d\] Éloïse: μετά την αλλαγή \(edited\)$/m);
    assert.ok(
      !text.includes('πριν την αλλαγή') && !text.includes('θα διαγραφεί'),
      'the newest revision stands, a deleted text is gone'
    );
    assert.match(text, /Éloïse: message deleted/);
    assert.ok(text.includes('earlier: before=#'), text);
    const { fetches } = run.server;
    assert.deepEqual(fetches.c2, [], 'the record held the span');
  });

  test('handles: a line the persona read is a message the persona can edit or page from in the next steps, in its own channel', async () => {
    const probe = await turn({
      answers: [toolAnswer('', [call('conversation.read', { place: 'jardin', last: 6 })]), '<skip/>'],
    });
    const probeText = requestText(probe.llm, 1);
    const mine = turnConversationReadHandleOf(probeText, 'παλιό κείμενο');
    const theirs = turnConversationReadHandleOf(probeText, 'ξένο κείμενο');
    const first = turnConversationReadHandleOf(probeText, 'ξένο κείμενο');
    assert.ok(mine > 3 && theirs === mine - 1, `numbered past the chat: ${mine} ${theirs}`);
    const run = await turn({
      answers: [
        toolAnswer('', [call('conversation.read', { place: 'jardin', last: 6 })]),
        toolAnswer(``, [
          call('message.edit', { message: `#${mine}`, text: `νέο κείμενο` }),
          call('conversation.read', { before: `#${first}`, last: 2 }),
        ]),
        '<skip/>',
      ],
      allowed: ['conversation.read', 'message.edit'],
      seeds: [{ chatId: 'c2', authorId: 'self-id', messageId: 'q1', text: 'παλιό κείμενο' }],
    });
    const { calls } = run.port;
    const edits = calls
      .filter((call) => call.op === 'edit')
      .map((call) => {
        const [target, body] = call.args as [{ chatId: string; messageId: string }, { text: string }];
        return [target.chatId, target.messageId, body.text];
      });
    assert.deepEqual(edits, [['c2', 'q1', 'νέο κείμενο']]);
    const third = requestText(run.llm, 2);
    const blocks = toolReads(run.llm, 2).filter((content: string) => content.includes('from conversation.read'));
    assert.equal(blocks.length, 2, 'both reads are in the continuation');
    assert.ok(blocks[1].includes('παλιότερη γραμμή') && !blocks[1].includes('ξένο κείμενο'), blocks[1]);
    assert.ok(blocks[1].includes('from conversation.read #jardin'), 'before= resolved to the channel of the line');
  });

  test('around a transcript number: #N of the chat the persona sees names the message and the channel, read from the record', async () => {
    const record = turnConversationReadFakeRecord([
      turnConversationReadLine('m0', 5000 / TURN_CONVERSATION_READ_HOUR, 'καλημέρα', { channel: 'c1', by: 'u2' }),
      turnConversationReadLine('m9', 3000 / TURN_CONVERSATION_READ_HOUR, 'μετά', { channel: 'c1', by: 'u2' }),
    ]);
    const run = await turn({
      answers: [toolAnswer('', [call('conversation.read', { around: '#1', before: '0', after: '3' })]), '<skip/>'],
      record,
    });
    const text = requestText(run.llm, 1);
    const { result } = labels.tools;
    assert.ok(text.startsWith(result.ok), text);
    assert.ok(
      text.includes('from conversation.read #general') && text.includes('καλημέρα') && text.includes('μετά'),
      text
    );
  });

  test('the record lacks the span: the history of the channel is asked and its lines come back with handles', async () => {
    const jardinLive = [
      rawMessage({
        id: 'h1',
        ts: TURN_CONVERSATION_READ_NOW - 2 * TURN_CONVERSATION_READ_HOUR,
        authorId: 'u7',
        authorName: 'Éloïse',
        content: 'από το ιστορικό',
        placeId: 'c2',
      }),
    ];
    const run = await turn({
      answers: [toolAnswer('', [call('conversation.read', { place: 'jardin', last: 3 })]), '<skip/>'],
      record: turnConversationReadFakeRecord([]),
      jardinLive,
    });
    const { fetches } = run.server;
    assert.deepEqual(fetches.c2, [{ limit: 3 }]);
    const text = requestText(run.llm, 1);
    assert.match(text, /^#\d+ \[\d\d:\d\d\] Éloïse: από το ιστορικό$/m);
  });

  test("the owner's internal turn reads a channel the pull rail hides from an ordinary turn", async () => {
    // Bug: the authenticated command line has all memory through search, yet this reader answers it with the live gate.
    const memoryContext = issueContext({
      kind: 'internal',
      newId: () => 'ctx:owner',
      now: () => TURN_CONVERSATION_READ_NOW,
    });
    // Named by its id: a name the bot cannot read is not among the places the persona may name (tests/src/tools/place-names.test.ts), so
    // only an id reaches the operation, whose rail this test is about.
    const run = await turn({
      answers: [toolAnswer('', [call('conversation.read', { place: 'c3', last: 3 })]), '<skip/>'],
      record: turnConversationReadFakeRecord([]),
      memoryContext,
    });
    const text = requestText(run.llm, 1);
    const { result } = labels.tools;
    const { result: resultValue } = labels.tools;
    assert.equal(text.startsWith(fill(result.refused, { reason: resultValue.reasons['channel-not-visible'] })), false);
  });

  test('a channel the pull rail hides is refused channel-not-visible and nothing of it is read', async () => {
    // Named by its id, for the same reason as above: the operation's rail judges an id, resolution judges a name.
    const run = await turn({
      answers: [toolAnswer('', [call('conversation.read', { place: 'c3', last: 3 })]), '<skip/>'],
    });
    const text = requestText(run.llm, 1);
    const { result } = labels.tools;
    const { result: resultValue } = labels.tools;
    assert.ok(
      text.startsWith(fill(result.refused, { reason: resultValue.reasons['channel-not-visible'] })),
      'a refusal is a result with its reason, no data'
    );
    assert.ok(!text.includes('from conversation.read'), text);
    const { fetches } = run.server;
    assert.deepEqual(fetches.c3, []);
    const { reads } = run.record;
    assert.ok(reads.every((query) => !query.placeIds?.includes('c3')));
    assert.ok(
      run.logs.some(
        (entry) =>
          entry.msg === 'skills: called' && entry.skill === 'conversation.read' && entry.code === 'channel-not-visible'
      )
    );
  });
});
