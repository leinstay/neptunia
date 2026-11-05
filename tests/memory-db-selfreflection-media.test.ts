// The diary media job (src/memory/db/selfreflection-media.ts): the text and the pictures of her diary posts come from the
// interface into the database and `data/media/selfreflection/`. A fake port, a fake image fetcher, synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { channelPlaceId } from '../src/memory/db/ids.ts';
import { seedUnits } from './fixtures/memory-db/seed.ts';
import {
  createSelfreflectionMedia,
  applySelfreflectionUpdate,
  DEFAULT_AUDIO_MAX_BYTES,
  GAP_MS,
} from '../src/memory/db/selfreflection-media.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { createDiscordAdapter } from '../interfaces/discord/port.ts';
import { buildDataDir, guildDir, writeJson } from './fixtures/memory-db/datadir.ts';
import type { Untyped } from '../src/tools/types.ts';
import { sqlOf, present, wrongly } from './fixtures/loose-types.ts';

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
      "INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by, extra) VALUES ('mirror-1', 'selfreflection', ?, 1, '2026-10-27T00:00:00.000Z', 'owner', NULL)"
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
    createSelfreflectionMedia({
      db: () => handle.db,
      apply: (update) => applySelfreflectionUpdate(handle, update),
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
  /** A message of hers in the diary channel, with picture attachments (url -> bytes served by the fake fetcher). */
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
  /** A message of hers carrying one audio attachment (served by the fake fetch). */
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
    row: (id: Untyped) => sqlOf(handle).prepare('SELECT * FROM selfreflection WHERE id = ?').get(id),
    media: () =>
      sqlOf(handle)
        .prepare(
          `SELECT m.* FROM media m JOIN media_links l ON l.media_id = m.id WHERE l.owner_kind = 'selfreflection'
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
      ['media/selfreflection/d-1-1.png', 'media/selfreflection/d-1-2.png']
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
      fs.readdirSync(path.join(env.data, 'media', 'selfreflection')).some((name) => name.includes('.tmp-')),
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
    const calls = env.port.calls.length;
    await env.job().run();
    assert.equal(env.port.calls.length, calls);
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
    const calls = env.port.calls.length;
    const downloads = env.downloads.length;
    // The diary is written again (a new gist).
    env.writePosts([post('d-1', [a], { gist: 'changed gist' })]);
    env.writeUnits();
    assert.equal(env.row('d-1').gist, 'changed gist');
    assert.equal(env.row('d-1').text, 'hello');
    const again = env.job();
    assert.equal(again.hasWork(), false);
    assert.deepEqual(await again.run(), { done: 0, failed: 0 });
    assert.equal(env.port.calls.length, calls);
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
    const url = present([...env.port.messages.values()].find((m) => m.text === 'flaky one')).attachments[0].url;
    const served = png('flaky');
    const second = createSelfreflectionMedia({
      db: () => env.handle.db,
      apply: (u) => applySelfreflectionUpdate(env.handle, u),
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

// Stage 3 design, section 5: "only with a diary channel" is only with a place for her diary, the enabled mirror.
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
    assert.equal(env.port.calls.length, 0);
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

/**
 * A whole discord.js-shaped message: the adapter also builds its event from it (changed with the contract: a read by id
 * answers the message's whole event beside its text and attachments).
 */
function wholeMessage({ id, content, attachments }: Record<string, Untyped>) {
  return {
    id,
    placeId: 'c1',
    channel: { name: 'general' },
    guild: { id: 'g1' },
    author: { id: 'u1', bot: false, globalName: 'Alice', username: 'alice' },
    member: { displayName: 'Alice' },
    content,
    cleanContent: content,
    createdTimestamp: 1000,
    reference: null,
    attachments,
    stickers: new Map(),
    embeds: [],
    messageSnapshots: new Map(),
    flags: { has: () => false },
  };
}

test('the Discord adapter reads messages by id: text, attachments, and missing for a deleted one', async () => {
  const messages = new Map([
    [
      'm1',
      wholeMessage({
        id: 'm1',
        content: 'a post',
        attachments: new Map([
          ['a1', { url: 'https://cdn.example/a.png', name: 'a.png', contentType: 'image/png', size: 12 }],
        ]),
      }),
    ],
  ]);
  const channel = {
    messages: {
      async fetch(id: string) {
        if (id === 'boom') throw Object.assign(new Error('x'), { status: 500 });
        if (!messages.has(id)) throw Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 });
        return messages.get(id);
      },
    },
  };
  const port = createDiscordAdapter({
    client: { channels: { cache: wrongly(new Map([['c1', channel]])) }, user: { id: 'me' } },
  });
  const found = await port.fetchMessages({ iface: 'discord', conversationId: 'c1' }, ['m1', 'm2']);
  assert.equal(found.status, 'ok');
  assert.deepEqual(
    found.messages.map((message) => {
      const copy = { ...message };
      delete copy.event;
      return copy;
    }),
    [
      {
        messageId: 'm1',
        text: 'a post',
        attachments: [{ url: 'https://cdn.example/a.png', name: 'a.png', contentType: 'image/png', size: 12 }],
      },
      { messageId: 'm2', missing: true },
    ]
  );
  const failed = await port.fetchMessages({ iface: 'discord', conversationId: 'c1' }, ['m1', 'boom']);
  assert.notEqual(failed.status, 'ok');
  const nowhere = await port.fetchMessages({ iface: 'discord', conversationId: 'c9' }, ['m1']);
  assert.equal(nowhere.status, 'failed');
});

// PR 7d: `memoryDb.selfreflectionMedia` is code, so the job always runs.
test('the service runs the job once the database is open', async () => {
  const { createMemoryDb } = await import('../src/memory/db/service.ts');
  const env = setup(wrongly({ posts: [post('d-1', ['x'])] }));
  try {
    const a = env.say('served');
    env.writePosts([post('d-1', [a])]);
    env.writeUnits();
    env.handle.close();
    const hot = { config: { ...env.hot.config } };
    const service = createMemoryDb({
      hot,
      dataDir: env.data,
      worker: false,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      selfreflectionMediaDeps: () => ({ port: env.port, imageFetcher: { fetchAsDataUrl: async () => null } }),
      selfreflectionSleep: async () => {},
    });
    await service.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await service.close();
    const reader = openMemoryDb(env.dbFile, { readOnly: true });
    try {
      assert.equal(sqlOf(reader).prepare('SELECT text FROM selfreflection WHERE id = ?').get('d-1').text, 'served');
    } finally {
      reader.close();
    }
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
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
        ['media/selfreflection/d-1-1.png', 'image/png'],
        ['media/selfreflection/d-1-2.ogg', 'audio/ogg'],
      ]
    );
    assert.deepEqual(fs.readFileSync(path.join(env.data, media[1].path)), bytes);
    assert.equal(media[1].sha1, createHash('sha1').update(bytes).digest('hex'));
    // What she voiced is the item's text form; a post's message and address sit in `extra`.
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
    assert.equal(item.path, 'media/selfreflection/d-1-1.mp3');
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
    for (const m of env.port.messages.values())
      if (m.text === 'gone') m.attachments[0].url = 'https://cdn.example/unserved.ogg';
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
    const calls = env.port.calls.length;
    assert.deepEqual(await job.run(), { done: 1, failed: 0 });
    assert.equal(env.port.calls.length, calls + 1);
    const paths = env
      .media()
      .filter((m) => m.owner === 'd-1')
      .map((m) => m.path);
    assert.deepEqual(paths, ['media/selfreflection/d-1-1.png', 'media/selfreflection/d-1-2.ogg']);
    assert.equal(env.job().hasWork(), false);
  } finally {
    env.done();
  }
});

test('the Discord adapter passes an attachment duration and waveform when Discord gives them', async () => {
  const messages = new Map([
    [
      'm1',
      wholeMessage({
        id: 'm1',
        content: '',
        attachments: new Map([
          [
            'a1',
            {
              url: 'https://cdn.example/v.ogg',
              name: 'v.ogg',
              contentType: 'audio/ogg',
              size: 9,
              duration: 2.5,
              waveform: 'AAEC',
            },
          ],
        ]),
      }),
    ],
  ]);
  const channel = { messages: { fetch: async (id: string) => messages.get(id) } };
  const port = createDiscordAdapter({
    client: { channels: { cache: wrongly(new Map([['c1', channel]])) }, user: { id: 'me' } },
  });
  const found: Record<string, Untyped> = await port.fetchMessages({ iface: 'discord', conversationId: 'c1' }, ['m1']);
  assert.deepEqual(found.messages[0].attachments[0], {
    url: 'https://cdn.example/v.ogg',
    name: 'v.ogg',
    contentType: 'audio/ogg',
    size: 9,
    durationSec: 2.5,
    waveform: 'AAEC',
  });
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
    assert.equal(env.port.calls.filter((one) => one.op === 'fetchMessages').length, 1);
    assert.equal(env.logs.filter((entry) => entry.code === 'link-closed').length, 0);
    assert.equal(job.hasWork(), true);
    assert.deepEqual(await job.run(), { done: 2, failed: 0 });
  } finally {
    env.done();
  }
});

test('a conversation the interface forbids is asked once in a start and logged once', async () => {
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
    assert.equal(env.port.calls.filter((one) => one.op === 'fetchMessages').length, 1);
    assert.equal(env.logs.filter((entry) => entry.code === 'http-403').length, 1);
    assert.equal(job.hasWork(), false);
    assert.equal(env.row('d-1').text, null);
  } finally {
    env.done();
  }
});
