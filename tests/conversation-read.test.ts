// Tests for conversation.read (src/tools/conversation-read.ts): the selection of her arguments,
// the record reader, the runner over fakes (the three modes, the paging line, the interface's
// history when the record lacks the span, a hidden channel refused), and the registry rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/tools/operations/index.ts';
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
  // Slice 7: the tool argument `channel` is named `place`. Meta-person fault 2: `person` names a direct chat, which
  // has no place handle, so the spec's options gained it.
  assert.deepEqual(Object.keys(loose(skill).argsSchema.properties), [
    'place',
    'around',
    'before',
    'after',
    'since',
    'last',
    'person',
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
  const seedPlatform = (id: string, minute: number, text: string): void =>
    io.fake.seedEvent(eventOf(channel('c7'), id, PLACE_AT(minute), text, { authorId: 'u1', authorName: 'Eleni' }));
  /** The queries that reached the interface's history read, in order. */
  const historyQueries = (): Array<HistoryQuery> =>
    io.fake.calls.filter((call) => call.op === 'history').map((call) => call.args[1] as HistoryQuery);
  /** The number a read handed out for the line with `text`: her `#N`. */
  const numberOf = (text: string): number => {
    const found = [...(draft.searchRefs?.byNumber.entries() ?? [])].filter(([, ref]) =>
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
