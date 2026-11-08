// A voice message read by the media backfill comes to its text form, and a run that failed comes back to what it left.
//
// Three defects, each measured: `fetchAudio` (src/media/fetch-video.ts) takes only `video/*` answers, so a clip the CDN serves as
// `audio/ogg` never reaches ffmpeg and is cached as a `download` miss. `backfillMedia` (src/memory/db/media-backfill.ts) reads a
// line by `sources.native_id`, which on a line observed through the family catalog is a key of the catalog and not the
// platform's message id: the platform refuses the read and the place is counted failed. A linked item with a cached `download`
// miss holds its reference, so no later run lists it.
//
// The contract these tests add: `BackfillReport.linesLeft` counts the lines a failed read left for the next run, and a place
// whose read failed gets one more read in the same run. Fake platform, fake CDN, fake ffmpeg, fake model; synthetic content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { spawn } from 'node:child_process';
import { createVideoFetcher } from '../src/media/fetch-video.ts';
import { applyMediaBackfill, backfillMedia, mediaBackfillDesk } from '../src/memory/db/media-backfill.ts';
import { lineMedia, tellMedia } from '../src/memory/db/media-store.ts';
import { rootPlaceInDb } from '../src/memory/db/place-tree.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import { createDescriber } from '../src/memory/describe.ts';
import { createStore } from '../src/memory/store.ts';
import { fakeLlm, fakeState, fakeVideoFetcher } from './fixtures/describe-fakes.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { AT, ALICE, GENERAL, GROUP_SCOPE, KINDS, NOW, eventOf, fixture } from './fixtures/media-memory.ts';
import { channelPlaceId } from '../src/memory/db/ids.ts';
import { tempDir } from './fixtures/tmp.ts';
import type { Env, Kind } from './fixtures/media-memory.ts';
import type { HistoryQuery } from '../src/protocol/adapter.ts';
import type { Row } from '../src/memory/db/types.ts';
import { memoryAt } from './fixtures/store-kit.ts';

const IMAGE = KINDS[0];
const VOICE = KINDS.find((kind) => kind.name === 'voice received') as Kind;
const MINUTE = 60_000;
const OTHER = channelPlaceId('discord', 'c2');
const CHAT = { id: 'c1', kind: 'channel', rootId: 'g1', name: 'general' };
const IN_OTHER = { id: 'c2', kind: 'channel', rootId: 'g1' };
const HEARD = 'she says "грибы рано в этом году"';
/** A key of the family catalog, the form `sources.native_id` holds on a line observed through it. */
const FAMILY_KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const FAMILY_KEY_2 = '550e8400-e29b-41d4-a716-446655440000';

async function withEnv(body: (env: Env) => void | Promise<void>) {
  const env = fixture();
  try {
    await body(env);
  } finally {
    env.done();
  }
}

/** A line as the store holds it after the migration: bare items with no reference, linked. `messageId` gives it a locator. */
function bareLine(
  env: Env,
  {
    native,
    messageId,
    kinds = ['image', 'image'],
    at = AT,
    place = GENERAL,
    chatId = 'c1',
  }: { native: string; messageId?: string; kinds?: Array<string>; at?: number; place?: string; chatId?: string }
): string {
  const locator =
    messageId === undefined
      ? {}
      : { $messageLocator: { v: 1, origin: 'protocol-message', iface: 'discord', chatId, messageId } };
  const id = env.say({
    native,
    at,
    text: '',
    place,
    author: ALICE,
    scope: GROUP_SCOPE,
    extra: JSON.stringify({ subtype: 'seen', ...locator }),
  });
  env.db
    .prepare(
      `UPDATE sources SET mentions = '[]', origin = 'observation', authority_id = 'discord/global', author_kind = 'account',
       observed_at = occurred_at, seen_at = occurred_at, native_kind = 'message', generation = 1 WHERE id = ?`
    )
    .run(id);
  kinds.forEach((kind, position) => {
    const mediaId = `media:bare:${native}:${position}`;
    env.db
      .prepare(
        `INSERT INTO media (id, kind, availability, scope_kind, scope_iface) VALUES (?, ?, 'unknown', 'group', 'discord')`
      )
      .run(mediaId, kind);
    env.db
      .prepare("INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('source', ?, ?, ?)")
      .run(id, position, mediaId);
  });
  return id;
}

/** A platform holding `events`: a read by anything but a message id of its own form is refused, as Discord answers a 400. */
function platform(events: Array<Row>) {
  const reads: Array<{ chatId: string; query: HistoryQuery }> = [];
  const idOf = (event: Row) => BigInt(String((event.message as Row).id));
  const read = (chatId: string, query: HistoryQuery) => {
    reads.push({ chatId, query });
    if (query.around !== undefined && !/^\d+$/.test(query.around)) {
      return Promise.resolve({ status: 'failed', events: [], complete: false });
    }
    const held = events
      .filter((event) => (event.chat as Row).id === chatId)
      .sort((a, b) => (idOf(a) < idOf(b) ? -1 : 1));
    const at = held.findIndex((event) => idOf(event) >= BigInt(query.around ?? '0'));
    const start = Math.max(0, (at < 0 ? held.length : at) - Math.floor(query.limit / 2));
    const page = held.slice(start, start + query.limit);
    return Promise.resolve({ status: 'ok', events: page, complete: page.length < query.limit });
  };
  return { read, reads };
}

function run(env: Env, read: ReturnType<typeof platform>['read'], over: Row = {}) {
  const described: Array<Row> = [];
  return backfillMedia({
    db: env.db,
    read,
    write: (update: Row) => Promise.resolve(applyMediaBackfill(env.handle, update)),
    describe: (_placeId: string, items: Array<Row>) => {
      described.push(...items);
      return Promise.resolve();
    },
    now: NOW,
    pageSize: 100,
    ...over,
  }).then((report) => ({ report, described }));
}

const rowsOf = (env: Env, source: string) => lineMedia(env.db, [source], internalContext(), 'source').get(source) ?? [];
const imageEvent = (id: string, chat: Row = CHAT) => eventOf(IMAGE, id, [true, true], { chat });

/** A voice message of one attachment, as the interface reads it. */
function voiceEvent(id: string, ref: string, chat: Row = CHAT) {
  const event = eventOf(VOICE, id, [false, false], { chat });
  (event.message as { attachments: Array<Row> }).attachments = [
    { id: ref, kind: 'voice', name: 'voice-1.ogg', durationSec: 9, url: `https://cdn.example.invalid/${ref}.ogg` },
  ];
  return event;
}

/** A voice item that an earlier run linked, its failure cached on its row, as a run before the fix left it. */
async function linkedVoiceWithMiss(
  env: Env,
  {
    id,
    ref,
    reason,
    chat = CHAT,
    place = GENERAL,
  }: { id: string; ref: string; reason: string; chat?: Row; place?: string }
) {
  const source = bareLine(env, { native: id, kinds: ['voice'], place });
  await run(env, platform([voiceEvent(id, ref, chat)]).read);
  env.db
    .prepare("UPDATE media SET extra = json_set(COALESCE(extra, '{}'), '$.cache', json(?)) WHERE native_ref = ?")
    .run(JSON.stringify({ [ref]: { miss: true, ts: NOW - 10 * MINUTE, reason } }), ref);
  return source;
}

/** A spawn whose ffmpeg writes a clip to its last argument and exits 0, and notes every run. */
function fakeFfmpeg() {
  const runs: Array<Array<string>> = [];
  const spawnImpl = (_command: string, args: Array<string>) => {
    runs.push(args);
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => true,
    });
    setImmediate(() => {
      fs.writeFileSync(String(args.at(-1)), 'clip');
      child.emit('close', 0, null);
    });
    return child;
  };
  return { spawnImpl: wrongly<typeof spawn>(spawnImpl), runs };
}

/** A fetcher over a fake CDN answering `contentType`, with the fake ffmpeg. */
function fetcherOver(contentType: string) {
  const ffmpeg = fakeFfmpeg();
  const fetcher = createVideoFetcher({
    platform: 'linux',
    tmpDir: tempDir('nep-voice-'),
    spawnImpl: ffmpeg.spawnImpl,
    fetchImpl: wrongly<typeof fetch>(() =>
      Promise.resolve(
        new Response(Buffer.from('OggS-voice-bytes'), { status: 200, headers: { 'content-type': contentType } })
      )
    ),
  });
  return { fetcher, ffmpeg };
}

const AUDIO_OPTIONS = { durationSec: 9, maxSeconds: 300, maxBytes: 1000, toolTimeoutMs: 5000, ffmpegPath: 'ffmpeg' };

function describerOver(videoFetcher: object) {
  const store = createStore(memoryAt(tempDir('nep-voice-store-')));
  const llm = fakeLlm({ text: HEARD, model: 'x/flash' });
  const describer = createDescriber({
    hot: {
      config: {
        models: { base: { vision: 'x/vision', video: 'x/flash' } },
        media: { maxOutputTokens: 120, video: {} },
        context: { vision: { fetchTimeoutMs: 10_000 } },
      },
      prompts: { describe: 'Describe.', 'describe-audio': 'Retell what is heard in up to {{maxChars}} characters.' },
    },
    store,
    llm,
    videoFetcher,
    now: () => NOW,
    state: fakeState(),
  });
  return { describer, store, llm };
}

// ---------- the download ----------

for (const contentType of ['audio/ogg', 'audio/mpeg']) {
  test(`fetchAudio hands a clip served as ${contentType} to ffmpeg and answers the packaged clip`, async () => {
    const { fetcher, ffmpeg } = fetcherOver(contentType);
    const clip = await fetcher.fetchAudio('https://cdn.example.invalid/voice-1.ogg?ex=1', AUDIO_OPTIONS);
    assert.equal(clip.ok, true, `refused: ${String((clip as Row).reason)}`);
    assert.equal(ffmpeg.runs.length, 1);
    assert.equal(
      (clip as { dataUrl: string }).dataUrl,
      `data:video/mp4;base64,${Buffer.from('clip').toString('base64')}`
    );
  });
}

test('a voice message the CDN serves as audio/ogg comes through the describer to its text form, with no miss cached', async () => {
  const { fetcher } = fetcherOver('audio/ogg');
  const { describer, store, llm } = describerOver(fetcher);
  const item = {
    source: 'attachment',
    messageId: '1700',
    itemId: 'v1',
    kind: 'voice',
    url: 'https://cdn.example.invalid/voice-1.ogg?ex=1',
    name: 'voice-1.ogg',
    durationSec: 9,
  };
  const { descriptions } = await describer.describeMany('g1', [item]);
  assert.equal(descriptions.get('v1'), HEARD);
  assert.equal(llm.calls.length, 1);
  assert.equal((store.getMediaCache('g1') as Record<string, Row>).v1.miss, undefined);
});

test('fetchAudio still refuses the page a CDN answers with in place of the file, and runs no ffmpeg', async () => {
  const audio = await fetcherOver('audio/ogg').fetcher.fetchAudio('https://cdn.example.invalid/a.ogg', AUDIO_OPTIONS);
  assert.equal(audio.ok, true, 'an audio answer passes the same gate');
  const { fetcher, ffmpeg } = fetcherOver('text/html');
  const page = await fetcher.fetchAudio('https://cdn.example.invalid/a.ogg', AUDIO_OPTIONS);
  assert.deepEqual(page, { ok: false, reason: 'download' });
  assert.equal(ffmpeg.runs.length, 0);
});

// ---------- the retry of a cached miss ----------

test('a re-run reads again a linked voice whose download failed, and leaves one refused for its size', () =>
  withEnv(async (env) => {
    await linkedVoiceWithMiss(env, { id: '1801', ref: 'v1', reason: 'download' });
    await linkedVoiceWithMiss(env, {
      id: '1802',
      ref: 'v2',
      reason: 'size',
      chat: IN_OTHER,
      place: OTHER,
    });
    const { read, reads } = platform([voiceEvent('1801', 'v1'), voiceEvent('1802', 'v2', IN_OTHER)]);
    const { described } = await run(env, read);
    assert.deepEqual(
      reads.map((one) => one.chatId),
      ['c1']
    );
    assert.deepEqual(
      described.map((item) => item.itemId),
      ['v1']
    );
  }));

test('a voice told since its failed download is not read again', () =>
  withEnv(async (env) => {
    await linkedVoiceWithMiss(env, { id: '1803', ref: 'v3', reason: 'download' });
    const first = platform([voiceEvent('1803', 'v3')]);
    assert.equal((await run(env, first.read)).described.length, 1, 'the re-run hands it to the describer');
    tellMedia(env.handle, { iface: 'discord', nativeRef: 'v3', description: HEARD, origin: 'transcript' });
    const second = platform([voiceEvent('1803', 'v3')]);
    await run(env, second.read);
    assert.equal(second.reads.length, 0);
  }));

test("the owner's re-run hears a voice through a download miss cached minutes ago", () =>
  withEnv(async (env) => {
    await linkedVoiceWithMiss(env, { id: '1804', ref: 'v4', reason: 'download' });
    const heard: Array<string> = [];
    const videoFetcher = {
      ...fakeVideoFetcher(),
      fetchAudio: (url: string) => {
        heard.push(url);
        return Promise.resolve({ ok: true, dataUrl: 'data:video/mp4;base64,YQ==', seconds: 9, bytes: 1 });
      },
    };
    const { describer, store, llm } = describerOver(videoFetcher);
    const placeId = rootPlaceInDb(env.db, GENERAL) ?? GENERAL;
    (store.getMediaCache(placeId) as Record<string, Row>).v4 = {
      miss: true,
      ts: NOW - 10 * MINUTE,
      reason: 'download',
    };
    const { read } = platform([voiceEvent('1804', 'v4')]);
    const desk = mediaBackfillDesk({
      memoryDb: {
        database: () => env.db,
        memoryWrite: (update) => Promise.resolve(applyMediaBackfill(env.handle, update as Row)),
      },
      reads: {
        history: async (where, query) => {
          const { status, ...body } = await read(where.chatId, query);
          return status === 'ok' ? body : null;
        },
      },
      iface: () => 'discord',
      describer,
      now: () => NOW,
      log: { warn: () => undefined },
    });
    await desk.start({ dryRun: false });
    while (desk.status().state === 'running') await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(desk.status().state, 'done');
    assert.deepEqual(heard, ['https://cdn.example.invalid/v4.ogg']);
    assert.equal(llm.calls.length, 1);
    assert.equal((store.getMediaCache(placeId) as Record<string, Row>).v4.text, HEARD);
  }));

// ---------- the read of a line under a family key ----------

test('a line whose native id is a family key is read by the message id of its locator', () =>
  withEnv(async (env) => {
    const source = bareLine(env, { native: FAMILY_KEY, messageId: '1700' });
    const { read, reads } = platform([imageEvent('1700')]);
    const { report } = await run(env, read);
    assert.equal(reads[0].query.around, '1700');
    assert.deepEqual([report.linked, report.failedPlaces, report.gone], [1, 0, 0]);
    assert.equal(rowsOf(env, source)[0].nativeRef, '1700-a');
  }));

test('the run keeps the locator of a line under a family key', () =>
  withEnv(async (env) => {
    const source = bareLine(env, { native: FAMILY_KEY, messageId: '1701' });
    const { report } = await run(env, platform([imageEvent('1701')]).read);
    assert.equal(report.linked, 1, 'the read answered, so the writer had the locator in hand');
    const extra = JSON.parse(
      String(env.db.prepare('SELECT extra FROM sources WHERE id = ?').get(source)?.extra)
    ) as Row;
    assert.deepEqual(extra.$messageLocator, {
      v: 1,
      origin: 'protocol-message',
      iface: 'discord',
      chatId: 'c1',
      messageId: '1701',
    });
  }));

test('a deleted message under a family key counts as gone, never as a failed place', () =>
  withEnv(async (env) => {
    bareLine(env, { native: FAMILY_KEY, messageId: '1702' });
    const { report } = await run(env, platform([imageEvent('1600')]).read);
    assert.deepEqual([report.gone, report.failedPlaces], [1, 0]);
  }));

test('lines are read in the order of their messages, whichever form their native id has', () =>
  withEnv(async (env) => {
    bareLine(env, { native: FAMILY_KEY, messageId: '1500', at: AT });
    bareLine(env, { native: '1600', at: AT + MINUTE });
    bareLine(env, { native: FAMILY_KEY_2, messageId: '1700', at: AT + 2 * MINUTE });
    const { read, reads } = platform([imageEvent('1500'), imageEvent('1600'), imageEvent('1700')]);
    const { report } = await run(env, read, { pageSize: 1 });
    assert.deepEqual(
      reads.map((one) => one.query.around),
      ['1500', '1600', '1700']
    );
    assert.equal(report.linked, 3);
  }));

test('a library row naming the message of a line under a family key links it with no read', () =>
  withEnv(async (env) => {
    const source = bareLine(env, { native: FAMILY_KEY, messageId: '1703', kinds: ['gif'] });
    env.db
      .prepare(
        `INSERT INTO media (id, kind, native_ref, description, availability, extra, scope_kind, scope_iface)
         VALUES ('media:gif:k', 'gif', '1703', 'a pirouette on ice', 'present', '{}', 'group', 'discord')`
      )
      .run();
    const { read, reads } = platform([]);
    const { report } = await run(env, read);
    assert.equal(reads.length, 0);
    assert.equal(report.classes.named, 1);
    assert.equal(rowsOf(env, source)[0].nativeRef, '1703');
  }));

// ---------- a failed read ----------

test('a read that fails once is read again in the same run, and nothing is left', () =>
  withEnv(async (env) => {
    const source = bareLine(env, { native: '1901' });
    const healthy = platform([imageEvent('1901')]);
    let failures = 1;
    const flaky: typeof healthy.read = (chatId, query) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.resolve({ status: 'failed', events: [], complete: false });
      }
      return healthy.read(chatId, query);
    };
    const { report } = await run(env, flaky);
    assert.deepEqual([report.linked, report.failedPlaces, report.linesLeft], [1, 0, 0]);
    assert.equal(rowsOf(env, source)[0].nativeRef, '1901-a');
  }));

test('a place that keeps failing counts its place and the lines it left, and the next run finishes only those', () =>
  withEnv(async (env) => {
    bareLine(env, { native: '1902', at: AT });
    bareLine(env, { native: '1903', at: AT + MINUTE });
    const healthy = platform([imageEvent('1902'), imageEvent('1903')]);
    const broken: typeof healthy.read = (chatId, query) =>
      query.around === '1903'
        ? Promise.resolve({ status: 'failed', events: [], complete: false })
        : healthy.read(chatId, query);
    const first = await run(env, broken, { pageSize: 1 });
    assert.deepEqual([first.report.linked, first.report.failedPlaces, first.report.linesLeft], [1, 1, 1]);
    assert.equal(first.report.classes['read-failed'], 1);
    healthy.reads.length = 0;
    const second = await run(env, healthy.read, { pageSize: 1 });
    assert.deepEqual([second.report.linked, second.report.failedPlaces, second.report.linesLeft], [1, 0, 0]);
    assert.deepEqual(
      healthy.reads.map((one) => one.query.around),
      ['1903']
    );
  }));
