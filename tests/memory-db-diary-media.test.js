// The diary media job (src/memory/db/diary-media.js): the text and the pictures of her diary posts come from the
// interface into the database and `data/media/diary/`. A fake port, a fake image fetcher, synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openMemoryDb } from '../src/memory/db/open.js';
import { syncOnce } from '../src/memory/db/sync.js';
import { createDiaryMedia, applyDiaryUpdate, GAP_MS } from '../src/memory/db/diary-media.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import { createDiscordAdapter } from '../interfaces/discord/port.js';
import { main } from '../tools/memory-db.mjs';
import { buildDataDir, guildDir, writeJson } from './fixtures/memory-db/datadir.js';

const CHANNEL = '700000000000000001';
const png = (tag) => Buffer.from(`png-${tag}`);
const dataUrl = (buffer, contentType = 'image/png') => `data:${contentType};base64,${buffer.toString('base64')}`;

function setup({ posts, config = {} } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-diary-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const g = guildDir(data);
  const writePosts = (list) => writeJson(path.join(g, 'diary.json'), { updatedAt: 1, posts: list });
  writePosts(posts);
  const dbFile = path.join(data, 'memory.db');
  const handle = openMemoryDb(dbFile);
  syncOnce(handle, data);
  const port = createFakeAdapter({ iface: 'discord', selfId: 'self' });
  const downloads = [];
  const files = new Map();
  const fetcher = {
    async fetchAsDataUrl(url, options) {
      downloads.push({ url, ...options });
      return files.get(url) ?? null;
    },
  };
  const hot = { config: { diary: { channelId: CHANNEL }, image: { referenceMaxBytes: 1000 }, context: { vision: { fetchTimeoutMs: 5000 } }, ...config } };
  const sleeps = [];
  const logs = [];
  const log = { info: (m, f) => logs.push({ m, ...f }), warn: (m, f) => logs.push({ m, ...f }), error() {}, debug() {} };
  const job = () => createDiaryMedia({
    db: () => handle.db,
    apply: (update) => applyDiaryUpdate(handle, update),
    port: () => port,
    imageFetcher: () => fetcher,
    config: () => hot.config,
    dataDir: data,
    log,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  /** A message of hers in the diary channel, with picture attachments (url -> bytes served by the fake fetcher). */
  const say = (text, pictures = [], size) => {
    const ref = port.seed(CHANNEL, { authorId: 'self', text });
    port.messages.get(`${CHANNEL}/${ref.messageId}`).attachments = pictures.map((picture) => {
      const url = `https://cdn.example/${picture.name}?sig=1`;
      if (picture.bytes) files.set(url, { dataUrl: dataUrl(picture.bytes), bytes: picture.bytes.byteLength, contentType: 'image/png' });
      return { url, name: picture.name, contentType: picture.type ?? 'image/png', size: size ?? picture.bytes?.byteLength };
    });
    return ref.messageId;
  };
  return {
    root, data, g, handle, port, job, say, writePosts, downloads, sleeps, logs, hot, dbFile,
    row: (id) => handle.db.prepare('SELECT * FROM diary WHERE id = ?').get(id),
    media: () => handle.db.prepare("SELECT * FROM media WHERE kind = 'diary' ORDER BY id").all(),
    sync: () => syncOnce(handle, data),
    done: () => { handle.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

const post = (itemId, messageIds, extra = {}) => ({ at: 1792000000000, kind: 'picture', gist: `gist ${itemId}`, picture: null, messageIds, search: null, itemId, ...extra });

test('a post gets its messages joined in order, its pictures saved and a media row with the diary scope', async () => {
  const env = setup({ posts: [post('d-1', ['x'])] });
  try {
    const a = env.say('first part', [{ name: 'a.png', bytes: png('a') }]);
    const b = env.say('second part', [{ name: 'b.png', bytes: png('b') }, { name: 'notes.txt', type: 'text/plain' }]);
    env.writePosts([post('d-1', [a, b])]);
    env.sync();
    const counts = await env.job().run();
    assert.deepEqual(counts, { done: 1, lost: 0, failed: 0 });
    const row = env.row('d-1');
    assert.equal(row.text, 'first part\nsecond part');
    assert.equal(row.lost, null);
    const media = env.media();
    assert.equal(media.length, 2);
    assert.deepEqual(media.map((m) => m.path), ['media/diary/d-1-1.png', 'media/diary/d-1-2.png']);
    for (const [index, item] of media.entries()) {
      const bytes = fs.readFileSync(path.join(env.data, item.path));
      assert.deepEqual(bytes, png(index === 0 ? 'a' : 'b'));
      assert.equal(item.sha1, createHash('sha1').update(bytes).digest('hex'));
      assert.equal(item.bytes, bytes.byteLength);
      assert.equal(item.mime, 'image/png');
      assert.equal(item.owner, 'd-1');
      assert.equal(item.kind, 'diary');
      assert.equal(item.scope_kind, row.scope_kind);
      assert.equal(item.scope_iface, row.scope_iface);
      assert.equal(item.scope_dm, row.scope_dm);
      assert.equal(JSON.parse(item.native_ref).messageId, index === 0 ? a : b);
      assert.match(JSON.parse(item.native_ref).url, /^https:\/\/cdn\.example\//);
    }
    assert.ok(row.scope_kind);
    assert.deepEqual(env.downloads.map((d) => [d.maxBytes, d.timeoutMs]), [[1000, 5000], [1000, 5000]]);
    assert.equal(fs.readdirSync(path.join(env.data, 'media', 'diary')).some((name) => name.includes('.tmp-')), false);
  } finally { env.done(); }
});

test('a post whose messages are all gone is marked lost; one with some left keeps what is there', async () => {
  const env = setup({ posts: [post('d-1', ['x'])] });
  try {
    const kept = env.say('still here');
    env.writePosts([post('d-1', ['gone-1', 'gone-2']), post('d-2', ['gone-3', kept])]);
    env.sync();
    const counts = await env.job().run();
    assert.deepEqual(counts, { done: 1, lost: 1, failed: 0 });
    assert.equal(env.row('d-1').lost, 1);
    assert.equal(env.row('d-1').text, null);
    assert.equal(env.row('d-2').text, 'still here');
    assert.equal(env.row('d-2').lost, null);
    // A lost post is not asked for again.
    const calls = env.port.calls.length;
    await env.job().run();
    assert.equal(env.port.calls.length, calls);
  } finally { env.done(); }
});

test('it is idempotent: a second start asks for nothing, and a sync of the same diary keeps the text', async () => {
  const env = setup({ posts: [post('d-1', ['x'])] });
  try {
    const a = env.say('hello', [{ name: 'a.png', bytes: png('a') }]);
    env.writePosts([post('d-1', [a])]);
    env.sync();
    await env.job().run();
    const calls = env.port.calls.length;
    const downloads = env.downloads.length;
    // The file is touched (a new mtime and gist), so the sync maps it again.
    env.writePosts([post('d-1', [a], { gist: 'changed gist' })]);
    env.sync();
    assert.equal(env.row('d-1').gist, 'changed gist');
    assert.equal(env.row('d-1').text, 'hello');
    const again = env.job();
    assert.equal(again.hasWork(), false);
    assert.deepEqual(await again.run(), { done: 0, lost: 0, failed: 0 });
    assert.equal(env.port.calls.length, calls);
    assert.equal(env.downloads.length, downloads);
    assert.equal(env.media().length, 1);
  } finally { env.done(); }
});

test('a picture over the cap is skipped without a download; a failed download leaves the post for the next start', async () => {
  const env = setup({ posts: [post('d-1', ['x'])] });
  try {
    const big = env.say('big one', [{ name: 'big.png', bytes: png('big') }], 5000);
    const flaky = env.say('flaky one', [{ name: 'flaky.png' }]);
    env.writePosts([post('d-1', [big]), post('d-2', [flaky])]);
    env.sync();
    const first = env.job();
    assert.deepEqual(await first.run(), { done: 1, lost: 0, failed: 1 });
    assert.equal(env.row('d-1').text, 'big one');
    assert.equal(env.media().length, 0);
    assert.equal(env.downloads.some((d) => d.url.includes('big.png')), false);
    assert.equal(env.row('d-2').text, null);
    // The same start does not hammer it; the next start does, and now the picture arrives.
    assert.deepEqual(await first.run(), { done: 0, lost: 0, failed: 0 });
    const url = [...env.port.messages.values()].find((m) => m.text === 'flaky one').attachments[0].url;
    const served = png('flaky');
    const second = createDiaryMedia({
      db: () => env.handle.db, apply: (u) => applyDiaryUpdate(env.handle, u), port: () => env.port,
      imageFetcher: () => ({ fetchAsDataUrl: async (u) => (u === url ? { dataUrl: dataUrl(served), bytes: served.byteLength, contentType: 'image/png' } : null) }),
      config: () => env.hot.config, dataDir: env.data, sleep: async () => {},
    });
    assert.equal(second.hasWork(), true);
    assert.deepEqual(await second.run(), { done: 1, lost: 0, failed: 0 });
    assert.equal(env.row('d-2').text, 'flaky one');
    assert.equal(env.media().length, 1);
  } finally { env.done(); }
});

test('rows are fetched at most one a second, only with a diary channel, and a new post is picked up by the next run', async () => {
  const env = setup({ posts: [post('d-1', ['x'])] });
  try {
    const a = env.say('one');
    const b = env.say('two');
    env.writePosts([post('d-1', [a]), post('d-2', [b])]);
    env.sync();
    env.hot.config.diary.channelId = '';
    const job = env.job();
    assert.equal(job.hasWork(), true);
    assert.deepEqual(await job.run(), { done: 0, lost: 0, failed: 0 });
    assert.equal(env.port.calls.length, 0);
    env.hot.config.diary.channelId = CHANNEL;
    assert.deepEqual(await job.run(), { done: 2, lost: 0, failed: 0 });
    assert.deepEqual(env.sleeps, [GAP_MS]);
    const c = env.say('three');
    env.writePosts([post('d-1', [a]), post('d-2', [b]), post('d-3', [c])]);
    env.sync();
    assert.equal(job.hasWork(), true);
    assert.deepEqual(await job.run(), { done: 1, lost: 0, failed: 0 });
    assert.equal(env.row('d-3').text, 'three');
  } finally { env.done(); }
});

test('a port failure leaves the post and logs a code only', async () => {
  const env = setup({ posts: [post('d-1', ['x'])] });
  try {
    env.port.failNext('fetchMessages', { status: 'failed', error: { code: 'http-503', retryable: true } });
    env.sync();
    assert.deepEqual(await env.job().run(), { done: 0, lost: 0, failed: 1 });
    assert.equal(env.row('d-1').text, null);
    assert.equal(env.row('d-1').lost, null);
    assert.ok(env.logs.some((entry) => entry.code === 'http-503'));
  } finally { env.done(); }
});

test('verify says the files still equal after the job filled the new columns', async () => {
  const env = setup({ posts: [post('d-1', ['x'])] });
  try {
    const a = env.say('hello', [{ name: 'a.png', bytes: png('a') }]);
    env.writePosts([post('d-1', [a])]);
    env.sync();
    await env.job().run();
    const lines = [];
    const code = main(['verify', '--data', env.data, '--db', env.dbFile], { out: (l) => lines.push(l), err: (l) => lines.push(l) });
    assert.equal(code, 0, lines.join('\n'));
    assert.match(lines.join('\n'), /verify ok/);
  } finally { env.done(); }
});

test('the Discord adapter reads messages by id: text, attachments, and missing for a deleted one', async () => {
  const messages = new Map([['m1', {
    id: 'm1', content: 'a post', attachments: new Map([['a1', { url: 'https://cdn.example/a.png', name: 'a.png', contentType: 'image/png', size: 12 }]]),
  }]]);
  const channel = {
    messages: {
      async fetch(id) {
        if (id === 'boom') throw Object.assign(new Error('x'), { status: 500 });
        if (!messages.has(id)) throw Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 });
        return messages.get(id);
      },
    },
  };
  const port = createDiscordAdapter({ client: { channels: { cache: new Map([['c1', channel]]) }, user: { id: 'me' } } });
  const found = await port.fetchMessages({ iface: 'discord', conversationId: 'c1' }, ['m1', 'm2']);
  assert.equal(found.status, 'ok');
  assert.deepEqual(found.messages, [
    { messageId: 'm1', text: 'a post', attachments: [{ url: 'https://cdn.example/a.png', name: 'a.png', contentType: 'image/png', size: 12 }] },
    { messageId: 'm2', missing: true },
  ]);
  const failed = await port.fetchMessages({ iface: 'discord', conversationId: 'c1' }, ['m1', 'boom']);
  assert.notEqual(failed.status, 'ok');
  const nowhere = await port.fetchMessages({ iface: 'discord', conversationId: 'c9' }, ['m1']);
  assert.equal(nowhere.status, 'failed');
});

test('the service runs the job once the import is done, only with memoryDb.diaryMedia on', async () => {
  const { createMemoryDb } = await import('../src/memory/db/service.js');
  for (const flag of [false, true]) {
    const env = setup({ posts: [post('d-1', ['x'])] });
    env.handle.close();
    fs.rmSync(env.dbFile, { force: true });
    fs.rmSync(`${env.dbFile}-wal`, { force: true });
    fs.rmSync(`${env.dbFile}-shm`, { force: true });
    try {
      const a = env.say('served');
      env.writePosts([post('d-1', [a])]);
      const hot = { config: { ...env.hot.config, features: { memoryDb: true }, memoryDb: { syncSeconds: 60, diaryMedia: flag } } };
      const service = createMemoryDb({
        hot, dataDir: env.data, worker: false, log: { info() {}, warn() {}, error() {}, debug() {} },
        diaryMediaDeps: () => ({ port: env.port, imageFetcher: { fetchAsDataUrl: async () => null } }),
        diarySleep: async () => {},
      });
      await service.tick();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await service.close();
      const reader = openMemoryDb(env.dbFile, { readOnly: true });
      try {
        assert.equal(reader.db.prepare('SELECT text FROM diary WHERE id = ?').get('d-1').text, flag ? 'served' : null);
      } finally { reader.close(); }
    } finally { fs.rmSync(env.root, { recursive: true, force: true }); }
  }
});
