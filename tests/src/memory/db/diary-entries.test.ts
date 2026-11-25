// Tests for src/memory/db/diary-entries.ts, the write kind `diary-entries`: the persona's dated entries, the message
// ids each was mirrored as and their publications, written as their rows directly instead of through the diary mapper
// of a unit write, each row naming its writer and holder (place-holder.ts). The tests retire a dropped entry's mirror
// and publication, refuse an empty write, and read odd values back as written.
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { unitValue } from '../../../../src/memory/db/readers/common.ts';
import { applyMemoryWrite } from '../../../../src/memory/db/session-write.ts';
import { personaKey } from '../../../../src/memory/db/unit-keys.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { MemoryHandle, Row } from '../../../../src/memory/db/types.ts';
import { CHANNEL, NOW, copyOf, seededPlaces } from '../../../fixtures/memory-db/place-writes.ts';
import { createStore } from '../../../../src/memory/store.ts';
import { openTestMemory, tempDataDir } from '../../../fixtures/memory-db/service.ts';
import { createMirrors, guardMirrorPort } from '../../../../src/behavior/mirror.ts';
import { issueContext } from '../../../../src/memory/db/scope.ts';
import { walk } from '../../../../src/memory/db/graph.ts';
import { ROOT, NOW as MIRROR_NOW, sceneLlm, sceneRunner } from '../../../fixtures/diary-requests-recorded.ts';
import { dbOf as mirrorDbOf, entryOf, seedMirror } from '../../../fixtures/diary-mirror.ts';
import { freshWorld, world } from '../../../fixtures/turn-world.ts';
import { utcDay } from '../../../../src/time.ts';
import fs from 'node:fs';
import path from 'node:path';
import { createFakeAdapter } from '../../../../scripts/lib/fake.ts';
import { rawMessage } from '../../../fixtures/turn-harness.ts';
import '../../../../src/tools/operations/index.ts';

const KEY = personaKey('diary');
const post = (n: number, extra: Row = {}): Row => ({
  itemId: `sr-${n}`,
  at: NOW - n * 60_000,
  kind: 'day',
  gist: `μια μέρα ${n}`,
  picture: null,
  search: null,
  pictures: 1,
  ...extra,
});

/** One write of a test: a whole value, or one post appended with a cap. */
type Step = { value: Row; destination?: string } | { append: Row; max: number; destination?: string };

const STEPS: ReadonlyArray<Step> = [
  {
    value: {
      updatedAt: NOW,
      posts: [
        post(1, { messageIds: ['m1', 'm2'], text: 'Το πλήρες κείμενο.' }),
        post(2, { messageIds: ['m3'], publicationBoundary: { audience: 'owner' } }),
        post(3, { itemId: undefined }),
      ],
    },
    destination: CHANNEL,
  },
  { append: post(4, { messageIds: ['m4'] }), max: 3 },
  { value: { updatedAt: NOW + 1, posts: [post(3, { itemId: undefined }), post(4, { messageIds: ['m4', 'm5'] })] } },
];

function writeDirectWay(handle: MemoryHandle, step: Step): unknown {
  const base = {
    kind: 'diary-entries',
    iface: 'discord',
    now: NOW,
    ...(step.destination ? { destination: step.destination } : {}),
  };
  return 'value' in step
    ? applyMemoryWrite(handle, { ...base, value: step.value })
    : applyMemoryWrite(handle, { ...base, append: step.append, max: step.max, updatedAt: NOW + 2 });
}

const read = (handle: MemoryHandle): unknown => unitValue(dbOf(handle), KEY);

test("a dropped entry retires its mirror and its mirror's publication", () => {
  const handle = copyOf(seededPlaces());
  try {
    for (const step of STEPS) writeDirectWay(handle, step);
    const live = dbOf(handle)
      .prepare("SELECT row_id FROM publications WHERE row_kind = 'diary' AND retired_at IS NULL ORDER BY row_id")
      .all()
      .map((row) => row.row_id);
    assert.deepEqual(live, ['sr-4']);
  } finally {
    handle.close();
  }
});

test('a diary write with neither a value nor a post is refused with a code', () => {
  const handle = copyOf(seededPlaces());
  try {
    assert.throws(() => applyMemoryWrite(handle, { kind: 'diary-entries', now: NOW }), {
      code: 'DIARY_VALUE',
    });
  } finally {
    handle.close();
  }
});

test('empty, absent and odd message ids, an empty list and repeated ids come back as they were written', () => {
  const values: ReadonlyArray<Row> = [
    {
      updatedAt: NOW,
      posts: [post(1, { messageIds: [1, 'x'] }), post(2, { messageIds: [], search: 'moths' }), post(3)],
    },
    { posts: [] },
    { posts: [{ gist: 5 }, { itemId: 'same' }, { itemId: 'same' }] },
    { posts: 'broken', other: [1] },
  ];
  for (const value of values) {
    const handle = copyOf(seededPlaces());
    try {
      applyMemoryWrite(handle, { kind: 'diary-entries', value, iface: 'discord', now: NOW });
      const back = read(handle) as { value?: unknown };
      assert.deepEqual(back.value, JSON.parse(JSON.stringify(value)), JSON.stringify(value));
    } finally {
      handle.close();
    }
  }
});

test('the store reads back an appended entry after the database is closed and opened again', async () => {
  const dataDir = tempDataDir('nep-diary-reopen-');
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  let written: unknown;
  try {
    const store = createStore({ dataDir, memoryDb: first.memoryDb });
    // @ts-expect-error a post without a picture is null, the shape the diary writes before one is drawn
    store.appendDiaryPost({ ...post(7), messageIds: [], search: null }, { max: 10, now: NOW });
    await store.flushSettled({});
    written = store.getDiary();
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: second.memoryDb });
    const back = store.getDiary() as { posts?: Array<{ gist?: unknown }> };
    const [first] = back.posts ?? [];
    assert.equal(first?.gist, 'μια μέρα 7');
    assert.deepEqual(back, written);
  } finally {
    await second.close();
  }
});

const KINDS_NOW = Date.parse('2026-11-10T10:00:00.000Z');

test('a diary the store writes names the first enabled mirror as the destination of its publications', async () => {
  // Bug: the destination was stamped on the unit write alone, so the direct write left the persona's publications with none.
  const opened = await openTestMemory({ now: () => KINDS_NOW, iface: () => 'discord' });
  try {
    const db = dbOf(opened.memoryDb.readHandle() as never);
    const writer = dbOf(opened.memoryDb.database() as never);
    writer.exec(`
      INSERT OR IGNORE INTO places (id, iface, kind, native_id) VALUES ('discord:channel:c9', 'discord', 'channel', 'c9');
      INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by)
        VALUES ('mirror-1', 'diary', 'discord:channel:c9', 1, '2026-11-01T00:00:00.000Z', 'owner');
    `);
    const post = {
      at: KINDS_NOW,
      kind: 'day',
      gist: 'a quiet day',
      picture: null,
      messageIds: ['m1'],
      search: null,
      itemId: 'd-1',
    };
    await opened.memoryDb.writeDiary({ value: { updatedAt: KINDS_NOW, posts: [post] } });
    const rows = db
      .prepare("SELECT destination_place_id AS place FROM publications WHERE row_kind = 'diary'")
      .all()
      .map((row) => row.place);
    assert.ok(rows.length > 0, 'the post has a publication');
    assert.deepEqual([...new Set(rows)], ['discord:channel:c9']);
  } finally {
    await opened.close();
  }
});

/** The memory databases the scenes opened, closed when the file is done. */
const OPEN: Array<{ close(): unknown }> = [];

/**
 * A core with the fake interface (chats `d1` and `d2` of the root), a real store over a memory database
 * holding the mirrors of `mirrors`, the publisher over both, and the diary turn whose entry a test hands to the
 * publisher. `link.connected` is whether an interface is connected (the publisher's port, or none).
 */
async function scene({
  mirrors: specs,
  connected = true,
}: {
  mirrors: Array<{ chatId: string; enabled?: boolean }>;
  connected?: boolean;
}) {
  const memory = await openTestMemory({ now: () => MIRROR_NOW });
  OPEN.push(memory);
  freshWorld();
  world().channel({ id: 'd1', name: 'journal', placeId: ROOT });
  world().channel({ id: 'd2', name: 'notes', placeId: ROOT });
  const store = createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb });
  const places = specs.map((spec) => seedMirror(memory.memoryDb, { iface: 'fake', at: MIRROR_NOW, ...spec }).placeId);
  const link = { connected };
  const mirrors = createMirrors({
    memoryDb: memory.memoryDb,
    port: () => (link.connected ? world().port : null),
    now: () => MIRROR_NOW,
    // Where the entry's pictures and voice are kept until they are sent (the memory service's data directory).
    dataDir: memory.dataDir,
  });
  const turns = sceneRunner(sceneLlm(), store);
  /** One diary turn as the wake runs it, its entry recorded and its writes landed. */
  async function record() {
    const result = await turns.runTurn({
      mode: 'diary',
      diary: { kind: 'status', forced: true },
      placeId: ROOT,
    });
    await store.flushSettled({});
    return entryOf(result);
  }
  /** The persona's messages the interface holds in `chatId`. */
  const texts = (chatId: string) =>
    world()
      .port.messagesIn(chatId)
      .map((message) => message.text);
  return { memory, store, places, link, mirrors, record, texts };
}

const RESTRICTED_ENTRY = { kind: 'internal-turn', origin: { iface: 'cli', chatId: 'd1' } } as const;

describe('mirror', () => {
  after(async () => {
    for (const item of OPEN.splice(0)) await item.close();
  });

  test('restricting a saved diary entry hides its existing media while independent public media stays readable', async () => {
    // Catches a diary scope update leaving its retained attachments visible through the memory graph.
    const core = await scene({ mirrors: [] });
    const entry = await core.record();
    const publicId = 'diary:independent-public';
    const original = core.store.getDiary().posts;
    core.store.setDiaryPosts([...original, { ...original[0], itemId: publicId }]);
    await core.store.flushSettled({});
    const { memoryDb } = core.memory;
    for (const id of [entry.id, publicId])
      await memoryDb.memoryWrite({
        kind: 'entry-media',
        id,
        items: [{ data: new Uint8Array([1, 2, 3]), mime: 'image/png' }],
      });
    const db = mirrorDbOf(core.memory.memoryDb);
    // An entry's pictures are stored under the `media:diary:` prefix.
    const nodes = db
      .prepare(
        "SELECT g.id, m.id AS media_id, m.owner FROM graph_nodes g JOIN media m ON g.row_id = m.id WHERE g.kind = 'media' AND m.id LIKE 'media:diary:%'"
      )
      .all();
    assert.equal(nodes.length, 2);
    const group = issueContext({ kind: 'group', iface: 'fake', now: () => MIRROR_NOW });
    const owner = issueContext({ kind: 'internal', now: () => MIRROR_NOW });
    for (const node of nodes) {
      if (typeof node.id !== 'string') throw new Error('media node has no ID');
      assert.deepEqual(
        walk(db, group, { from: node.id, maxDepth: 0 }).rows.map((row) => row.rowId),
        [node.media_id]
      );
    }
    core.store.setDiaryPosts(
      core.store
        .getDiary()
        .posts.map((post) => (post.itemId === entry.id ? { ...post, publicationBoundary: RESTRICTED_ENTRY } : post))
    );
    await core.store.flushSettled({});
    const restricted = db.prepare('SELECT scope_kind FROM diary WHERE id = ?').all(entry.id)[0];
    assert.equal(restricted?.scope_kind, 'internal');
    for (const node of nodes) {
      if (typeof node.id !== 'string') throw new Error('media node has no ID');
      assert.deepEqual(
        walk(db, owner, { from: node.id, maxDepth: 0 }).rows.map((row) => row.rowId),
        [node.media_id]
      );
      assert.deepEqual(
        walk(db, group, { from: node.id, maxDepth: 0 }).rows.map((row) => row.rowId),
        node.owner === entry.id ? [] : [node.media_id]
      );
    }
  });
});

const DIARY_NOW = Date.parse('2026-10-27T12:00:00Z');
const DIARY_ROOT = 'g1';

/**
 * A root with `general` (c1), where Alice wrote last, and the diary's two enabled mirrors `journal` (d1) and
 * `notes` (d2), on a fake interface; a real store over memory, the publisher over the interface's own port, and the persona's
 * tools through a real admin over the guarded port. `postsToday` diary entries are already counted today.
 */
async function root({ postsToday = 0 }: { postsToday?: number } = {}) {
  const memory = await openTestMemory({ now: () => DIARY_NOW });
  OPEN.push(memory);
  freshWorld();
  const line = (placeId: string) => ({
    ...rawMessage({ id: `m-${placeId}`, ts: DIARY_NOW - 30_000, content: 'γεια' }),
    placeId,
  });
  // The persona's own earlier post in c1 with a picture: what a media repost takes.
  const ownPicture = {
    ...rawMessage({ id: 'p-own', ts: DIARY_NOW - 60_000, content: '' }),
    placeId: 'c1',
    author: { id: 'self-id', bot: true, globalName: 'Bot', username: 'Bot' },
    member: { displayName: 'Bot' },
    attachments: new Map([
      [
        'att-own',
        { id: 'att-own', name: 'pier.png', url: 'https://cdn.example/pier.png', contentType: 'image/png', size: 3 },
      ],
    ]),
  };
  world().channel({ id: 'c1', name: 'general', placeId: DIARY_ROOT, historyMessages: [ownPicture, line('c1')] });
  world().channel({ id: 'd1', name: 'journal', placeId: DIARY_ROOT });
  world().channel({ id: 'd2', name: 'notes', placeId: DIARY_ROOT });
  for (const [id, name] of [
    ['d1', 'journal'],
    ['d2', 'notes'],
  ] as const)
    seedMirror(memory.memoryDb, { iface: 'fake', chatId: id, name, at: DIARY_NOW });
  // The persona's GIF library holds one GIF, `g1`, posted as its address.
  const store = Object.assign(createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb }), {
    findGif: (_rootId: string, handle: string) =>
      handle === 'g1' ? { id: 'g1', url: 'https://media.example/g1.gif', file: null } : null,
    recordOwnGif: () => {},
  });
  // The diary cap counts by the admin's own clock, the real one, so the seeded day is today's.
  if (postsToday > 0) Object.assign(store.state.data, { diaryDay: utcDay(Date.now()), diaryPosts: postsToday });
  const adapter = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => DIARY_NOW });
  const reads = world().adopt(adapter);
  const mirrors = createMirrors({
    memoryDb: memory.memoryDb,
    port: () => adapter,
    now: () => DIARY_NOW,
    dataDir: memory.dataDir,
  });
  const port = guardMirrorPort(adapter, { memoryDb: memory.memoryDb });
  const texts = (chatId: string) => adapter.messagesIn(chatId).map((message) => message.text);
  // A file one of the persona's errands brought back.
  const filePath = path.join(memory.dataDir, 'notes.txt');
  fs.writeFileSync(filePath, 'σημειώσεις');
  const errands = { fileOf: () => ({ name: 'notes.txt', path: filePath, contentType: 'text/plain' }) };
  return { memory, store, adapter, reads, mirrors, port, texts, errands };
}

type Root = Awaited<ReturnType<typeof root>>;

const PRIVATE_DIARY = 'private-diary-marker-731';
const PRIVATE_BOUNDARY = { kind: 'internal-turn', origin: { iface: 'fake', chatId: 'c1' } } as const;
const internalDiaryContext = () =>
  issueContext({ kind: 'internal', now: () => DIARY_NOW, newId: () => 'ctx:private-diary' });

function diaryDb(core: Root) {
  const { memoryDb } = core.memory;
  const handle = memoryDb.readHandle();
  assert.ok(handle);
  return dbOf(handle);
}

function seedRestrictedDiary(core: Root, metadata: unknown = PRIVATE_BOUNDARY): void {
  // Public store writes reproduce restored metadata without granting a model control over it.
  const post = {
    at: DIARY_NOW - 60000,
    kind: 'thought',
    gist: PRIVATE_DIARY,
    picture: null,
    search: '',
    text: PRIVATE_DIARY,
    itemId: 'diary:restricted-seed',
    publicationBoundary: metadata,
    send: { messages: [PRIVATE_DIARY] },
  };
  core.store.appendDiaryPost(post);
}

describe('tools operations diary', () => {
  after(async () => {
    for (const item of OPEN.splice(0)) await item.close();
  });

  for (const metadata of [PRIVATE_BOUNDARY, null, { kind: 'internal-turn', origin: {} }]) {
    test(`restored ${metadata === PRIVATE_BOUNDARY ? 'valid' : metadata === null ? 'null' : 'malformed'} diary restriction hides the entry from outward reads`, async () => {
      // Catches group-scoped diary rows exposing internal text after a mapper round trip.
      const core = await root();
      seedRestrictedDiary(core, metadata);
      await core.store.flushSettled({});
      const db = diaryDb(core);
      const node = db
        .prepare("SELECT id FROM graph_nodes WHERE kind = 'diary' AND row_id = ?")
        .get('diary:restricted-seed');
      assert.ok(node && typeof node.id === 'string');
      const owner = walk(db, internalDiaryContext(), { from: node.id, maxDepth: 0 });
      assert.ok(owner.rows.some((row) => row.rowId === 'diary:restricted-seed'));
      const outward = issueContext({ kind: 'group', iface: 'fake', now: () => DIARY_NOW });
      assert.deepEqual(walk(db, outward, { from: node.id, maxDepth: 0 }).rows, []);
      const restored = createStore({ dataDir: core.memory.dataDir, memoryDb: core.memory.memoryDb });
      const post = restored.getDiary().posts[0];
      assert.ok(post && 'publicationBoundary' in post);
      assert.deepEqual(post.publicationBoundary, metadata);
    });
  }
});
