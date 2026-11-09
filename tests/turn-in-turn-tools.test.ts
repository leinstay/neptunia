import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/tools/operations/index.ts';
import { createInTurnTools, type InTurnDraft } from '../src/turn/in-turn-tools.ts';
import { callViewOf, searchHandles } from '../src/turn/calls.ts';
import { memorySearchText } from '../src/tools/tools.ts';
import { resolveCall, executeCall, type InTurnCall } from '../src/tools/executors.ts';
import { skillRegistry } from '../src/tools/registry.ts';
import { turnRoutes } from '../src/behavior/turn-ability-route.ts';
import type { NativeMessageLocator } from '../src/memory/db/recall.ts';
import { groupContext, internalContext } from '../src/memory/db/scope.ts';
import { frameReadsOver } from '../src/memory/db/frame-reads.ts';
import {
  AT,
  addLine,
  addPerson,
  addRoom,
  noteInterface,
  openWorld,
  rootId,
  addDm,
} from './fixtures/memory-db/mind-world.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
import { rig, channel } from './fixtures/reads-rig.ts';
import { labels } from './fixtures/labels.ts';
import { chainsOf } from './fixtures/chains.ts';
import type { LinkAsk } from '../src/interface/person-link.ts';
import type { Context } from '../src/memory/db/scope.ts';

const NOW = Date.parse('2026-10-24T12:00:00Z');

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
    store: { listUserProfiles: () => [] },
    recall: null,
    speech: null,
    record: null,
    routes: turnRoutes(hot, null),
    clock: () => NOW,
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
        startTs: NOW,
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
    assert.deepEqual(scene.io.fake.calls, []);
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
    assert.deepEqual(scene.io.fake.calls, []);
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
  assert.deepEqual(scene.io.fake.calls, []);
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
  assert.deepEqual(scene.io.fake.calls, []);
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
  assert.deepEqual(scene.io.fake.calls, []);
});

test('repeating one source-free native quote keeps its original handle usable for cached web reads', async () => {
  const scene = cacheScene();
  const refs = searchHandles(scene.draft);
  const firstNumber = refs.next();
  const quote = {
    placeId: 'quoted-room',
    channelName: 'quoted room',
    startTs: NOW,
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
  assert.deepEqual(scene.io.fake.calls, []);
});

/** A turn on the `tele` interface whose in-turn tools read the stored places of every interface from `world`. */
function crossReadScene(
  world: World,
  memberOf: (placeId: string, accountId: string) => { name: string } | null,
  draft: InTurnDraft = {}
) {
  const io = rig();
  const hot = { config: { bot: { timezone: 'UTC' }, features: { coreTools: true } }, prompts: { labels } };
  const tools = createInTurnTools({
    hot,
    store: { listUserProfiles: () => [] },
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

test("a read of another interface's place names each author from the store and her own line by her name", async () => {
  // Bug: a place outside the turn's snapshot rendered every author but her as '-', so she read a channel and saw no one.
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
    world.db
      .prepare(
        "INSERT INTO storage_units (id, kind, subject_type, subject_id, key_json) VALUES ('unit:zoe', 'user', 'account', 'tele:9999', '[\"user\",\"tele:9999\"]')"
      )
      .run();
    // The profile that holds the person names its account (profile-owner.ts).
    world.db
      .prepare(
        "UPDATE people SET owner_key = 'unit:zoe', writer = 'profile', holder_id = 'tele:9999' WHERE id = 'person:zoe'"
      )
      .run();
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

// `person.link` among her in-turn tools (src/turn/in-turn-tools.ts): the account it links is the one the turn answers,
// in the conversation the turn stands in, and a turn that answers nobody links nothing. The link itself is tested in
// tests/person-link.test.ts; here a recording stand-in takes the call.

function handlersFor(trigger: { id: string; authorId: string } | null): {
  asked: Array<LinkAsk>;
  link: (args: Record<string, unknown>) => unknown;
} {
  const asked: Array<LinkAsk> = [];
  const hot = { config: {}, prompts: { labels } };
  const tools = createInTurnTools({
    hot,
    store: { listUserProfiles: () => [] },
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
  assert.ok(link, 'person.link is one of her in-turn tools');
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
// handle, so she names the person instead, and the read takes that person's newest direct chat other than the one she
// stands in, on any interface. The audience rule that decides any read of a stored place decides this one: the owner's
// command line reads his chat on another interface, a group turn reads no direct chat. A refusal never shows the lines.
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
    store: { listUserProfiles: () => [] },
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

test("the owner's command line reads his direct chat on another interface named by his name", async () => {
  // Bug: a direct chat has no handle, so she cannot name the owner's chat on another interface and reads nothing.
  const world = ownerWorld();
  try {
    const read = await readPerson(world, internalContext(), 'Orestis');
    assert.equal(read.status, 'ok', JSON.stringify(read));
    const text = read.data?.text ?? '';
    assert.ok(text.includes(SECRET), text);
    assert.equal(text.includes('a line of the command line'), false, 'not the chat she stands in');
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
  // Bug: an unknown person falls back to the chat she stands in, or to some other chat.
  const world = ownerWorld();
  try {
    const read = await readPerson(world, internalContext(), 'Theofilos');
    assert.equal(read.code, 'unknown-member', JSON.stringify(read));
    assert.equal(JSON.stringify(read).includes(SECRET), false);
  } finally {
    world.close();
  }
});
