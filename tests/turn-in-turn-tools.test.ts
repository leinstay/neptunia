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
import { AT, addLine, addPerson, addRoom, noteInterface, openWorld, rootId } from './fixtures/memory-db/mind-world.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
import { rig, channel, message } from './fixtures/reads-rig.ts';
import type { Rig } from './fixtures/reads-rig.ts';
import { labels } from './fixtures/labels.ts';
import { chainsOf } from './fixtures/chains.ts';

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
  draft: InTurnDraft = {},
  io: Rig = rig()
) {
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
  // Bug: a post that is only a picture has empty text, so the stored read dropped it and she read the channel
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

test('a read of the last lines of a place of her own posts ends with her newest post, a picture', async () => {
  // Bug (production, 2026-11-09): her newest post in a channel was only a picture, and conversation.read of the
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
    // Both lines carry the message route a line the platform gave holds: a stored line without one has no id the
    // platform takes, and a read anchored on it is answered from the stored lines alone.
    for (const id of ['a1', 'p1'])
      world.db.prepare('UPDATE sources SET extra = ? WHERE id = ?').run(
        JSON.stringify({
          $messageLocator: { v: 1, origin: 'protocol-message', iface: 'fake', chatId: 'c7', messageId: id },
        }),
        id
      );
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
