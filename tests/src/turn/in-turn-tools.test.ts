import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHANNEL_HANDLE_PREFIX, HANDLE_DIGITS, handleOf } from '../../../src/behavior/handles.ts';
import { userText } from '../../../src/behavior/prompt.ts';
import { createRecall } from '../../../src/behavior/recall-run.ts';
import { snapshotOf } from '../../../src/behavior/snapshot.ts';
import { turnRoutes } from '../../../src/behavior/turn-ability-route.ts';
import { fill, formatDate } from '../../../src/format.ts';
import type { LinkAsk } from '../../../src/interface/person-link.ts';
import { frameReadsOver } from '../../../src/memory/db/frame-reads.ts';
import { channelPlaceId, dmPlaceId } from '../../../src/memory/db/ids.ts';
import { observationOf } from '../../../src/memory/db/observe-event.ts';
import { observe } from '../../../src/memory/db/observe.ts';
import type { NativeMessageLocator } from '../../../src/memory/db/recall.ts';
import { insertRows } from '../../../src/memory/db/rows.ts';
import {
  type Context,
  groupContext,
  internalContext,
  issueContext as issuedContext,
} from '../../../src/memory/db/scope.ts';
import { quantize } from '../../../src/memory/vectors.ts';
import { executeCall, type InTurnCall, resolveCall } from '../../../src/tools/executors.ts';
import '../../../src/tools/operations/index.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import { memorySearchText } from '../../../src/tools/tools.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { callViewOf, searchHandles } from '../../../src/turn/calls.ts';
import { createInTurnTools, type InTurnDraft } from '../../../src/turn/in-turn-tools.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { lineEvent } from '../../fixtures/core-over-fake.ts';
import { labels } from '../../fixtures/labels.ts';
import { countOf } from '../../fixtures/media-memory.ts';
import { noMediaNames } from '../../fixtures/media-namer.ts';
import { fixture } from '../../fixtures/memory-db-recall.ts';
import { fillEnvAudiences } from '../../fixtures/memory-db/audiences.ts';
import {
  addDm,
  addLine,
  addPerson,
  addRoom,
  AT,
  noteInterface,
  openWorld,
  rootId,
  type World,
} from '../../fixtures/memory-db/mind-world.ts';
import { personId } from '../../fixtures/memory-db/spelled-ids.ts';
import { channel, channel as channelInfo, message, privateChannel, rig, type Rig } from '../../fixtures/reads-rig.ts';
import { asRecord } from '../../fixtures/records.ts';
import {
  HEARTBEAT_TEXT,
  heartbeatWorld,
  replyRun,
  type ServiceRun,
  serviceTurn,
  serviceWake,
  serviceWorld,
  TURN_NOW,
} from '../../fixtures/service-turn.ts';
import { call, toolAnswer } from '../../fixtures/tool-answers.ts';
import { coreTurn, NOW as TURN_CORE_TOOLS_NOW, WEB_CONFIG } from '../../fixtures/turn-harness.ts';
import { useIface } from '../../fixtures/turn-world.ts';

const toolsLabels = labels.tools;
const L = {
  ...labels,
  tools: {
    ...labels.tools,
    tools: {
      ...toolsLabels.tools,
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

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

// A stored place read through the in-turn tools: the memory's lines, a line of which carries two ids as production rows
// do (`sources.native_id`, a uuid, and the platform's id in `extra.$messageLocator.messageId`), joined by the fake
// interface's history. Synthetic names.
const PLACE_NOW = Date.parse('2026-11-02T10:00:00.000Z');

const PLACE_AT = (minute: number): number => Date.parse('2026-11-02T09:00:00.000Z') + minute * 60_000;

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
  const hot = { config: FIND_CONFIG, prompts: { labels: FIND_LABELS } };
  const data = {};
  const store = {
    state: {
      get data() {
        return data;
      },
      markDirty() {},
    },
    listUserProfiles: () => [],
    mediaNameOf: noMediaNames,
  };
  const recall = createRecall({
    iface: 'discord',
    mediaNameOf: noMediaNames,
    reads: {
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

// A question about one day: a `since` read of a stored place,
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
  // back began at the newest hour and the persona read the wrong day.
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
  // the persona took them for the day they were asked about.
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
  // a line of the day the persona was asked about.
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
  // interface read as a source with an empty name and the persona could not tell which place they had read.
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

const DAY = 86400000;

const NOW = Date.parse('2026-10-24T12:00:00.000Z');

const BOB = 'u-bob';

function objectOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('tracked settings require an object');
  // The guard establishes an object whose settings are read by string keys.
  return value as Record<string, unknown>;
}

function runner(env: ReturnType<typeof fixture>) {
  fillEnvAudiences(env);
  insertRows(
    env.db,
    {
      places: [
        {
          id: channelPlaceId('discord', 'c1'),
          iface: 'discord',
          kind: 'channel',
          native_id: 'c1',
          scope_kind: 'group',
          name: 'general',
        },
        {
          id: channelPlaceId('discord', 'c4'),
          iface: 'discord',
          kind: 'channel',
          native_id: 'c4',
          scope_kind: 'group',
          name: 'secret',
        },
        {
          id: dmPlaceId('discord', BOB),
          iface: 'discord',
          kind: 'dm',
          native_id: null,
          scope_kind: 'dm',
          partner_person: personId('discord', BOB),
        },
      ],
    },
    { log: { info() {}, debug() {}, warn() {}, error() {} } }
  );
  const parsed: unknown = JSON.parse(fs.readFileSync(new URL('../../../config/config.json', import.meta.url), 'utf8'));
  const config = objectOf(parsed);
  config.bot = { ...objectOf(config.bot ?? {}), timezone: 'UTC' };
  config.features = { ...objectOf(config.features ?? {}), meaningSearch: false, recall: true };
  const models = objectOf(config.models ?? {});
  // Changed: a role's model is its chain's (spec 2026-11-09-model-routes, slice 4).
  config.models = {
    ...models,
    routes: { ...objectOf(models.routes ?? {}), ...chainsOf({ embedding: 'test/embedder' }) },
  };
  const channel = channelInfo('c1', { name: 'general' });
  const secret = { ...privateChannel('c4', []), name: 'secret' };
  const snapshot = snapshotOf('g1', { chats: [channel, secret], groups: [] });
  const labelsToolsLabels = labels.tools;
  const hot = {
    config,
    prompts: {
      labels: {
        ...labels,
        tools: {
          ...labels.tools,
          tools: { ...labelsToolsLabels.tools, memory: { ...labelsToolsLabels.tools.memory, hidden: 'ΚΡΥΦΟ-ΣΗΜΑ' } },
        },
      },
    },
  };
  const recaller = createRecall({
    mediaNameOf: noMediaNames,
    iface: 'discord',
    hot,
    // The DM partner `owner-42` has a stored person, which the store answers; no person is spelled from a member id.
    store: {
      state: { data: {}, markDirty() {} },
      listUserProfiles: () => [],
      personOfAccount: (account: string) => (account === 'owner-42' ? personId('discord', 'owner-42') : null),
    },
    llm: { capLeft: () => 100, complete: () => Promise.reject(new Error('quoted SQLite reads need no model')) },
    now: () => NOW,
    embed: null,
    memoryDb: { database: () => env.db },
  });
  return {
    recaller,
    hot,
    args: {
      placeId: 'g1',
      snapshot,
      channel,
      partnerId: null,
      selfId: 'self',
      selfName: 'Ζωή',
      history: [],
      candidate: { id: 'q', content: 'το σπιτι' },
    },
  };
}

function exclusionSource(
  env: ReturnType<typeof fixture>,
  {
    iface = 'fake',
    room,
    id = 'shared-visible',
    marker,
    dm = false,
    offset = 60_000,
    authority = `${iface}/${room}`,
  }: { iface?: string; room: string; id?: string; marker: string; dm?: boolean; offset?: number; authority?: string }
) {
  const event = lineEvent({
    id,
    chatId: room,
    authorId: 'owner-42',
    text: `το κουνέλι ${marker}`,
    at: NOW - DAY - offset,
  });
  event.iface = iface;
  event.chat = dm
    ? { id: room, kind: 'dm', rootId: null, partnerId: 'owner-42' }
    : { id: room, kind: 'channel', rootId: 'g1', name: room };
  const envelope = observationOf(event);
  if (!envelope) throw new Error('valid exclusion fixture was refused');
  envelope.authority = authority;
  envelope.place.authority = authority;
  const result = observe(env.handle, envelope, { now: () => NOW });
  assert.equal(result.ok, true);
  if (typeof result.sourceId !== 'string' || typeof result.placeId !== 'string')
    throw new Error('exclusion source identity missing');
  return {
    sourceId: result.sourceId,
    placeId: result.placeId,
    iface,
    native: { iface, chatId: room, messageId: id },
  };
}

test('the in-turn memory tool derives CLI history scope from its trusted chat reference', async () => {
  const env = fixture();
  try {
    const { createInTurnTools } = await import('../../../src/turn/in-turn-tools.ts');
    const { turnRoutes } = await import('../../../src/behavior/turn-ability-route.ts');
    const { rig } = await import('../../fixtures/reads-rig.ts');
    exclusionSource(env, { iface: 'cli', room: 'cli:dm:owner', marker: 'handler-own-731', dm: true });
    exclusionSource(env, { iface: 'other', room: 'foreign-dm', marker: 'handler-foreign-842', dm: true });
    env.stem();
    const s = runner(env);
    const memoryContext = issuedContext({ kind: 'internal', newId: () => 'ctx:handler-exclusion', now: () => NOW });
    const tools = createInTurnTools({
      hot: s.hot,
      store: { mediaNameOf: noMediaNames, listUserProfiles: () => [] },
      recall: s.recaller,
      lookup: undefined,
      describer: undefined,
      speech: null,
      record: null,
      routes: turnRoutes(s.hot, null),
      clock: () => NOW,
      ifaceReads: rig().reads,
      memberOf: () => null,
      chatOf: (channel) => ({ iface: 'cli', chatId: channel.id }),
      turnContextOf: () => memoryContext,
      linkCalls: (lines) => lines,
      drawTool: () => Promise.reject(new Error('memory reads do not draw')),
    });
    const handlers = tools.inTurnTools({
      channel: channelInfo('cli:dm:owner', { kind: 'dm', rootId: null, partnerId: 'owner-42', audience: null }),
      placeId: 'g1',
      selfId: 'self',
      selfName: 'Synthetic persona',
      history: [{ id: 'shared-visible', placeId: 'cli:dm:owner', content: 'το κουνέλι handler-own-731' }],
    });
    const found = await handlers['memory.search']({ terms: 'κουνέλι' });
    assert.equal(JSON.stringify(found).includes('handler-own-731'), false);
    assert.ok(JSON.stringify(found).includes('handler-foreign-842'));
  } finally {
    env.done();
  }
});

const THINK = '<think>STEP 4. So: do it.</think>';

const NIKOS = 'person:fake:4242';

const RELATION = 'ΦΙΛΟΣ-ΤΟΥ-ΨΑΡΕΜΑΤΟΣ';

const LINE = 'ΓΡΑΜΜΗ-ΣΤΟΝ-ΜΟΛΟ';

/** An intention turn nowhere whose one step reads `place` (a room's stored name), with `budgetTokens` laid over the memory's settings. */
async function readNowhere(place: string, budgetTokens?: number): Promise<ServiceRun> {
  const world = serviceWorld();
  const pier = addRoom(world.db, { iface: 'fake', native: 'c9', root: rootId('fake', 'g1'), name: 'μόλος' });
  addPerson(world.db, { id: NIKOS, accounts: [{ id: 'fake:4242', iface: 'fake', native: '4242', names: ['Νίκος'] }] });
  insertRows(world.db, {
    descriptions: [
      {
        id: 'd:nikos:r',
        subject_kind: 'person',
        subject_id: NIKOS,
        field: 'relationship',
        current_version: 'd:nikos:r:v1',
        scope_kind: 'group',
        scope_iface: 'fake',
      },
    ],
    description_versions: [
      {
        id: 'd:nikos:r:v1',
        description_id: 'd:nikos:r',
        text: RELATION,
        author: 'her',
        written_at: AT,
        chars: RELATION.length,
        origin: 'review',
      },
    ],
  });
  addLine(world.db, {
    id: 'p1',
    iface: 'fake',
    place: pier,
    author: 'fake:4242',
    text: LINE,
    at: new Date(TURN_NOW - 10 * 60_000).toISOString(),
  });
  const due = { id: '' };
  try {
    return await serviceTurn({
      world,
      wake: () =>
        serviceWake('intention_due', {
          items: [{ kind: 'intention_due', reason: 'due', intentionIds: [due.id], errandId: null }],
          intentions: [{ id: due.id, purpose: 'ΔΙΑΒΑΣΕ', dueAt: TURN_NOW - 60_000 }],
          chainId: due.id,
        }),
      seed: (service) => {
        const made = service.set({ purpose: 'ΔΙΑΒΑΣΕ', dueAt: TURN_NOW - 60_000, by: 'persona' }) as {
          intention?: { id: string };
        };
        due.id = made.intention?.id ?? '';
      },
      answers: [toolAnswer(THINK, [call('conversation.read', { place, last: 10 })]), '<skip/>'],
      chat: null,
      ...(budgetTokens === undefined ? {} : { settings: { budgetTokens } }),
    });
  } finally {
    world.close();
  }
}

/** The part of the second request after the line the read returned: the read's own result. */
function afterTheRead(run: ServiceRun): string {
  const told = run.requests[1] ?? '';
  const at = told.indexOf(LINE);
  assert.ok(at >= 0, told);
  return told.slice(at);
}

/** A heartbeat over the heartbeat world whose steps read the yard, where the listed Νίκος wrote, `reads` times. */
async function heartbeatReads(reads: number): Promise<ServiceRun> {
  const world = heartbeatWorld();
  try {
    return await serviceTurn({
      world,
      wake: serviceWake('heartbeat'),
      answers: [
        ...Array.from({ length: reads }, () =>
          toolAnswer(THINK, [call('conversation.read', { place: 'αυλή', last: 10 })])
        ),
        '<skip/>',
      ],
      chat: null,
    });
  } finally {
    world.close();
  }
}

/** The part of request `n` after the last line of the yard the read before it returned. */
function afterYardRead(run: ServiceRun, n: number): string {
  const told = run.requests[n] ?? '';
  const at = told.lastIndexOf(`${HEARTBEAT_TEXT.yardLine}-y2`);
  assert.ok(at >= (run.requests[n - 1] ?? '').length, told);
  return told.slice(at);
}

describe('reading what an author keeps in memory', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test("a read's author comes into the next step's memory with what the persona knows of them", async () => {
    // Bug: the lines the persona reads name their authors and nothing more, so the persona reads a room full of people they know and
    // remembers none of them until a later turn.
    const run = await readNowhere('μόλος');
    assert.equal((run.requests[0] ?? '').includes(RELATION), false, 'the first request did not know of the author');
    const result = afterTheRead(run);
    assert.match(result, /<memory>[\s\S]*Νίκος[\s\S]*<\/memory>/);
    assert.ok(result.includes(RELATION), result);
  });

  test("a read's authors stay within the memory budget, as a name when nothing more fits", async () => {
    // Bug: the authors of a long read pour every stored line about them into the result, past the memory budget.
    const run = await readNowhere('μόλος', 1);
    const result = afterTheRead(run);
    assert.match(result, /<memory>[\s\S]*Νίκος[\s\S]*<\/memory>/);
    assert.equal(result.includes(RELATION), false, 'the relation does not fit a budget of one token');
  });

  test("a person the request's memory already shows is not told again after a read", async () => {
    // Bug: every read repeats the people the request showed already, spending the budget twice on the same person.
    const run = await readNowhere('κήπος');
    const told = run.requests[1] ?? '';
    const at = told.indexOf('ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ', (run.requests[0] ?? '').length);
    assert.ok(at >= 0, told);
    assert.equal(/<memory>/.test(told.slice(at)), false, told.slice(at));
  });

  test("a heartbeat's read brings what memory holds about a person its list showed by one line", async () => {
    // Bug: the heartbeat's list of people marks everyone it names as shown, so a read in the persona's own time never tells what
    // memory holds about the people who wrote the lines.
    const run = await heartbeatReads(1);
    assert.equal(
      (run.requests[0] ?? '').includes(HEARTBEAT_TEXT.nikosRelationRest),
      false,
      'the list holds one sentence'
    );
    const result = afterYardRead(run, 1);
    assert.match(result, /<memory>[\s\S]*Νίκος[\s\S]*<\/memory>/);
    assert.ok(result.includes(HEARTBEAT_TEXT.nikosRelationRest), result);
  });

  test("a heartbeat's second read does not repeat the people its first read told", async () => {
    // Bug: every read of the heartbeat tells the same people again, spending the budget twice on them.
    const run = await heartbeatReads(2);
    assert.ok(afterYardRead(run, 1).includes(HEARTBEAT_TEXT.nikosRelationRest));
    assert.equal(afterYardRead(run, 2).includes('<memory>'), false, afterYardRead(run, 2));
  });

  test("a reply's read leaves out the person the request showed", async () => {
    // Bug: a read in a reply repeats the person the reply answers, whom the request already shows in full.
    const world = serviceWorld();
    try {
      const run = await replyRun({
        world,
        steps: [
          {
            trigger: { id: 'r1', text: 'ΔΙΑΒΑΣΕ-ΤΟΝ-ΚΗΠΟ', at: TURN_NOW - 60_000 },
            answers: [toolAnswer(THINK, [call('conversation.read', { place: 'κήπος', last: 10 })]), '<skip/>'],
          },
        ],
      });
      const [first = '', second = ''] = run.requests[0] ?? [];
      assert.ok(first.includes('Ελένη'), 'the request shows Ελένη');
      const at = second.indexOf('ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ', first.length);
      assert.ok(at >= 0, second);
      assert.equal(second.slice(at).includes('<memory>'), false, second.slice(at));
    } finally {
      world.close();
    }
  });
});

// The casts through `Parameters<typeof f>` hand a function a fake that carries only the fields the test reads.

/** The content of the tool message of call `n` (0-based) in request `i`: what the persona read of that call. */
function toolContent(llm: Untyped, i: number, n = 0) {
  const llmCall = llm.calls[i];
  const message = llmCall.filter((item: Untyped) => item.role === 'tool')[n];
  return typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? []).map((part: Untyped) => part.text ?? '').join('');
}

// The persona's in-turn tools: web.search and memory.search run inside the turn and come back in it,
// labelled by where they came from; a result is data, never a call.

/** A web lookup fake whose raw search answers one result with `text` as its snippet (null: nothing came back); its page reader answers `page`. */
function fakeLookup(
  text = 'Η Ana κέρδισε τον τελικό.',
  page = { ok: true, url: 'https://example.org/x', title: 'Σελίδα', text: 'Το κείμενο της σελίδας.', cut: false }
) {
  const searches: Array<{ placeId: Untyped; query: Untyped }> = [];
  const reads: Array<{ placeId: Untyped; url: Untyped }> = [];
  return {
    searches,
    reads,
    hasSearch: () => true,
    webCapLeft: () => 10,
    readLinks: async () => ({ reads: new Map(), newCount: 0 }),
    cachedReads: () => new Map(),
    search: async () => {
      throw new Error('the condensed search is never her tool');
    },
    searchResults: async (placeId: string, query: unknown) => {
      searches.push({ placeId, query });
      return text === null
        ? null
        : { query, results: [{ title: 'Un', url: 'https://www.example.com/1', site: 'example.com', snippet: text }] };
    },
    readPage: async (placeId: string, url: string) => {
      reads.push({ placeId, url });
      return page;
    },
  };
}

/** A recall runner fake: records each run and answers `quotes`. */
function fakeRecall(
  quotes = [
    {
      placeId: 'c2',
      channelName: 'jardin',
      startTs: TURN_CORE_TOOLS_NOW - 3 * 86_400_000,
      lines: '[09:00] Éloïse: ένα κουνέλι στον κήπο',
    },
  ]
) {
  const runs: Array<Untyped> = [];
  return {
    runs,
    available: () => true,
    run: async (args: unknown) => (runs.push(args), { text: null, stretch: null, people: [], quotes, stats: {} }),
  };
}

test('web.search in the loop: the query of the persona runs as written, the continuation carries the raw results under their source, the answer goes out', async () => {
  const lookup = fakeLookup();
  const run = await coreTurn({
    answers: [
      toolAnswer('<msg>μισό</msg>', [call('web.search', { goal: 'ποιος κέρδισε', query: 'τελικός 2026' })]),
      '<msg>η Ana</msg>',
    ],
    allowed: ['web.search'],
    features: { webLookup: true },
    config: WEB_CONFIG,
    runner: { lookup },
  } as unknown as Parameters<typeof coreTurn>[0]);
  assert.equal(asRecord(run.result).outcome, 'spoke');
  assert.deepEqual(
    lookup.searches.map((search) => search.query),
    ['τελικός 2026']
  );
  const runCalls = run.llm.calls;
  assert.equal(runCalls.length, 2);
  const labelsToolsLabels = labels.tools;
  const l = labelsToolsLabels.tools.web;
  const resultLabels = labels.tools.result;
  const expected = `${resultLabels.ok}\n${fill(l.source, { query: 'τελικός 2026' })}\n${fill(l.goal, { goal: 'ποιος κέρδισε' })}\n1. Un\nhttps://www.example.com/1\nexample.com\nΗ Ana κέρδισε τον τελικό.`;
  assert.equal(
    toolContent(run.llm, 1),
    expected,
    'the raw results under their source, as the tool message of the call'
  );
  assert.deepEqual(
    run.sends.map((send) => send.text),
    ['η Ana'],
    'what the persona wrote before reading the results was held'
  );
  assert.ok(
    run.logs.some((entry) => entry.msg === 'skills: called' && entry.skill === 'web.search' && entry.status === 'ok')
  );
  assert.ok(!JSON.stringify(run.logs).includes('τελικός'), 'never the query of the persona in the log');
});

test('web.read in the loop: a link the persona gives, or the link of a message #N they name, is read and comes back as the page text under its source', async () => {
  const lookup = fakeLookup();
  const run = await coreTurn({
    answers: [toolAnswer('', [call('web.read', { url: 'https://example.org/x' })]), '<msg>διάβασα</msg>'],
    allowed: ['web.read'],
    features: { webLookup: true },
    config: WEB_CONFIG,
    runner: { lookup },
  } as unknown as Parameters<typeof coreTurn>[0]);
  assert.equal(asRecord(run.result).outcome, 'spoke');
  assert.deepEqual(
    lookup.reads.map((read) => read.url),
    ['https://example.org/x']
  );
  const labelsToolsLabels = labels.tools;
  const r = labelsToolsLabels.tools.read;
  const resultLabels = labels.tools.result;
  const expected = `${resultLabels.ok}\n${fill(r.source, { url: 'https://example.org/x', maxChars: '4000' })}\n${fill(r.title, { title: 'Σελίδα' })}\nΤο κείμενο της σελίδας.`;
  assert.equal(toolContent(run.llm, 1), expected);
  assert.ok(!JSON.stringify(run.logs).includes('example.org/x'), 'never the link in the log');

  const byMessage = fakeLookup();
  const viaMessage = await coreTurn({
    content: 'δες https://exemple.fr/άρθρο',
    answers: [toolAnswer('', [call('web.read', { message: '#2' })]), '<msg>ok</msg>'],
    allowed: ['web.read'],
    features: { webLookup: true },
    config: WEB_CONFIG,
    runner: { lookup: byMessage },
  } as unknown as Parameters<typeof coreTurn>[0]);
  assert.equal(asRecord(viaMessage.result).outcome, 'spoke');
  assert.equal(
    byMessage.reads.length,
    1,
    JSON.stringify(viaMessage.logs.filter((entry) => entry.msg === 'skills: called'))
  );
  const firstRead = byMessage.reads[0];
  assert.ok(firstRead.url.startsWith('https://exemple.fr/'), firstRead.url);
});

test('memory.search in the loop: the recall runner gets the arguments of the persona over the turn history, the messages come back quoted', async () => {
  const recall = fakeRecall();
  const run = await coreTurn({
    answers: [
      toolAnswer('', [
        call('memory.search', { people: 'Éloïse', when: '2026-09-01..2026-10-16', question: 'τι είπε για το κουνέλι' }),
      ]),
      '<msg>για τον κήπο</msg>',
    ],
    allowed: ['memory.search'],
    features: { recall: true },
    config: WEB_CONFIG,
    runner: { recall },
  } as unknown as Parameters<typeof coreTurn>[0]);
  assert.equal(recall.runs.length, 1);
  const [args] = recall.runs;
  assert.deepEqual(
    args.history.map((line: Untyped) => line.id),
    ['m0', 'm1'],
    'the chat the persona sees is left out of the hits'
  );
  assert.deepEqual(args.server.who, ['éloïse']);
  assert.deepEqual(args.server.forms, ['κουνέλι']);
  assert.deepEqual([args.server.from, args.server.to], [Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 17) - 1]);
  const text = toolContent(run.llm, 1);
  const labelsToolsLabels = labels.tools;
  const l = labelsToolsLabels.tools.memory;
  assert.ok(
    text.endsWith(
      `${l.source}\n${fill(l.window, { date: '2026-10-14', channel: 'jardin' })}\n[09:00] Éloïse: ένα κουνέλι στον κήπο`
    ),
    text
  );
  assert.deepEqual(
    run.sends.map((send) => send.text),
    ['για τον κήπο']
  );
});

test('memory.search handles: a quoted line carries a #N that message.edit resolves in the next step and in a later one, to its channel and id', async () => {
  const mine = { id: 'q1', authorId: 'self-id', self: true, content: 'παλιό κείμενο' };
  const theirs = { id: 'q2', authorId: 'u7', self: false, content: 'ξένο' };
  const entries = [
    { id: 'q2', text: '[09:00] Éloïse: ένα κουνέλι', authorId: 'u7', self: false, message: theirs },
    { id: 'q1', text: '[09:01] Bot: παλιό κείμενο', authorId: 'self-id', self: true, message: mine },
  ];
  const recall = fakeRecall([
    { placeId: 'c2', channelName: 'jardin', startTs: TURN_CORE_TOOLS_NOW - 3 * 86_400_000, lines: 'ignored', entries },
  ] as unknown as Parameters<typeof fakeRecall>[0]);
  const probe = await coreTurn({
    answers: [toolAnswer('', [call('memory.search', { question: 'κουνέλι' })]), '<skip/>'],
    allowed: ['memory.search'],
    features: { recall: true },
    config: WEB_CONFIG,
    runner: { recall },
  } as unknown as Parameters<typeof coreTurn>[0]);
  const second = toolContent(probe.llm, 1);
  const handles = [...second.matchAll(/^#(\d+) \[09:0[01]\] /gm)].map((match) => Number(match[1]));
  assert.equal(handles.length, 2, second);
  assert.equal(handles[1], handles[0] + 1);
  assert.ok(handles[0] > 3, 'numbered on past the chat');
  const labelsToolsLabels = labels.tools;
  const labelsToolsLabelsMemory = labelsToolsLabels.tools.memory;
  assert.ok(second.includes(labelsToolsLabelsMemory.handles), second);
  const [theirsN, mineN] = handles;
  const run = await coreTurn({
    answers: [
      toolAnswer('', [call('memory.search', { question: 'κουνέλι' })]),
      toolAnswer(``, [call('message.edit', { message: `#${mineN}`, text: `νέο κείμενο` }), call('lore.list')]),
      toolAnswer(``, [call('message.edit', { message: `#${theirsN}`, text: `όχι` })]),
      '<skip/>',
    ],
    allowed: ['memory.search', 'message.edit', 'lore.list'],
    features: { recall: true },
    config: WEB_CONFIG,
    runner: { recall },
    seeds: [
      { chatId: 'c2', authorId: 'self-id', messageId: 'q1', text: 'παλιό κείμενο' },
      { chatId: 'c2', authorId: 'u7', messageId: 'q2', text: 'ξένο' },
    ],
    loop: { maxSteps: 4 },
  } as unknown as Parameters<typeof coreTurn>[0]);
  const runCalls = run.port.calls;
  const edits = runCalls
    .filter((call) => call.op === 'edit')
    .map((call) => [asRecord(call.args[0]).chatId, asRecord(call.args[0]).messageId, asRecord(call.args[1]).text]);
  assert.deepEqual(
    edits,
    [['c2', 'q1', 'νέο κείμενο']],
    "the persona's own quoted message was edited in its channel, the other's was refused"
  );
  assert.ok(
    run.logs.some((entry) => entry.msg === 'skills: called' && entry.skill === 'message.edit' && entry.status !== 'ok'),
    'the edit of a message the persona did not write failed visibly'
  );
});

// media.look: the persona's own second look, in place of the re-watch classifier.

/** Zoë's message m0 carries two pictures. */
const TWO_PICTURES = new Map([
  [
    'pa',
    {
      id: 'pa',
      contentType: 'image/png',
      name: 'singes.png',
      url: 'https://cdn.discordapp.com/attachments/1/2/singes.png',
    },
  ],
  [
    'pb',
    {
      id: 'pb',
      contentType: 'image/png',
      name: 'chat.png',
      url: 'https://cdn.discordapp.com/attachments/1/2/chat.png',
    },
  ],
]);

const LOOK_PROMPTS = {
  rewatch: 'Pick a second look for {{name}}.',
  'describe/rewatch': 'Answer {{question}} in {{maxChars}}.',
};

const fakePictures = {
  fetchAsDataUrl: async () => ({ dataUrl: 'data:image/webp;base64,ZmFrZQ==', bytes: 4, contentType: 'image/webp' }),
};

/** A describer whose second look at a picture answers `answer`, recording each call. */
function lookDescriber({ answer = 'ένα κλειδί στο τραπέζι', caps = null } = {}) {
  const calls: Array<{ placeId: Untyped; itemId: Untyped; question: Untyped }> = [];
  return {
    calls,
    relookImage: async (placeId: string, item: Untyped, question: unknown) => {
      calls.push({ placeId, itemId: item.itemId, question });
      return { question, text: answer };
    },
    ...(caps ? { videoCapsLeft: () => caps } : {}),
  };
}

test("media.look: no re-watch classifier is asked, and the persona's call runs the second look with their question, the answer labelled as the image model's", async () => {
  const describer = lookDescriber();
  const run = await coreTurn({
    answers: [
      toolAnswer('', [call('media.look', { message: '#1', item: 2, question: 'τι κρατά η γάτα;' })]),
      '<msg>ένα κλειδί</msg>',
    ],
    allowed: ['media.look'],
    content: 'τι κρατά στη φωτογραφία;',
    firstAttachments: TWO_PICTURES,
    prompts: LOOK_PROMPTS,
    runner: { describer, imageFetcher: fakePictures },
  });
  assert.equal(asRecord(run.result).outcome, 'spoke');
  const runRewatchCalls = run.llm.rewatchCalls;
  assert.equal(runRewatchCalls.length, 0, 'on: no classifier chooses for the persona');
  assert.ok(run.logs.some((entry) => entry.msg === 'rewatch: skipped' && entry.reason === 'core-tools'));
  assert.deepEqual(describer.calls, [{ placeId: 'g1', itemId: 'pb', question: 'τι κρατά η γάτα;' }]);
  const { result: resultLabels, tools: toolLabels } = labels.tools;
  assert.equal(
    toolContent(run.llm, 1),
    `${resultLabels.ok}\n${fill(toolLabels.look.image, { name: 'chat.png', question: 'τι κρατά η γάτα;' })}\nένα κλειδί στο τραπέζι`
  );
  assert.ok(!JSON.stringify(run.logs).includes('γάτα'), 'never the question of the persona in the log');
  // The senses: the persona's own second look in place of the classifier's.
  const runCalls = run.llm.calls;
  const secondItem = runCalls[0][1];
  const stable = userText([asRecord(secondItem.content)[0]]);
  assert.ok(stable.includes(labels.senses.lookTool), stable);
});

test('media.look caps: at most two second looks in one turn, across the steps', async () => {
  const describer = lookDescriber();
  const run = await coreTurn({
    answers: [
      toolAnswer('', [
        call('media.look', { message: '#1', question: 'τι είναι;' }),
        call('media.look', { message: '#1', item: 2, question: 'και αυτό;' }),
      ]),
      toolAnswer('', [call('media.look', { message: '#1', question: 'ξανά;' })]),
      '<msg>τέλος</msg>',
    ],
    allowed: ['media.look'],
    features: { vision: true },
    firstAttachments: TWO_PICTURES,
    prompts: LOOK_PROMPTS,
    config: { media: { maxPerTurn: 6, filePreviewChars: 500, look: { maxPerTurn: 2 } } },
    runner: { describer, imageFetcher: fakePictures },
  } as unknown as Parameters<typeof coreTurn>[0]);
  assert.equal(describer.calls.length, 2, 'two looks, the third refused');
  const called = run.logs
    .filter((entry) => entry.msg === 'skills: called' && entry.skill === 'media.look')
    .map((entry) => `${entry.status}:${entry.code ?? ''}`);
  assert.deepEqual(called, ['ok:', 'ok:', 'failed:turn-cap']);
  const resultLabels = labels.tools.result;
  assert.ok(toolContent(run.llm, 2, 2).includes(resultLabels.reasons['turn-cap']), 'the persona hears why');
});

/** A turn on the fake interface whose `conversation.read` names, by a `#handle` the request never showed, a channel of another interface that holds one stored line. */
async function readFarRoom(context: object, chat: string | null): Promise<string> {
  const mind = openWorld();
  noteInterface(mind, 'other', [{ id: 'r9', name: 'Ρίζα' }]);
  const room = addRoom(mind.db, { iface: 'other', native: 'far-room', root: rootId('other', 'r9'), name: 'μακριά' });
  // A channel whose chat kind is unknown is internal: only the owner's command line reads it.
  mind.db.prepare('UPDATE places SET chat = ? WHERE id = ?').run(chat, room);
  addLine(mind.db, {
    id: 'src:other:far-1:1:seen',
    iface: 'other',
    place: room,
    author: 'self',
    text: 'η βροχή στο βουνό',
    at: new Date(TURN_CORE_TOOLS_NOW - 60_000).toISOString(),
  });
  const handle = handleOf('far-room', HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX);
  const run = await coreTurn({
    answers: [toolAnswer('', [call('conversation.read', { place: `#${handle}`, last: 5 })]), '<msg>εντάξει</msg>'],
    allowed: ['conversation.read'],
    runner: { journalDb: () => mind.db, memoryContext: () => context },
  });
  mind.close();
  return String(toolContent(run.llm, 1));
}

test("conversation.read: a #handle the persona carries of another interface's channel reads that place's stored lines", async () => {
  // Bug: on the owner's command line a handle carried from a turn on another interface resolved only over the turn's
  // own channels, so the read fell to the command line chat itself and answered unsupported.
  const read = await readFarRoom({ id: 'ctx:owner', mode: 'internal', internal: true }, null);
  assert.ok(read.includes('η βροχή στο βουνό'), read);
});

test("conversation.read: a resolved handle of a place the turn's context may not read is refused", async () => {
  // Bug: resolving a handle would hand a group turn a place only the owner's command line may read.
  const read = await readFarRoom({ kind: 'group', iface: 'fake' }, null);
  assert.ok(!read.includes('η βροχή στο βουνό'), read);
  const readable = await readFarRoom({ kind: 'group', iface: 'fake' }, 'group');
  assert.ok(readable.includes('η βροχή στο βουνό'), 'a group channel stays readable to a group turn');
});

const TURN_IN_TURN_TOOLS_NOW = Date.parse('2026-10-24T12:00:00Z');

function cacheScene() {
  const io = rig();
  const pages: Array<string> = [];
  const images: Array<unknown> = [];
  const hot = {
    config: {
      features: { vision: true, mediaDescriptions: true, videoDescriptions: true, coreTools: true },
      models: { routes: chainsOf({ vision: 'test/vision' }) },
    },
    prompts: { labels },
  };
  const draft: InTurnDraft = { handleFloor: 2 };
  const tools = createInTurnTools({
    hot,
    store: { mediaNameOf: noMediaNames, listUserProfiles: () => [] },
    recall: null,
    speech: null,
    record: null,
    routes: turnRoutes(hot, null),
    clock: () => TURN_IN_TURN_TOOLS_NOW,
    ifaceReads: io.reads,
    lookup: {
      readPage: (_rootId, url) => {
        pages.push(url);
        return Promise.resolve({ ok: true, url, title: 'stored page', text: `page:${url}` });
      },
    },
    describer: {
      relookImage: (_rootId, item, question) => {
        images.push(item.itemId);
        return Promise.resolve({ question, text: `image:${String(item.itemId)}` });
      },
    },
    memberOf: () => null,
    chatOf: (current) => ({ iface: 'fake', chatId: current.id }),
    turnContextOf: () => groupContext('fake'),
    linkCalls: (lines) => lines,
    drawTool: () => Promise.reject(new Error('drawing is outside this fixture')),
  });
  const history = [
    {
      id: 'same-native',
      content: 'https://local.example/wrong',
      attachments: [{ id: 'local-wrong', kind: 'image', url: 'https://local.example/wrong.png' }],
      links: [],
    },
  ];
  const handlers = tools.inTurnTools({
    channel: channel('room'),
    placeId: 'g1',
    selfId: 'self',
    selfName: 'Synthetic persona',
    history,
    draft,
  });
  return { io, pages, images, draft, handlers };
}

function registerCached(scene: ReturnType<typeof cacheScene>, name: string, native?: NativeMessageLocator) {
  const stored = {
    sourceId: `opaque-${name}`,
    placeId: `place-${name}`,
    iface: native?.iface ?? `foreign-${name}`,
    ...(native ? { native } : {}),
  };
  const refs = searchHandles(scene.draft);
  const n = refs.next();
  memorySearchText(
    [
      {
        placeId: 'room',
        channelName: 'stored room',
        startTs: TURN_IN_TURN_TOOLS_NOW,
        lines: name,
        entries: [
          {
            id: 'same-native',
            text: name,
            stored,
            message: {
              id: 'same-native',
              content: `https://${name}.example/page`,
              attachments: [
                { id: `image-${name}`, kind: 'image', url: `https://${name}.example/image.png`, name: `${name}.png` },
              ],
              links: [],
            },
          },
        ],
      },
    ],
    { labels, refs }
  );
  return { n, stored };
}

async function cachedCall(scene: ReturnType<typeof cacheScene>, skill: 'web.read' | 'media.look', n: number) {
  const view = callViewOf({
    channel: { id: 'room', rootId: 'g1' },
    currentIface: 'fake',
    skills: skillRegistry(),
    searchRefs: scene.draft.searchRefs,
  });
  const resolved = resolveCall(
    { skill, args: skill === 'web.read' ? { message: `#${n}` } : { message: `#${n}`, question: 'describe the item' } },
    view
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) assert.fail('authorized cached handle was refused');
  assert.equal(resolved.args.message, 'same-native');
  assert.equal(resolved.memoryAnchor, undefined);
  return executeCall(resolved, {
    inTurn: scene.handlers,
    port: { send: () => Promise.reject(new Error('cached reads never send')) },
    refOf: () => ({ iface: 'fake', chatId: 'room' }),
    // The turn's own chat reaches an in-turn tool as `here` (plan T.4).
    here: { iface: 'fake', chatId: 'room' },
    opContext: { placeId: 'g1' },
  });
}

for (const skill of ['web.read', 'media.look'] as const) {
  test(`${skill} keeps each stored message's cached content across colliding handles and loop steps`, async () => {
    const scene = cacheScene();
    const first = registerCached(scene, 'first');
    const second = registerCached(scene, 'second');
    const one = await cachedCall(scene, skill, first.n);
    const two = await cachedCall(scene, skill, second.n);
    assert.equal(one.status, 'ok');
    assert.equal(two.status, 'ok');
    if (skill === 'web.read')
      assert.deepEqual(scene.pages, ['https://first.example/page', 'https://second.example/page']);
    else assert.deepEqual(scene.images, ['image-first', 'image-second']);
    const sceneFake = scene.io.fake;
    assert.deepEqual(sceneFake.calls, []);
  });
}

for (const skill of ['web.read', 'media.look'] as const) {
  test(`${skill} never falls back to local history when an exact stored cache entry is missing`, async () => {
    const scene = cacheScene();
    const call: InTurnCall = {
      requester: null,
      chatId: 'room',
      idempotencyKey: null,
      messageRef: { kind: 'stored', stored: { sourceId: 'missing-source', placeId: 'missing-place', iface: 'other' } },
    };
    const result = await scene.handlers[skill]({ message: 'same-native', question: 'describe the item' }, call);
    assert.equal(JSON.stringify(result).includes('local.example'), false);
    assert.deepEqual(scene.pages, []);
    assert.deepEqual(scene.images, []);
    const sceneFake = scene.io.fake;
    assert.deepEqual(sceneFake.calls, []);
  });
}

test('a native cached link reference matches its current chat without borrowing a foreign route', async () => {
  const scene = cacheScene();
  const call: InTurnCall = {
    requester: null,
    chatId: 'room',
    idempotencyKey: null,
    messageRef: { kind: 'native', native: { iface: 'fake', chatId: 'room', messageId: 'same-native' } },
  };
  await scene.handlers['web.read']({ message: 'same-native' }, call);
  assert.deepEqual(scene.pages, ['https://local.example/wrong']);
  const sceneFake = scene.io.fake;
  assert.deepEqual(sceneFake.calls, []);
});

test('a foreign native cache reference cannot select the same native ID from current history', async () => {
  const scene = cacheScene();
  const call: InTurnCall = {
    requester: null,
    chatId: 'room',
    idempotencyKey: null,
    messageRef: { kind: 'native', native: { iface: 'other', chatId: 'room', messageId: 'same-native' } },
  };
  await scene.handlers['web.read']({ message: 'same-native' }, call);
  assert.deepEqual(scene.pages, []);
  const sceneFake = scene.io.fake;
  assert.deepEqual(sceneFake.calls, []);
});

test('an ambiguous qualified native cache reference cannot choose between distinct stored sources', async () => {
  const scene = cacheScene();
  const native = { iface: 'fake', chatId: 'room', messageId: 'same-native' };
  registerCached(scene, 'first', native);
  registerCached(scene, 'second', native);
  const call: InTurnCall = {
    requester: null,
    chatId: 'room',
    idempotencyKey: null,
    messageRef: { kind: 'native', native },
  };
  await scene.handlers['web.read']({ message: 'same-native' }, call);
  assert.deepEqual(scene.pages, []);
  const sceneFake = scene.io.fake;
  assert.deepEqual(sceneFake.calls, []);
});

test('repeating one source-free native quote keeps its original handle usable for cached web reads', async () => {
  const scene = cacheScene();
  const refs = searchHandles(scene.draft);
  const firstNumber = refs.next();
  const quote = {
    placeId: 'quoted-room',
    channelName: 'quoted room',
    startTs: TURN_IN_TURN_TOOLS_NOW,
    lines: 'quoted link',
    entries: [
      {
        id: 'same-native',
        text: 'quoted link',
        message: {
          id: 'same-native',
          placeId: 'quoted-room',
          native: { iface: 'fake', chatId: 'quoted-room', messageId: 'same-native' },
          content: 'https://repeat.example/original',
          attachments: [],
          links: [],
        },
      },
    ],
  };
  memorySearchText([quote], { labels, refs });
  const firstRead = await cachedCall(scene, 'web.read', firstNumber);
  assert.equal(firstRead.status, 'ok');
  assert.deepEqual(scene.pages, ['https://repeat.example/original']);
  memorySearchText([quote], { labels, refs });
  const repeatedRead = await cachedCall(scene, 'web.read', firstNumber);
  assert.equal(repeatedRead.status, 'ok');
  assert.deepEqual(scene.pages, ['https://repeat.example/original', 'https://repeat.example/original']);
  const sceneFake = scene.io.fake;
  assert.deepEqual(sceneFake.calls, []);
});

/** A turn on the `tele` interface whose in-turn tools read the stored places of every interface from `world`. */
function crossReadScene(
  world: World,
  memberOf: (placeId: string, accountId: string) => { name: string } | null,
  draft: InTurnDraft = {},
  io: Rig = rig()
) {
  const hot = { config: { bot: { timezone: 'UTC' }, features: { coreTools: true } }, prompts: { labels } };
  const tools = createInTurnTools({
    hot,
    store: { mediaNameOf: noMediaNames, listUserProfiles: () => [] },
    recall: null,
    speech: null,
    record: null,
    routes: turnRoutes(hot, null),
    clock: () => Date.parse('2026-11-02T10:00:00.000Z'),
    ifaceReads: io.reads,
    lookup: undefined,
    describer: undefined,
    memberOf,
    chatOf: (current) => ({ iface: 'tele', chatId: current.id }),
    turnContextOf: () => internalContext(),
    placeReads: frameReadsOver(
      () => world.db,
      () => hot.config
    ),
    linkCalls: (lines) => lines,
    drawTool: () => Promise.reject(new Error('drawing is outside this fixture')),
  });
  return tools.inTurnTools({
    channel: channel('here'),
    placeId: 'tele-root',
    selfId: 'self',
    selfName: 'Synthetic persona',
    history: [],
    draft,
  });
}

/** A room of the `fake` interface with one line of each author, at the given times before the turn. */
function roomOf(world: World): string {
  noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
  return addRoom(world.db, { iface: 'fake', native: 'c7', root: rootId('fake', 'g1'), name: 'garden' });
}

async function readText(handlers: ReturnType<typeof crossReadScene>, placeId: string): Promise<string> {
  const read = (await handlers['conversation.read']({ placeId, last: 10 })) as {
    status: string;
    data?: { text: string };
  };
  assert.equal(read.status, 'ok', JSON.stringify(read));
  return read.data?.text ?? '';
}

test("a read of another interface's place names each author from the store and the persona's own line by their name", async () => {
  // Bug: a place outside the turn's snapshot rendered every author but the persona as '-', so they read a channel and saw no one.
  const world = openWorld();
  try {
    const room = roomOf(world);
    addPerson(world.db, {
      id: 'person:zoe',
      accounts: [{ id: 'fake:5678', iface: 'fake', native: '5678', names: ['Zoe'] }],
    });
    world.db
      .prepare(
        "INSERT INTO accounts (id, iface, native_id, names, kind) VALUES ('fake:4444', 'fake', '4444', ?, 'user')"
      )
      .run(JSON.stringify(['Nikos']));
    addLine(world.db, {
      id: 'm1',
      iface: 'fake',
      place: room,
      author: 'fake:5678',
      text: 'line of zoe',
      at: '2026-11-02T09:00:00.000Z',
    });
    addLine(world.db, {
      id: 'm2',
      iface: 'fake',
      place: room,
      author: 'fake:4444',
      text: 'line of nikos',
      at: '2026-11-02T09:01:00.000Z',
    });
    addLine(world.db, {
      id: 'm3',
      iface: 'fake',
      place: room,
      author: 'self',
      text: 'line of hers',
      at: '2026-11-02T09:02:00.000Z',
    });
    const text = await readText(
      crossReadScene(world, () => null),
      room
    );
    assert.match(text, /Zoe\b[^\n]*line of zoe/);
    assert.match(text, /Nikos\b[^\n]*line of nikos/);
    assert.match(text, /Synthetic persona\b[^\n]*line of hers/);
  } finally {
    world.close();
  }
});

test("a read of another interface's place names a linked account by its person's profile and an unknown one by the member name", async () => {
  // Bug: a second account of a person showed its own name instead of the person's, or an account the memory holds no
  // name of showed '-' though the interface had told the core the member's name.
  const world = openWorld();
  try {
    const room = roomOf(world);
    addPerson(world.db, {
      id: 'person:zoe',
      accounts: [
        { id: 'tele:9999', iface: 'tele', native: '9999', names: ['Zoe'] },
        { id: 'fake:5678', iface: 'fake', native: '5678', names: ['zz-second'] },
      ],
    });
    // The profile that holds the person names its account (profile-holder.ts).
    world.db.prepare("UPDATE people SET writer = 'profile', holder_id = 'tele:9999' WHERE id = 'person:zoe'").run();
    world.db
      .prepare("INSERT INTO accounts (id, iface, native_id, kind) VALUES ('fake:3333', 'fake', '3333', 'user')")
      .run();
    addLine(world.db, {
      id: 'm1',
      iface: 'fake',
      place: room,
      author: 'fake:5678',
      text: 'line of zoe',
      at: '2026-11-02T09:00:00.000Z',
    });
    addLine(world.db, {
      id: 'm2',
      iface: 'fake',
      place: room,
      author: 'fake:3333',
      text: 'line of a guest',
      at: '2026-11-02T09:01:00.000Z',
    });
    const members = (_placeId: string, accountId: string) => (accountId === '3333' ? { name: 'Guest' } : null);
    const text = await readText(crossReadScene(world, members), room);
    assert.match(text, /Zoe\b[^\n]*line of zoe/);
    assert.doesNotMatch(text, /zz-second/);
    assert.match(text, /Guest\b[^\n]*line of a guest/);
  } finally {
    world.close();
  }
});

test("a read of another interface's place keeps a message id that holds a colon whole", async () => {
  // Bug: the read cut a line's id at its last colon, so a platform whose message ids hold colons got handles naming a
  // message that does not exist.
  const world = openWorld();
  try {
    const room = roomOf(world);
    addLine(world.db, {
      id: 'thread-3:m-9',
      iface: 'fake',
      place: room,
      author: 'self',
      text: 'line with a long id',
      at: '2026-11-02T09:00:00.000Z',
    });
    const draft: InTurnDraft = {};
    await readText(
      crossReadScene(world, () => null, draft),
      room
    );
    const shown = draft.searchRefs?.byNumber;
    const ids = [...(shown?.values() ?? [])].map((ref) => String(ref.id));
    assert.deepEqual(ids, ['thread-3:m-9']);
  } finally {
    world.close();
  }
});

test("a read of another interface's place whose id spells no native id reads the place its row names", async () => {
  // Bug: the read parsed the interface and the chat out of the place id, so a place with an opaque id read nothing and
  // answered unsupported.
  const world = openWorld();
  try {
    noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
    insertRows(world.db, {
      places: [
        {
          id: 'place:garden',
          iface: 'fake',
          kind: 'channel',
          native_id: 'c7',
          parent_id: rootId('fake', 'g1'),
          scope_kind: 'group',
          name: 'garden',
          seen_from_at: AT,
        },
      ],
    });
    addLine(world.db, {
      id: 'm1',
      iface: 'fake',
      place: 'place:garden',
      author: 'self',
      text: 'line in the garden',
      at: '2026-11-02T09:00:00.000Z',
    });
    const text = await readText(
      crossReadScene(world, () => null),
      'place:garden'
    );
    assert.match(text, /line in the garden/);
  } finally {
    world.close();
  }
});

// `person.link` among the persona's in-turn tools (src/turn/in-turn-tools.ts): the account it links is the one the turn answers,
// in the conversation the turn stands in, and a turn that answers nobody links nothing. The link itself is tested in
// tests/src/interface/person-link.test.ts; here a recording stand-in takes the call.

function handlersFor(trigger: { id: string; authorId: string } | null): {
  asked: Array<LinkAsk>;
  link: (args: Record<string, unknown>) => unknown;
} {
  const asked: Array<LinkAsk> = [];
  const hot = { config: {}, prompts: { labels } };
  const tools = createInTurnTools({
    hot,
    store: { mediaNameOf: noMediaNames, listUserProfiles: () => [] },
    recall: null,
    speech: null,
    record: null,
    routes: turnRoutes(hot, null),
    clock: () => 0,
    ifaceReads: rig().reads,
    lookup: undefined,
    describer: undefined,
    memberOf: () => null,
    chatOf: (current) => ({ iface: 'chatnet', chatId: current.id }),
    turnContextOf: () => groupContext('chatnet'),
    linkCalls: (lines) => lines,
    drawTool: () => Promise.reject(new Error('drawing is outside this fixture')),
    personLinks: {
      start: (ask) => {
        asked.push(ask);
        return Promise.resolve({ status: 'ok', data: { text: 'sent' } });
      },
    },
  });
  const handlers = tools.inTurnTools({
    channel: channel('room'),
    placeId: 'g1',
    selfId: 'self',
    selfName: 'Synthetic persona',
    history: [],
    trigger,
  });
  const link = handlers['person.link'];
  assert.ok(link, 'person.link is one of the in-turn tools of the persona');
  return { asked, link };
}

test('links the account the turn answers, in the conversation the turn stands in', async () => {
  const { asked, link } = handlersFor({ id: 'm1', authorId: 'a1' });
  await link({ person: 'person:7a1e' });
  assert.deepEqual(asked, [{ iface: 'chatnet', native: 'a1', chatId: 'room', person: 'person:7a1e' }]);
});

test('a turn that answers nobody links nothing', async () => {
  const { asked, link } = handlersFor(null);
  const result = (await link({ person: 'person:7a1e' })) as { status: string; code: string };
  assert.deepEqual([result.status, result.code], ['invalid', 'target-required']);
  assert.deepEqual(asked, []);
});

// conversation.read of a person's direct chat (plan 2026-11-08-meta-person, fault 2): a direct chat has no channel
// handle, so the persona names the person instead, and the read takes that person's newest direct chat other than the one they
// stands in, on any interface. The audience rule that decides any read of a stored place decides this one: the owner's
// command line reads the owner's chat on another interface, a group turn reads no direct chat. A refusal never shows the lines.
// Synthetic names.

const OWNER = 'person:owner';

const SECRET = 'a line of the owner in his chat on the fake interface';

/** The owner with a chat on the fake interface and on the command line; the turn stands in the command line's chat. */
function ownerWorld(): World {
  const w = openWorld();
  noteInterface(w, 'fake', [{ id: 'g1', name: 'Agora' }]);
  addPerson(w.db, {
    id: OWNER,
    accounts: [
      { id: 'fake:777', iface: 'fake', native: '777', names: ['Orestis'] },
      { id: 'cli:owner', iface: 'cli', native: 'owner', names: ['Orestis'] },
    ],
  });
  const fakeDm = addDm(w.db, { iface: 'fake', native: '777', person: OWNER, account: 'fake:777' });
  const cliDm = addDm(w.db, { iface: 'cli', native: 'owner', person: OWNER, account: 'cli:owner' });
  addLine(w.db, {
    id: 'f1',
    iface: 'fake',
    place: fakeDm,
    author: 'fake:777',
    text: SECRET,
    at: '2026-11-02T09:00:00.000Z',
    audience: { dm: fakeDm, iface: 'fake', person: OWNER },
  });
  addLine(w.db, {
    id: 'c1',
    iface: 'cli',
    place: cliDm,
    author: 'cli:owner',
    text: 'a line of the command line',
    at: '2026-11-02T09:30:00.000Z',
    audience: { dm: cliDm, iface: 'cli', person: OWNER },
  });
  return w;
}

async function readPerson(
  world: World,
  context: Context,
  person: string
): Promise<{ status: string; code?: string; data?: { text: string } }> {
  const io = rig();
  const hot = { config: { bot: { timezone: 'UTC' }, features: { coreTools: true } }, prompts: { labels } };
  const tools = createInTurnTools({
    hot,
    store: { mediaNameOf: noMediaNames, listUserProfiles: () => [] },
    recall: null,
    speech: null,
    record: null,
    routes: turnRoutes(hot, null),
    clock: () => Date.parse('2026-11-02T10:00:00.000Z'),
    ifaceReads: io.reads,
    lookup: undefined,
    describer: undefined,
    memberOf: () => null,
    chatOf: (current) => ({ iface: 'cli', chatId: current.id }),
    turnContextOf: () => context,
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
  return (await handlers['conversation.read']({ person, last: 10 })) as {
    status: string;
    code?: string;
    data?: { text: string };
  };
}

test("the owner's command line reads their direct chat on another interface named by their name", async () => {
  // Bug: a direct chat has no handle, so the persona cannot name the owner's chat on another interface and reads nothing.
  const world = ownerWorld();
  try {
    const read = await readPerson(world, internalContext(), 'Orestis');
    assert.equal(read.status, 'ok', JSON.stringify(read));
    const text = read.data?.text ?? '';
    assert.ok(text.includes(SECRET), text);
    assert.equal(text.includes('a line of the command line'), false, 'not the chat the persona stands in');
  } finally {
    world.close();
  }
});

test('a group turn naming a person reads none of their direct chats', async () => {
  // Bug: naming a person opens their private chat to a context that may read only the groups.
  const world = ownerWorld();
  try {
    const read = await readPerson(world, groupContext('fake'), 'Orestis');
    assert.notEqual(read.status, 'ok', JSON.stringify(read));
    assert.equal(JSON.stringify(read).includes(SECRET), false);
  } finally {
    world.close();
  }
});

test('a person nobody is called is refused with the reason and nothing is read', async () => {
  // Bug: an unknown person falls back to the chat the persona stands in, or to some other chat.
  const world = ownerWorld();
  try {
    const read = await readPerson(world, internalContext(), 'Theofilos');
    assert.equal(read.code, 'unknown-member', JSON.stringify(read));
    assert.equal(JSON.stringify(read).includes(SECRET), false);
  } finally {
    world.close();
  }
});

/** One image item with `description` and the platform's attachment id `ref`, linked to the stored line `source`. */
function pictureOn(world: World, source: string, ref: string, description: string) {
  world.db
    .prepare(
      `INSERT INTO media (id, kind, native_ref, availability, description, scope_kind, scope_iface)
       VALUES (?, 'image', ?, 'present', ?, 'group', 'fake')`
    )
    .run(`media:${source}`, ref, description);
  world.db
    .prepare("INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('source', ?, 0, ?)")
    .run(source, `media:${source}`);
}

test('a read of a place from stored lines includes a picture-only line with its description', async () => {
  // Bug: a post that is only a picture has empty text, so the stored read dropped it and the persona read the channel
  // without knowing the post was there.
  const world = openWorld();
  try {
    const room = roomOf(world);
    addLine(world.db, {
      id: 'm1',
      iface: 'fake',
      place: room,
      author: 'self',
      text: 'before it',
      at: '2026-11-02T09:00:00.000Z',
    });
    addLine(world.db, {
      id: 'm2',
      iface: 'fake',
      place: room,
      author: 'self',
      text: '',
      at: '2026-11-02T09:01:00.000Z',
    });
    pictureOn(world, 'm2', 'att-m2', 'a white rabbit in a garden');
    const text = await readText(
      crossReadScene(world, () => null),
      room
    );
    assert.ok(text.includes('a white rabbit in a garden'), text);
  } finally {
    world.close();
  }
});

test('a read of the last lines of a place of posts by the persona ends with their newest post, a picture', async () => {
  // Bug: the persona's newest post in a channel was only a picture, and conversation.read of the
  // last lines ended at the text post before it, with no sign that a line was missing.
  const world = openWorld();
  try {
    const room = roomOf(world);
    addLine(world.db, {
      id: 'm1',
      iface: 'fake',
      place: room,
      author: 'self',
      text: 'FIRST-POST',
      at: '2026-11-02T09:00:00.000Z',
    });
    addLine(world.db, {
      id: 'm2',
      iface: 'fake',
      place: room,
      author: 'self',
      text: 'SECOND-POST',
      at: '2026-11-02T09:01:00.000Z',
    });
    addLine(world.db, {
      id: 'm3',
      iface: 'fake',
      place: room,
      author: 'self',
      text: '',
      at: '2026-11-02T09:02:00.000Z',
    });
    pictureOn(world, 'm3', 'att-m3', 'a white rabbit in a garden');
    const text = await readText(
      crossReadScene(world, () => null),
      room
    );
    assert.ok(text.includes('a white rabbit in a garden'), text);
    assert.ok(text.indexOf('a white rabbit in a garden') > text.indexOf('SECOND-POST'), text);
  } finally {
    world.close();
  }
});

test('a line the platform returns renders the description the memory holds for its picture', async () => {
  // Bug: a read that took lines from the platform handed the renderer no descriptions, so a described picture
  // showed as a bare image marker.
  const world = openWorld();
  try {
    const room = roomOf(world);
    addLine(world.db, {
      id: 'a1',
      iface: 'fake',
      place: room,
      author: 'self',
      text: 'the anchor',
      at: '2026-11-02T09:00:00.000Z',
    });
    addLine(world.db, {
      id: 'p1',
      iface: 'fake',
      place: room,
      author: 'self',
      text: '',
      at: '2026-11-02T09:01:00.000Z',
    });
    pictureOn(world, 'p1', 'att-77', 'a white rabbit in a garden');
    const io = rig();
    const chat = channel('c7');
    io.fake.seedChat(chat);
    io.fake.seedEvent(message(chat, 'a1', Date.parse('2026-11-02T09:00:00.000Z'), 'the anchor'));
    const picture = message(chat, 'p1', Date.parse('2026-11-02T09:01:00.000Z'), '');
    picture.message.attachments = [
      {
        id: 'att-77',
        kind: 'image',
        url: 'https://cdn.example/rabbit.png',
        name: 'rabbit.png',
        contentType: 'image/png',
      },
    ] as typeof picture.message.attachments;
    io.fake.seedEvent(picture);
    const handlers = crossReadScene(world, () => null, {}, io);
    const read = (await handlers['conversation.read']({ placeId: room, after: 'a1' })) as {
      status: string;
      data?: { text: string };
    };
    assert.equal(read.status, 'ok', JSON.stringify(read));
    assert.equal(io.asked('history').length > 0, true, 'the platform was asked');
    const shown = read.data?.text ?? '';
    assert.ok(shown.includes('a white rabbit in a garden'), shown);
  } finally {
    world.close();
  }
});
