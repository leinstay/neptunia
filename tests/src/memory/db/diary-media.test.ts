import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { insertRows } from '../../../../src/memory/db/rows.ts';
import {
  applyDiaryUpdate,
  createDiaryMedia,
  applyEntryMedia,
  DEFAULT_AUDIO_MAX_BYTES,
  GAP_MS,
} from '../../../../src/memory/db/diary-media.ts';
import { createFakeAdapter } from '../../../../scripts/lib/fake.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { lineMedia } from '../../../../src/memory/db/media-store.ts';
import { internalContext } from '../../../../src/memory/db/scope.ts';
import { KINDS, fixture, observeLine } from '../../../fixtures/media-memory.ts';
import type { Env } from '../../../fixtures/media-memory.ts';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { channelPlaceId } from '../../../../src/memory/db/ids.ts';
import { seedUnits } from '../../../fixtures/memory-db/seed.ts';
import { buildDataDir, guildDir, writeJson } from '../../../fixtures/memory-db/datadir.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import { sqlOf, present, wrongly } from '../../../fixtures/loose-types.ts';

const AT = '2026-10-27T12:00:00.000Z';
const PLACE = 'fake:channel:d1';
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

type Row = Record<string, unknown>;
type Db = {
  prepare(sql: string): { run(...params: Array<unknown>): unknown; all(...params: Array<unknown>): Array<Row> };
};

/** The handles a test opened, closed when the file is done. */
const OPEN: Array<{ close(): void }> = [];

/**
 * A memory database with the diary's mirror on `d1` of the fake interface, the diary rows `entries` (each with the
 * message ids it was posted as) and the describer's cache rows `described` (attachment id -> what the persona saw), the fake
 * interface holding the persona's messages `messages`, and the diary media job over both.
 */
function scene({
  entries,
  described = {},
  messages,
  media = [],
}: {
  entries: Array<{ id: string; text: string | null; messageIds: Array<string> }>;
  described?: Record<string, string>;
  messages: Array<{ id: string; text: string; attachment?: { id?: string; name: string } }>;
  media?: Array<{ id: string; owner: string; nativeRef: object }>;
}) {
  const dataDir = tempDir('nep-entry-media-');
  const handle = openMemoryDb(path.join(dataDir, 'memory.db'));
  OPEN.push(handle);
  const db = handle.db as Db; // open.js is untyped JS; `db` is its node:sqlite connection
  const group = { scope_kind: 'group', scope_iface: 'fake', scope_dm: null };
  insertRows(
    db,
    {
      places: [
        {
          id: PLACE,
          iface: 'fake',
          kind: 'channel',
          native_id: 'd1',
          parent_id: null,
          scope_kind: 'group',
          name: 'journal',
        },
      ],
      diary: entries.map((entry, position) => ({
        id: entry.id,
        at_ms: Date.parse(AT) - (entries.length - position) * 86_400_000,
        kind: 'status',
        gist: entry.text ?? 'a post',
        text: entry.text,
        ...group,
        owner_file: 'guilds/g1/diary.json',
        position,
      })),
      diary_mirrors: entries.map((entry) => ({
        id: `mirror:${entry.id}`,
        diary_id: entry.id,
        iface: 'fake',
        place_id: PLACE,
        native_ids: JSON.stringify(entry.messageIds),
        posted_at: AT,
        owner_file: 'guilds/g1/diary.json',
      })),
      media: [
        ...Object.entries(described).map(([attachmentId, description]) => ({
          id: `media:held:${attachmentId}`,
          kind: 'image',
          owner: null,
          path: null,
          native_ref: attachmentId,
          description,
          ...group,
        })),
        ...media.map((item) => ({
          id: item.id,
          kind: 'image',
          owner: item.owner,
          // The diary's files live under media/diary.
          path: `media/diary/${item.id}.png`,
          native_ref: (item.nativeRef as { attachmentId?: string }).attachmentId ?? null,
          extra: JSON.stringify(item.nativeRef),
          description: null,
          mime: 'image/png',
          ...group,
        })),
      ],
      media_links: media.map((item, position) => ({
        owner_kind: 'diary',
        owner_id: item.owner,
        position,
        media_id: item.id,
      })),
    },
    { log: SILENT, at: AT }
  );
  db.prepare(
    "INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by, extra) VALUES ('mirror-1', 'diary', ?, 1, ?, 'owner', NULL)"
  ).run(PLACE, AT);
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self' });
  const pictures = new Map<string, Buffer>();
  for (const message of messages) {
    const ref = port.seed('d1', { authorId: 'self', text: message.text, messageId: message.id });
    const stored = port.messages.get(`d1/${ref.messageId}`);
    if (stored && message.attachment) {
      const url = `https://cdn.example/${message.attachment.name}`;
      pictures.set(url, Buffer.from(`png-${message.attachment.name}`));
      // The adapter's read of a message names each attachment by the platform's id, when the platform gives one.
      const named = message.attachment.id ? { id: message.attachment.id } : {};
      stored.attachments = [
        { ...named, name: message.attachment.name, url, contentType: 'image/png', size: 64 },
      ] as typeof stored.attachments;
    }
  }
  const fetcher = {
    fetchAsDataUrl: (url: string) => {
      const bytes = pictures.get(url);
      return Promise.resolve(
        bytes
          ? {
              dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
              bytes: bytes.byteLength,
              contentType: 'image/png',
            }
          : null
      );
    },
  };
  const job = () =>
    createDiaryMedia({
      db: () => handle.db,
      apply: (update: unknown) => applyDiaryUpdate(handle, update),
      port: () => port,
      imageFetcher: () => fetcher,
      config: () => ({ image: { referenceMaxBytes: 100_000 }, context: { vision: { fetchTimeoutMs: 1000 } } }),
      dataDir,
      log: SILENT,
      sleep: () => Promise.resolve(),
    });
  /** The diary media rows of `owner`: their id, the attachment id their native ref names, and their description. */
  const mediaOf = (owner: string) =>
    db
      .prepare(
        `SELECT m.id, m.native_ref, m.description FROM media m JOIN media_links l ON l.media_id = m.id
         WHERE l.owner_kind = 'diary' AND l.owner_id = ? ORDER BY l.position`
      )
      .all(owner)
      .map((row) => ({
        id: String(row.id),
        attachmentId: row.native_ref ?? null,
        description: row.description ?? null,
      }));
  const textOf = (id: string) => db.prepare('SELECT text FROM diary WHERE id = ?').all(id)[0]?.text ?? null;
  const fetches = () => port.calls.filter((call) => call.op === 'fetchMessages').length;
  const dump = () =>
    db
      .prepare(
        `SELECT m.id, m.native_ref, m.description, m.sha1 FROM media m JOIN media_links l ON l.media_id = m.id
         WHERE l.owner_kind = 'diary' ORDER BY m.id`
      )
      .all();
  return { job, mediaOf, textOf, fetches, dump, dataDir };
}

describe('diary entry media', () => {
  after(() => {
    for (const handle of OPEN.splice(0)) handle.close();
  });

  // A file a message and an entry both show is one item: the entry's link goes to the row memory already held.
  test("an entry's picture row keeps the attachment id and the description memory holds for it", async () => {
    const s = scene({
      entries: [{ id: 'd-1', text: null, messageIds: ['m1', 'm2'] }],
      described: { 'att-1': 'a wooden pier at dusk' },
      messages: [
        { id: 'm1', text: 'βόλτα στο λιμάνι' },
        { id: 'm2', text: '', attachment: { id: 'att-1', name: 'pier.png' } },
      ],
    });
    await s.job().run();
    assert.deepEqual(s.mediaOf('d-1'), [
      { id: 'media:held:att-1', attachmentId: 'att-1', description: 'a wooden pier at dusk' },
    ]);
  });

  test('an older picture row with only its url and message is completed once, and a second start changes nothing', async () => {
    const s = scene({
      entries: [{ id: 'd-2', text: 'παλιό', messageIds: ['m3'] }],
      described: { 'att-2': 'two boats in fog' },
      messages: [{ id: 'm3', text: 'παλιό', attachment: { id: 'att-2', name: 'boats.png' } }],
      media: [
        { id: 'media:diary:d-2-1', owner: 'd-2', nativeRef: { url: 'https://cdn.example/boats.png', messageId: 'm3' } },
      ],
    });
    await s.job().run();
    assert.deepEqual(s.mediaOf('d-2'), [
      { id: 'media:held:att-2', attachmentId: 'att-2', description: 'two boats in fog' },
    ]);
    const settled = s.dump();
    const asked = s.fetches();
    assert.equal(asked, 1, 'the older entry was read once');
    await s.job().run();
    assert.equal(s.fetches(), asked, 'a second start asks the interface for nothing');
    assert.deepEqual(s.dump(), settled);
    assert.ok(fs.existsSync(s.dataDir));
  });

  test('an older picture row the read cannot name is still read exactly once across two starts', async () => {
    const s = scene({
      entries: [{ id: 'd-3', text: 'παλιό', messageIds: ['m4'] }],
      messages: [{ id: 'm4', text: 'παλιό', attachment: { name: 'harbour.png' } }],
      media: [
        {
          id: 'media:diary:d-3-1',
          owner: 'd-3',
          nativeRef: { url: 'https://cdn.example/harbour.png', messageId: 'm4' },
        },
      ],
    });
    await s.job().run();
    await s.job().run();
    assert.equal(s.fetches(), 1, 'the interface is asked for the older entry once');
  });

  test("an entry's picture relinked to its posted attachment leaves no row of the same file behind", () => {
    // Bug: the relink drops the old row only when it holds no path, so every picture the mirror echoed keeps a second,
    // unlinked row of the same file.
    const handle = openMemoryDb(path.join(tempDir('nep-entry-twin-'), 'memory.db'));
    OPEN.push(handle);
    const db = handle.db as Db;
    db.prepare(
      "INSERT INTO diary (id, at_ms, kind, status, scope_kind, scope_iface) VALUES ('d-9', 1000, 'status', 'done', 'group', 'fake')"
    ).run();
    db.prepare(
      "INSERT INTO media (id, kind, native_ref, scope_kind, scope_iface) VALUES ('media:fake:att-9', 'image', 'att-9', 'group', 'fake')"
    ).run();
    const file = { id: 'media:diary:d-9-1', path: 'media/diary/d-9-1.png', sha1: 'aa09', bytes: 64, mime: 'image/png' };
    applyDiaryUpdate(handle, { id: 'd-9', media: [{ ...file, nativeRef: null }] });
    applyDiaryUpdate(handle, {
      id: 'd-9',
      media: [{ ...file, nativeRef: JSON.stringify({ messageId: 'm9', attachmentId: 'att-9' }) }],
    });
    const rows = db.prepare("SELECT id FROM media WHERE path = 'media/diary/d-9-1.png' ORDER BY id").all();
    assert.deepEqual(
      rows.map((row) => row.id),
      ['media:fake:att-9']
    );
  });
});

const internal = internalContext();
const rowsOf = (env: Env, source: string, ownerKind: 'source' | 'diary' = 'source') =>
  lineMedia(env.db, [source], internal, ownerKind).get(source) ?? [];

function withEnv(body: (env: Env) => void) {
  const env = fixture();
  try {
    body(env);
  } finally {
    env.done();
  }
}

// ---------- the diary and the mirror ----------

test("a diary entry's files are items linked to it, each with its path under media/ and its bytes' sha1", () =>
  withEnv((env) => {
    const dataDir = tempDir('nep-media-diary-');
    env.db.prepare("INSERT INTO diary (id, scope_kind, scope_iface) VALUES ('d1', 'group', 'discord')").run();
    applyEntryMedia(env.handle, {
      dataDir,
      id: 'd1',
      items: [
        { data: Buffer.from('png'), mime: 'image/png' },
        { data: Buffer.from('ogg'), mime: 'audio/ogg', extra: { voice: true, text: 'a cathedral', durationSec: 2 } },
      ],
    });
    const rows = rowsOf(env, 'd1', 'diary');
    assert.deepEqual(
      rows.map((one) => [one.position, one.kind]),
      [
        [0, 'image'],
        [1, 'voice'],
      ]
    );
    for (const row of rows) {
      assert.ok(String(row.path).startsWith('media/'), String(row.path));
      assert.ok(fs.existsSync(path.join(dataDir, String(row.path))), 'the mirror finds the file');
      assert.ok(row.sha1);
    }
    const second = rows[1];
    assert.deepEqual([second.description, second.extra.textOrigin], ['a cathedral', 'voiced']);
  }));

test('a diary entry and a message showing the same file are one item with two links', () =>
  withEnv((env) => {
    env.db.prepare("INSERT INTO diary (id, scope_kind, scope_iface) VALUES ('d2', 'group', 'discord')").run();
    const source = observeLine(env, KINDS[0], 'absent');
    applyEntryMedia(env.handle, {
      dataDir: tempDir('nep-media-diary-'),
      id: 'd2',
      items: [
        {
          data: Buffer.from('png'),
          mime: 'image/png',
          ref: { messageId: 'pic', attachmentId: 'pic-a' },
        },
      ],
    });
    const [linked] = rowsOf(env, source);
    assert.ok(String(linked.path).startsWith('media/'), 'the line now knows the file');
    assert.equal(rowsOf(env, 'd2', 'diary')[0].mediaId, linked.mediaId);
  }));

const CHANNEL = '700000000000000001';
const png = (tag: string) => Buffer.from(`png-${tag}`);
const dataUrl = (buffer: Untyped, contentType = 'image/png') =>
  `data:${contentType};base64,${buffer.toString('base64')}`;

function setup({ posts, config = {} }: { posts?: Untyped; config?: Record<string, Untyped> } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-diary-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const g = guildDir(data);
  const writePosts = (list: Record<string, Untyped>) =>
    writeJson(path.join(g, 'diary.json'), { updatedAt: 1, posts: list });
  writePosts(posts);
  const dbFile = path.join(data, 'memory.db');
  const handle = openMemoryDb(dbFile);
  seedUnits(handle, data);
  // Stage 3 design, section 5: the posts' place is the diary's mirror (a `mirrors` row of schema v15), no longer
  // `diary.placeId`; the job asks the interface for the posts in that place.
  const placeId = channelPlaceId('discord', CHANNEL);
  insertRows(
    handle.db,
    {
      places: [
        {
          id: placeId,
          iface: 'discord',
          kind: 'channel',
          native_id: CHANNEL,
          parent_id: null,
          scope_kind: 'group',
          name: 'journal',
        },
      ],
    },
    { at: '2026-10-27T00:00:00.000Z' }
  );
  // open.js answers its node:sqlite connection untyped; the fixture needs prepare and run.
  const writer: Record<string, Untyped> = handle.db;
  writer
    .prepare(
      "INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by, extra) VALUES ('mirror-1', 'diary', ?, 1, '2026-10-27T00:00:00.000Z', 'owner', NULL)"
    )
    .run(placeId);
  const port = createFakeAdapter({ iface: 'discord', selfId: 'self' });
  const downloads: Array<Untyped> = [];
  const files = new Map();
  const audioFiles = new Map();
  const audioFetches: Array<Untyped> = [];
  const fetcher = {
    async fetchAsDataUrl(url: Record<string, Untyped>, options: Record<string, Untyped>) {
      downloads.push({ url, ...options });
      return files.get(url) ?? null;
    },
  };
  const hot = {
    config: {
      context: { vision: { fetchTimeoutMs: 5000 } },
      ...config,
    },
  };
  const sleeps: Array<Untyped> = [];
  const logs: Array<Untyped> = [];
  const log = {
    info: (m: Untyped, f: Record<string, Untyped>) => logs.push({ m, ...f }),
    warn: (m: Untyped, f: Record<string, Untyped>) => logs.push({ m, ...f }),
    error() {},
    debug() {},
  };
  const job = () =>
    createDiaryMedia({
      db: () => handle.db,
      apply: (update) => applyDiaryUpdate(handle, update),
      port: () => port,
      imageFetcher: () => fetcher,
      fetchImpl: wrongly(async (url: Record<string, Untyped>) => {
        audioFetches.push(url);
        const served = audioFiles.get(url);
        if (!served) return { ok: false, status: 404 };
        return {
          ok: true,
          headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? served.type : null) },
          arrayBuffer: async () => served.bytes,
        };
      }),
      config: () => hot.config,
      dataDir: data,
      log,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
  /** A message of the persona's in the diary channel, with picture attachments (url -> bytes served by the fake fetcher). */
  const say = (text: Untyped, pictures: Array<Untyped> = [], size?: Untyped) => {
    const ref = port.seed(CHANNEL, { authorId: 'self', text });
    present(port.messages.get(`${CHANNEL}/${ref.messageId}`)).attachments = pictures.map((picture) => {
      const url = `https://cdn.example/${picture.name}?sig=1`;
      if (picture.bytes)
        files.set(url, { dataUrl: dataUrl(picture.bytes), bytes: picture.bytes.byteLength, contentType: 'image/png' });
      return {
        url,
        name: picture.name,
        contentType: picture.type ?? 'image/png',
        size: size ?? picture.bytes?.byteLength,
      };
    });
    return ref.messageId;
  };
  /** A message of the persona's carrying one audio attachment (served by the fake fetch). */
  const sayVoice = (
    text: Untyped,
    {
      bytes,
      type = 'audio/ogg',
      name = 'voice-message.ogg',
      durationSec,
      size,
    }: { bytes?: Untyped; type?: string; name?: string; durationSec?: Untyped; size?: Untyped } = {}
  ) => {
    const ref = port.seed(CHANNEL, { authorId: 'self', text });
    const url = `https://cdn.example/${name}?sig=1`;
    audioFiles.set(url, { bytes, type });
    present(port.messages.get(`${CHANNEL}/${ref.messageId}`)).attachments = [
      {
        url,
        name,
        contentType: type,
        size: size ?? bytes.byteLength,
        ...(durationSec === undefined ? {} : { durationSec }),
      },
    ];
    return ref.messageId;
  };
  return {
    sayVoice,
    audioFetches,
    root,
    data,
    g,
    handle,
    port,
    job,
    say,
    writePosts,
    downloads,
    sleeps,
    logs,
    hot,
    dbFile,
    row: (id: Untyped) => sqlOf(handle).prepare('SELECT * FROM diary WHERE id = ?').get(id),
    media: () =>
      sqlOf(handle)
        .prepare(
          `SELECT m.* FROM media m JOIN media_links l ON l.media_id = m.id WHERE l.owner_kind = 'diary'
           ORDER BY l.owner_id, l.position`
        )
        .all(),
    writeUnits: () => seedUnits(handle, data),
    /** Turns the diary's mirror on or off. */
    mirrored: (enabled: Untyped) =>
      writer.prepare("UPDATE mirrors SET enabled = ? WHERE id = 'mirror-1'").run(enabled ? 1 : 0),
    done: () => {
      handle.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const post = (itemId: Untyped, messageIds: Record<string, Untyped>, extra = {}) => ({
  at: 1792000000000,
  kind: 'picture',
  gist: `gist ${itemId}`,
  picture: null,
  messageIds,
  search: null,
  itemId,
  ...extra,
});

/** What the two tests below read of `setup`. */
type Scene = {
  port: { calls: Array<{ op: string }>; failNext(op: string, result: unknown): void };
  logs: Array<{ code?: string }>;
  say(text: string): unknown;
  writePosts(posts: unknown): void;
  writeUnits(): void;
  job(): { run(): Promise<unknown>; hasWork(): boolean };
  row(id: string): { text: string | null };
  done(): void;
};

test('a post gets its messages joined in order, its pictures saved and a media row with the diary scope', async () => {
  const env = setup(wrongly({ posts: [post('d-1', ['x'])] }));
  try {
    const a = env.say('first part', [{ name: 'a.png', bytes: png('a') }]);
    const b = env.say('second part', [
      { name: 'b.png', bytes: png('b') },
      { name: 'notes.txt', type: 'text/plain' },
    ]);
    env.writePosts([post('d-1', [a, b])]);
    env.writeUnits();
    const counts = await env.job().run();
    assert.deepEqual(counts, { done: 1, failed: 0 });
    const row = env.row('d-1');
    assert.equal(row.text, 'first part\nsecond part');
    const media = env.media();
    assert.equal(media.length, 2);
    assert.deepEqual(
      media.map((m) => m.path),
      // The diary's files live under media/diary.
      ['media/diary/d-1-1.png', 'media/diary/d-1-2.png']
    );
    for (const [index, item] of media.entries()) {
      const bytes = fs.readFileSync(path.join(env.data, item.path));
      assert.deepEqual(bytes, png(index === 0 ? 'a' : 'b'));
      assert.equal(item.sha1, createHash('sha1').update(bytes).digest('hex'));
      assert.equal(item.bytes, bytes.byteLength);
      assert.equal(item.mime, 'image/png');
      assert.equal(item.owner, 'd-1');
      assert.equal(item.kind, 'image');
      assert.equal(item.scope_kind, row.scope_kind);
      assert.equal(item.scope_iface, row.scope_iface);
      assert.equal(item.scope_dm, row.scope_dm);
      const held = JSON.parse(item.extra) as { messageId: string; url: string };
      assert.equal(held.messageId, index === 0 ? a : b);
      assert.match(held.url, /^https:\/\/cdn\.example\//);
    }
    assert.ok(row.scope_kind);
    assert.deepEqual(
      env.downloads.map((d) => [d.maxBytes, d.timeoutMs]),
      // PR 7d: the picture cap is the constant REFERENCE_MAX_BYTES of the job, 4 000 000 bytes.
      [
        [4_000_000, 5000],
        [4_000_000, 5000],
      ]
    );
    assert.equal(
      fs.readdirSync(path.join(env.data, 'media', 'diary')).some((name) => name.includes('.tmp-')),
      false
    );
  } finally {
    env.done();
  }
});

test('a post whose messages are all gone keeps what the database holds and is not asked for again; one with some left keeps them', async () => {
  const env = setup(wrongly({ posts: [post('d-1', ['x'])] }));
  try {
    const kept = env.say('still here');
    env.writePosts([post('d-1', ['gone-1', 'gone-2']), post('d-2', ['gone-3', kept])]);
    env.writeUnits();
    const counts = await env.job().run();
    assert.deepEqual(counts, { done: 2, failed: 0 });
    assert.equal(env.row('d-1').text, '');
    assert.ok(env.row('d-1').gist, 'the gist the database had stays');
    assert.equal('lost' in env.row('d-1'), false, 'the diary has no lost mark');
    assert.equal(env.row('d-2').text, 'still here');
    // A post with nothing left is not asked for again.
    const { port } = env;
    const calls = port.calls.length;
    await env.job().run();
    assert.equal(port.calls.length, calls);
  } finally {
    env.done();
  }
});

test('it is idempotent: a second start asks for nothing, and a rewrite of the same diary keeps the text', async () => {
  const env = setup(wrongly({ posts: [post('d-1', ['x'])] }));
  try {
    const a = env.say('hello', [{ name: 'a.png', bytes: png('a') }]);
    env.writePosts([post('d-1', [a])]);
    env.writeUnits();
    await env.job().run();
    const { port } = env;
    const calls = port.calls.length;
    const downloads = env.downloads.length;
    // The diary is written again (a new gist).
    env.writePosts([post('d-1', [a], { gist: 'changed gist' })]);
    env.writeUnits();
    assert.equal(env.row('d-1').gist, 'changed gist');
    assert.equal(env.row('d-1').text, 'hello');
    const again = env.job();
    assert.equal(again.hasWork(), false);
    assert.deepEqual(await again.run(), { done: 0, failed: 0 });
    assert.equal(port.calls.length, calls);
    assert.equal(env.downloads.length, downloads);
    assert.equal(env.media().length, 1);
  } finally {
    env.done();
  }
});

test('a picture over the cap is skipped without a download; a failed download leaves the post for the next start', async () => {
  const env = setup(wrongly({ posts: [post('d-1', ['x'])] }));
  try {
    // PR 7d: the picture cap is the constant 4 000 000 bytes, so the big one says it is larger.
    const big = env.say('big one', [{ name: 'big.png', bytes: png('big') }], 5_000_000);
    const flaky = env.say('flaky one', [{ name: 'flaky.png' }]);
    env.writePosts([post('d-1', [big]), post('d-2', [flaky])]);
    env.writeUnits();
    const first = env.job();
    assert.deepEqual(await first.run(), { done: 1, failed: 1 });
    assert.equal(env.row('d-1').text, 'big one');
    assert.equal(env.media().length, 0);
    assert.equal(
      env.downloads.some((d) => d.url.includes('big.png')),
      false
    );
    assert.equal(env.row('d-2').text, null);
    // The same start does not hammer it; the next start does, and now the picture arrives.
    assert.deepEqual(await first.run(), { done: 0, failed: 0 });
    const { port } = env;
    const url = present([...port.messages.values()].find((m) => m.text === 'flaky one')).attachments[0].url;
    const served = png('flaky');
    const second = createDiaryMedia({
      db: () => env.handle.db,
      apply: (u) => applyDiaryUpdate(env.handle, u),
      port: () => env.port,
      imageFetcher: () => ({
        fetchAsDataUrl: async (u: Untyped) =>
          u === url ? { dataUrl: dataUrl(served), bytes: served.byteLength, contentType: 'image/png' } : null,
      }),
      config: () => env.hot.config,
      dataDir: env.data,
      sleep: async () => {},
    });
    assert.equal(second.hasWork(), true);
    assert.deepEqual(await second.run(), { done: 1, failed: 0 });
    assert.equal(env.row('d-2').text, 'flaky one');
    assert.equal(env.media().length, 1);
  } finally {
    env.done();
  }
});

// "Only with a diary channel" means only with a place for the persona's diary, the enabled mirror.
test('rows are fetched at most one a second, only with a diary channel, and a new post is picked up by the next run', async () => {
  const env = setup(wrongly({ posts: [post('d-1', ['x'])] }));
  try {
    const a = env.say('one');
    const b = env.say('two');
    env.writePosts([post('d-1', [a]), post('d-2', [b])]);
    env.writeUnits();
    env.mirrored(false);
    const job = env.job();
    assert.equal(job.hasWork(), true);
    assert.deepEqual(await job.run(), { done: 0, failed: 0 });
    const { port } = env;
    assert.equal(port.calls.length, 0);
    env.mirrored(true);
    assert.deepEqual(await job.run(), { done: 2, failed: 0 });
    assert.deepEqual(env.sleeps, [GAP_MS]);
    const c = env.say('three');
    env.writePosts([post('d-1', [a]), post('d-2', [b]), post('d-3', [c])]);
    env.writeUnits();
    assert.equal(job.hasWork(), true);
    assert.deepEqual(await job.run(), { done: 1, failed: 0 });
    assert.equal(env.row('d-3').text, 'three');
  } finally {
    env.done();
  }
});

test('a port failure leaves the post and logs a code only', async () => {
  const env = setup(wrongly({ posts: [post('d-1', ['x'])] }));
  try {
    env.port.failNext('fetchMessages', { status: 'failed', error: { code: 'http-503', retryable: true } });
    env.writeUnits();
    assert.deepEqual(await env.job().run(), { done: 0, failed: 1 });
    assert.equal(env.row('d-1').text, null);
    assert.ok(env.logs.some((entry) => entry.code === 'http-503'));
  } finally {
    env.done();
  }
});

test('an audio attachment is saved in the picture numbering with a row whose extra carries the matching voice metadata', async () => {
  const env = setup(wrongly({ posts: [post('d-1', ['x'])] }));
  try {
    const a = env.say('look', [{ name: 'a.png', bytes: png('a') }]);
    const bytes = Buffer.from('ogg-bytes');
    const v = env.sayVoice('', wrongly({ bytes, durationSec: 3.5 }));
    env.writePosts([post('d-1', [a, v], { voice: { messageId: v, text: 'sp+oken', durationSec: 4.25 } })]);
    env.writeUnits();
    assert.deepEqual(await env.job().run(), { done: 1, failed: 0 });
    const media = env.media();
    assert.deepEqual(
      media.map((m) => [m.path, m.mime]),
      [
        ['media/diary/d-1-1.png', 'image/png'],
        ['media/diary/d-1-2.ogg', 'audio/ogg'],
      ]
    );
    assert.deepEqual(fs.readFileSync(path.join(env.data, media[1].path)), bytes);
    assert.equal(media[1].sha1, createHash('sha1').update(bytes).digest('hex'));
    // What the persona voiced is the item's text form; a post's message and address sit in `extra`.
    assert.equal(media[1].description, 'sp+oken');
    const voiceExtra = JSON.parse(media[1].extra) as { voice?: unknown; durationSec?: unknown; textOrigin?: unknown };
    assert.deepEqual([voiceExtra.voice, voiceExtra.durationSec, voiceExtra.textOrigin], [true, 4.25, 'voiced']);
    assert.equal((JSON.parse(media[0].extra) as { voice?: unknown }).voice, undefined);
  } finally {
    env.done();
  }
});

test('an audio attachment without a matching voice field keeps its own duration only', async () => {
  const env = setup(wrongly({ posts: [post('d-1', ['x'])] }));
  try {
    const v = env.sayVoice(
      '',
      wrongly({ bytes: Buffer.from('m'), type: 'audio/mpeg', name: 'clip.mp3', durationSec: 7 })
    );
    env.writePosts([post('d-1', [v], { voice: { messageId: 'other', text: 'no', durationSec: 1 } })]);
    env.writeUnits();
    await env.job().run();
    const [item] = env.media();
    assert.equal(item.path, 'media/diary/d-1-1.mp3');
    // The post's message and the mark of its read sit beside what the file itself holds.
    const fileExtra = JSON.parse(item.extra) as { voice?: unknown; durationSec?: unknown; text?: unknown };
    assert.deepEqual([fileExtra.voice, fileExtra.durationSec, fileExtra.text], [true, 7, undefined]);
  } finally {
    env.done();
  }
});

test('audio over the cap is skipped without a download; a failed audio download leaves the post', async () => {
  // PR 7d: the audio cap is the constant DEFAULT_AUDIO_MAX_BYTES, so the big one says it is larger.
  const env = setup(wrongly({ posts: [post('d-1', ['x'])] }));
  try {
    const big = env.sayVoice(
      'big',
      wrongly({ bytes: Buffer.alloc(50), name: 'big.ogg', size: DEFAULT_AUDIO_MAX_BYTES + 1 })
    );
    const missing = env.sayVoice('gone', wrongly({ bytes: Buffer.alloc(5), name: 'gone.ogg' }));
    env.writePosts([post('d-1', [big]), post('d-2', [missing])]);
    env.writeUnits();
    // Serve nothing for the second one.
    const { port } = env;
    for (const m of port.messages.values()) {
      const [firstAttachment] = m.attachments;
      if (m.text === 'gone') firstAttachment.url = 'https://cdn.example/unserved.ogg';
    }
    assert.deepEqual(await env.job().run(), { done: 1, failed: 1 });
    assert.equal(env.media().length, 0);
    assert.equal(env.row('d-1').text, 'big');
    assert.equal(
      env.audioFetches.some((u) => u.includes('big.ogg')),
      false
    );
    assert.equal(env.row('d-2').text, null);
  } finally {
    env.done();
  }
});

test('a completed old post is fetched again only with a voice field and no audio row', async () => {
  const env = setup(wrongly({ posts: [post('d-1', ['x'])] }));
  try {
    const a = env.say('plain old', [{ name: 'a.png', bytes: png('a') }]);
    const v = env.sayVoice('spoken', wrongly({ bytes: Buffer.from('o') }));
    env.writePosts([post('d-1', [a]), post('d-2', [v])]);
    env.writeUnits();
    await env.job().run();
    assert.equal(env.row('d-2').text, 'spoken');
    const audioBefore = env.media().filter((m) => m.mime.startsWith('audio/')).length;
    assert.equal(audioBefore, 1);
    // Both texts are set. A post with a voice field and no audio row appears when the file gains the field.
    env.writePosts([post('d-1', [a]), post('d-2', [v], { gist: 'touched' })]);
    env.writeUnits();
    assert.equal(env.job().hasWork(), false);
    // Add a voice field to the old picture-only post: fetched once more, picture numbering unchanged.
    const voiceId = env.sayVoice('', wrongly({ bytes: Buffer.from('late') }));
    env.writePosts([
      post('d-1', [a, voiceId], { voice: { messageId: voiceId, text: 'late', durationSec: 2 } }),
      post('d-2', [v]),
    ]);
    env.writeUnits();
    assert.equal(env.row('d-1').text, 'plain old');
    const job = env.job();
    assert.equal(job.hasWork(), true);
    const { port } = env;
    const calls = port.calls.length;
    assert.deepEqual(await job.run(), { done: 1, failed: 0 });
    assert.equal(port.calls.length, calls + 1);
    const paths = env
      .media()
      .filter((m) => m.owner === 'd-1')
      .map((m) => m.path);
    assert.deepEqual(paths, ['media/diary/d-1-1.png', 'media/diary/d-1-2.ogg']);
    assert.equal(env.job().hasWork(), false);
  } finally {
    env.done();
  }
});

test('a link that is not up yet leaves the post for the next run and logs nothing', async () => {
  // Bug: every post of the start was asked of a closed link, written off until the next start and logged once each.
  const env = setup(wrongly({ posts: [post('d-1', ['x'])] })) as unknown as Scene;
  try {
    const a = env.say('one');
    const b = env.say('two');
    env.writePosts([post('d-1', [a]), post('d-2', [b])]);
    env.writeUnits();
    const job = env.job();
    env.port.failNext('fetchMessages', { status: 'failed', error: { code: 'link-closed', retryable: true } });
    assert.deepEqual(await job.run(), { done: 0, failed: 0 });
    const { port } = env;
    assert.equal(port.calls.filter((one) => one.op === 'fetchMessages').length, 1);
    assert.equal(env.logs.filter((entry) => entry.code === 'link-closed').length, 0);
    assert.equal(job.hasWork(), true);
    assert.deepEqual(await job.run(), { done: 2, failed: 0 });
  } finally {
    env.done();
  }
});

test('a chat the interface forbids is asked once in a start and logged once', async () => {
  // Bug: a channel the persona may not read took one request and one warning per post at every start.
  const env = setup(wrongly({ posts: [post('d-1', ['x'])] })) as unknown as Scene;
  try {
    const a = env.say('one');
    const b = env.say('two');
    env.writePosts([post('d-1', [a]), post('d-2', [b])]);
    env.writeUnits();
    const job = env.job();
    env.port.failNext('fetchMessages', { status: 'failed', error: { code: 'http-403', retryable: false } });
    assert.deepEqual(await job.run(), { done: 0, failed: 0 });
    const { port } = env;
    assert.equal(port.calls.filter((one) => one.op === 'fetchMessages').length, 1);
    assert.equal(env.logs.filter((entry) => entry.code === 'http-403').length, 1);
    assert.equal(job.hasWork(), false);
    assert.equal(env.row('d-1').text, null);
  } finally {
    env.done();
  }
});
