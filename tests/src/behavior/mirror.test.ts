// Tests for src/behavior/mirror.ts, the diary's mirrors: a recorded entry is published once to every enabled mirror,
// each publication a `publications` row keyed `diary:<entry id>:<place id>`, queued while the interface is down and
// sent when it connects, `failed` with the port's code when the port refuses, never sent twice, and refused when the
// stored entry carries a restriction its mirror does not meet. Every entry comes from a real diary turn over a real
// store and memory database, on the fake interface, with a scripted model. Synthetic text only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chunkPictures, createMirrors, guardMirrorPort } from '../../../src/behavior/mirror.ts';
import { createStore } from '../../../src/memory/store.ts';
import { notOk } from '../../../src/protocol/actions.ts';
import type { Content } from '../../../src/protocol/actions.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { ROOT, NOW, sceneHot, sceneLlm, sceneRunner } from '../../fixtures/diary-requests-recorded.ts';
import { dbOf, diaryPublications, diaryRows, entryOf, seedMirror, publishTo } from '../../fixtures/diary-mirror.ts';
import type { RecordedEntry } from '../../fixtures/diary-mirror.ts';
import { openTestMemory } from '../../fixtures/memory-db/service.ts';
import { call, toolAnswer, completionOf } from '../../fixtures/tool-answers.ts';
import { freshWorld, world, attachmentCount, onWorld, useIface, useSelf } from '../../fixtures/turn-world.ts';
import type { Channel } from '../../fixtures/turn-world.ts';
import { worldTurnRunner } from '../../fixtures/world-runner.ts';
import { directorAnswer } from '../../fixtures/scene-answer.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { rawMessage } from '../../fixtures/turn-harness.ts';
import '../../../src/tools/operations/index.ts';
import { createTurnRunner as createRealTurnRunner } from '../../../src/behavior/turn.ts';
import { labels } from '../../fixtures/labels.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { mirrorScene, FOUR_HOURS, OWNER, T0, restoreFile } from '../../fixtures/mirror-scene.ts';
import type { Scene } from '../../fixtures/mirror-scene.ts';
import { FRAME_NOW, JOURNAL, PAGES, TEXT as FRAME_TEXT, frameTurn } from '../../fixtures/diary-frame.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import fs from 'node:fs';
import { SELF_PERSON } from '../../../src/memory/db/ids.ts';
import type { Db } from '../../../src/memory/db/types.ts';

const TEXT = 'ήσυχο βράδυ στο λιμάνι';

/** The memory databases the scenes opened, closed when the file is done. */
const OPEN: Array<{ close(): unknown }> = [];
after(async () => {
  for (const item of OPEN.splice(0)) await item.close();
});

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
  const memory = await openTestMemory({ now: () => NOW });
  OPEN.push(memory);
  freshWorld();
  world().channel({ id: 'd1', name: 'journal', placeId: ROOT });
  world().channel({ id: 'd2', name: 'notes', placeId: ROOT });
  const store = createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb });
  const places = specs.map((spec) => seedMirror(memory.memoryDb, { iface: 'fake', at: NOW, ...spec }).placeId);
  const link = { connected };
  const mirrors = createMirrors({
    memoryDb: memory.memoryDb,
    port: () => (link.connected ? world().port : null),
    now: () => NOW,
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

// The entry is handed to the publisher as the diary's post does.
test('a diary entry with one enabled mirror publishes the entry once, and a reconnect sends nothing more', async () => {
  const core = await scene({ mirrors: [{ chatId: 'd1' }] });
  await core.mirrors.publishEntry(await core.record());
  await core.store.flushSettled({});
  assert.deepEqual(core.texts('d1'), [TEXT]);
  core.link.connected = false;
  core.link.connected = true;
  assert.equal(await core.mirrors.drainQueued(), 0, 'nothing is left to send');
  assert.deepEqual(core.texts('d1'), [TEXT], 'still one message');
  const [entry] = diaryRows(core.memory.memoryDb);
  assert.ok(entry);
  const sentIds = world()
    .port.messagesIn('d1')
    .map((message) => message.ref.messageId);
  assert.deepEqual(diaryPublications(core.memory.memoryDb), [
    {
      status: 'sent',
      key: `diary:${entry.id}:${core.places[0]}`,
      placeId: core.places[0],
      receiptKeys: sentIds,
    },
  ]);
});

test('an entry recorded while no interface is connected stays queued, and the connection sends it once', async () => {
  const core = await scene({ mirrors: [{ chatId: 'd1' }], connected: false });
  await core.mirrors.publishEntry(await core.record());
  await core.store.flushSettled({});
  assert.deepEqual(core.texts('d1'), []);
  assert.deepEqual(
    diaryPublications(core.memory.memoryDb).map((row) => row.status),
    ['queued']
  );
  core.link.connected = true;
  assert.equal(await core.mirrors.drainQueued(), 1);
  assert.equal(await core.mirrors.drainQueued(), 0, 'a second drain finds nothing queued');
  assert.deepEqual(core.texts('d1'), [TEXT]);
  assert.deepEqual(
    diaryPublications(core.memory.memoryDb).map((row) => row.status),
    ['sent']
  );
});

test('a send the port refuses leaves the publication failed with its code, and the entry stays in memory', async () => {
  const core = await scene({ mirrors: [{ chatId: 'd1' }] });
  const entry = await core.record();
  world().port.failNext('send', notOk('failed', 'channel-no-permission'));
  const outcomes = await core.mirrors.publishEntry(entry);
  assert.deepEqual(outcomes, [{ placeId: core.places[0], status: 'failed', code: 'channel-no-permission' }]);
  assert.deepEqual(
    diaryPublications(core.memory.memoryDb).map((row) => row.status),
    ['failed']
  );
  assert.deepEqual(diaryRows(core.memory.memoryDb), [{ id: entry.id, kind: 'status', text: TEXT }]);
});

test('a disabled mirror gets nothing and is still listed', async () => {
  const core = await scene({ mirrors: [{ chatId: 'd1' }, { chatId: 'd2', enabled: false }] });
  const entry = await core.record();
  const outcomes = await core.mirrors.publishEntry(entry);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.placeId),
    [core.places[0]]
  );
  assert.deepEqual(core.texts('d2'), []);
  assert.deepEqual(
    diaryPublications(core.memory.memoryDb).map((row) => row.placeId),
    [core.places[0]]
  );
  assert.deepEqual(
    core.mirrors
      .listMirrors()
      .map((mirror) => [mirror.placeId, mirror.enabled])
      .sort(),
    [
      [core.places[0], true],
      [core.places[1], false],
    ]
  );
});

test('two enabled mirrors of different places each get the entry once, also when it is published again', async () => {
  const core = await scene({ mirrors: [{ chatId: 'd1' }, { chatId: 'd2' }] });
  const entry = await core.record();
  await core.mirrors.publishEntry(entry);
  const again = await core.mirrors.publishEntry(entry);
  assert.deepEqual(
    again.map((outcome) => outcome.status),
    ['sent', 'sent'],
    'the second publication reuses the sent rows'
  );
  assert.deepEqual([core.texts('d1'), core.texts('d2')], [[TEXT], [TEXT]]);
  assert.deepEqual(
    diaryPublications(core.memory.memoryDb)
      .map((row) => row.key)
      .sort(),
    [`diary:${entry.id}:${core.places[0]}`, `diary:${entry.id}:${core.places[1]}`].sort()
  );
});

// ---- an entry with pictures and a voice ------------------------------------------------------------------------

const WALK = 'une promenade au port';

/**
 * The scene's settings with the draw prompt. PR 7d: drawing and speech are code, and `photoset` is a set kind of the
 * constants of src/behavior/diary.ts (at least two pictures posted, at most 8 000 000 bytes in one message).
 */
function setAndVoiceHot() {
  const base = sceneHot();
  return { config: base.config, prompts: { ...base.prompts, draw: 'DRAW for {{name}}\n{{when}}\n{{request}}' } };
}

/** A model that plans a `photoset` with a picture, then writes one message with two pictures and a voice message. */
function setAndVoiceLlm() {
  const calls: Array<unknown> = [];
  let written = 0;
  return {
    calls,
    complete: (messages: unknown, options?: { purpose?: string }) => {
      calls.push(messages);
      const scene = directorAnswer(messages, options);
      if (scene) return Promise.resolve(scene);
      written += 1;
      return Promise.resolve(
        written === 1
          ? toolAnswer(`<msg>${WALK}</msg>`, [
              call('draw.create', { people: [], text: 'scene 1' }),
              call('draw.create', { people: [], text: 'scene 2' }),
              call('voice.say', { text: WALK }),
            ])
          : { text: `<msg>${WALK}</msg>`, usage: {}, estimated: 5 }
      );
    },
  };
}

/** The turn runner of an entry with two pictures of `pictureBytes` each and a voice, over the scene's store. */
function setAndVoiceTurns(store: Awaited<ReturnType<typeof scene>>['store'], pictureBytes = 3) {
  return worldTurnRunner({
    hot: setAndVoiceHot(),
    store,
    llm: setAndVoiceLlm(),
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    images: {
      generate: () =>
        Promise.resolve({ buffer: Buffer.alloc(pictureBytes, 1), mediaType: 'image/png', seconds: 1, cost: 0 }),
    },
    // The speech client as src/speech/index.ts#createSpeech answers: the voice file and what was voiced.
    speech: {
      say: ({ text }: { text: string }) =>
        Promise.resolve({
          ogg: Buffer.from('ogg'),
          durationSecs: 2.5,
          waveform: 'AAAA',
          voiced: text,
          chars: 21,
          cost: 0,
        }),
    },
    rng: () => 0.5,
    now: () => NOW,
  });
}

// The order is the one a diary post goes out in from the turn: the voice is sent while the step's calls run, the
// persona's message and the staged pictures after them (src/behavior/turn.ts, the act path). The publisher sends all three one
// after another.
test('an entry with two pictures and a voice reaches the mirror as the voice, the message, then the pictures', async () => {
  const core = await scene({ mirrors: [{ chatId: 'd1' }] });
  const turns = setAndVoiceTurns(core.store);
  const result = await turns.runTurn({
    mode: 'diary',
    diary: { kind: 'photoset', forced: true },
    placeId: ROOT,
  });
  await core.store.flushSettled({});
  assert.deepEqual(world().port.messagesIn('d1'), [], 'the turn itself sends nothing');
  await core.mirrors.publishEntry(entryOf(result));
  const sent = world().port.messagesIn('d1');
  assert.deepEqual(
    sent.map((message) => [message.text, message.attachments.map((attachment) => attachment.contentType)]),
    [
      ['', ['audio/ogg']],
      [WALK, []],
      ['', ['image/png', 'image/png']],
    ],
    'the voice, then the message, then one message of both pictures'
  );
  assert.deepEqual(
    diaryPublications(core.memory.memoryDb).map((row) => row.receiptKeys),
    [sent.map((message) => message.ref.messageId)],
    'the receipts name every message, the voice included'
  );
});

// A row still queued is sent when the interface connects, also after a restart. The
// entry's pictures and voice are on disk, so the restarted publisher sends the whole entry, not its text alone.
test('an entry with pictures and a voice queued before a restart goes out whole when the interface connects', async () => {
  const core = await scene({ mirrors: [{ chatId: 'd1' }], connected: false });
  const result = await setAndVoiceTurns(core.store).runTurn({
    mode: 'diary',
    diary: { kind: 'photoset', forced: true },
    placeId: ROOT,
  });
  await core.store.flushSettled({});
  await core.mirrors.publishEntry(entryOf(result));
  assert.deepEqual(world().port.messagesIn('d1'), [], 'queued while no interface is connected');
  // The process restarts: a new publisher over the same memory and data directory, then the interface connects.
  const restarted = createMirrors({
    memoryDb: core.memory.memoryDb,
    port: () => world().port,
    now: () => NOW,
    dataDir: core.memory.dataDir,
  });
  assert.equal(await restarted.drainQueued(), 1);
  assert.equal(await restarted.drainQueued(), 0, 'sent once');
  const sent = world().port.messagesIn('d1');
  assert.deepEqual(
    sent.map((message) => [message.text, message.attachments.map((attachment) => attachment.contentType)]),
    [
      ['', ['audio/ogg']],
      [WALK, []],
      ['', ['image/png', 'image/png']],
    ],
    'the voice, then the message, then one message of both pictures'
  );
  assert.deepEqual(
    diaryPublications(core.memory.memoryDb).map((row) => row.receiptKeys),
    [sent.map((message) => message.ref.messageId)],
    'the receipts name every message, the voice included'
  );
});

// The persona's diary is the truth: when the port names the attachments each message became, the
// publication keeps them in its receipts and the entry's media rows take their attachment ids from there.
test("a publication keeps the port's attachment ids in its receipts and on the entry's media rows", async () => {
  const core = await scene({ mirrors: [{ chatId: 'd1' }] });
  const result = await setAndVoiceTurns(core.store).runTurn({
    mode: 'diary',
    diary: { kind: 'photoset', forced: true },
    placeId: ROOT,
  });
  await core.store.flushSettled({});
  let made = 0;
  // The port's answer to a send names each attachment by the platform's id, with the message that carries it.
  const naming = {
    iface: 'fake',
    send: async (chat: { iface: string; chatId: string }, content: Content) => {
      const delivery = await world().port.send(chat, content);
      const messageId = delivery.ref?.messageId ?? '';
      const attachments = (content.attachments ?? []).map(() => ({ messageId, attachmentId: `att-${(made += 1)}` }));
      return { ...delivery, attachments };
    },
  };
  const mirrors = createMirrors({
    memoryDb: core.memory.memoryDb,
    port: () => naming,
    now: () => NOW,
    dataDir: core.memory.dataDir,
  });
  await mirrors.publishEntry(entryOf(result));
  const named = ['att-1', 'att-2', 'att-3'];
  assert.equal(made, 3, 'the voice and the two pictures');
  const [publication] = diaryPublications(core.memory.memoryDb);
  assert.ok(publication, 'the entry was published');
  assert.deepEqual(
    named.filter((id) => publication.receiptKeys.includes(id)),
    named,
    'every attachment id is in the receipts'
  );
  const entry = entryOf(result);
  const rows = dbOf(core.memory.memoryDb)
    .prepare(
      `SELECT m.native_ref, m.extra FROM media m JOIN media_links l ON l.media_id = m.id
       WHERE l.owner_kind = 'diary' AND l.owner_id = ? ORDER BY l.position`
    )
    .all(entry.id)
    .map((row) => row.native_ref);
  assert.deepEqual([...rows].sort(), named, "the entry's media rows carry the ids");
});

// A post whose pictures do not fit one message goes out as several messages of files (diary.set.maxMessageBytes): each
// attachment the port names keeps the message that carried it, in the receipts and on its media row.
test('a picture set sent across two messages keeps every attachment id with the message that carried it', async () => {
  const core = await scene({ mirrors: [{ chatId: 'd1' }] });
  // PR 7d: a message holds the constant 8 000 000 bytes, so two pictures of 4 100 000 bytes need two messages.
  const result = await setAndVoiceTurns(core.store, 4_100_000).runTurn({
    mode: 'diary',
    diary: { kind: 'photoset', forced: true },
    placeId: ROOT,
  });
  await core.store.flushSettled({});
  const carried: Array<{ messageId: string; attachmentId: string }> = [];
  const naming = {
    iface: 'fake',
    send: async (chat: { iface: string; chatId: string }, content: Content) => {
      const delivery = await world().port.send(chat, content);
      const messageId = delivery.ref?.messageId ?? '';
      const attachments = (content.attachments ?? []).map(() => {
        const named = { messageId, attachmentId: `att-${carried.length + 1}` };
        carried.push(named);
        return named;
      });
      return { ...delivery, attachments };
    },
  };
  const mirrors = createMirrors({
    memoryDb: core.memory.memoryDb,
    port: () => naming,
    now: () => NOW,
    dataDir: core.memory.dataDir,
  });
  await mirrors.publishEntry(entryOf(result));
  const pictureMessages = world()
    .port.messagesIn('d1')
    .filter((message) => message.attachments.some((attachment) => attachment.contentType === 'image/png'));
  assert.equal(pictureMessages.length, 2, 'the pictures went out in two messages');
  const [publication] = diaryPublications(core.memory.memoryDb);
  assert.ok(publication, 'the entry was published');
  const ids = carried.map((item) => item.attachmentId);
  assert.deepEqual(
    ids.filter((id) => publication.receiptKeys.includes(id)),
    ids,
    'every attachment id is in the receipts'
  );
  const rows = dbOf(core.memory.memoryDb)
    .prepare(
      `SELECT m.native_ref, m.extra FROM media m JOIN media_links l ON l.media_id = m.id
       WHERE l.owner_kind = 'diary' AND l.owner_id = ? ORDER BY l.position`
    )
    .all(entryOf(result).id)
    .map((row) => ({
      messageId: (JSON.parse(typeof row.extra === 'string' ? row.extra : '{}') as { messageId?: unknown }).messageId,
      attachmentId: row.native_ref,
    }));
  const byId = (list: Array<{ attachmentId?: unknown }>) =>
    [...list].sort((a, b) => String(a.attachmentId).localeCompare(String(b.attachmentId)));
  assert.deepEqual(byId(rows), byId(carried), 'each media row names its attachment and the message that carried it');
});

const RESTRICTED_ENTRY = { kind: 'internal-turn', origin: { iface: 'cli', chatId: 'd1' } } as const;

async function restrictStoredEntry(core: Awaited<ReturnType<typeof scene>>, metadata: unknown): Promise<void> {
  const posts = core.store.getDiary().posts.map((post) => ({ ...post, publicationBoundary: metadata }));
  core.store.setDiaryPosts(posts);
  await core.store.flushSettled({});
}

for (const metadata of [RESTRICTED_ENTRY, null, { kind: 'internal-turn', origin: {} }]) {
  test(`a fresh mirror publisher refuses a queued entry with a stored ${metadata === RESTRICTED_ENTRY ? 'foreign' : metadata === null ? 'null' : 'malformed'} restriction`, async () => {
    // Catches restoring a queued row through rendered text without rechecking its stored diary restriction.
    const core = await scene({ mirrors: [{ chatId: 'd1' }], connected: false });
    const entry = await core.record();
    await core.mirrors.queueEntry(entry);
    assert.deepEqual(
      diaryPublications(core.memory.memoryDb).map((row) => row.status),
      ['queued']
    );
    await restrictStoredEntry(core, metadata);
    const restarted = createMirrors({
      memoryDb: core.memory.memoryDb,
      port: () => world().port,
      now: () => NOW,
      dataDir: core.memory.dataDir,
    });
    assert.equal(await restarted.drainQueued(), 0);
    assert.deepEqual(core.texts('d1'), []);
    assert.deepEqual(
      diaryPublications(core.memory.memoryDb).map((row) => row.status),
      ['failed']
    );
    assert.equal(diaryRows(core.memory.memoryDb)[0].text, TEXT);
  });
}

test('publishing an entry without supplied metadata cannot clear its stored restriction', async () => {
  // Catches trusting the caller entry object over the authoritative saved diary row.
  const core = await scene({ mirrors: [{ chatId: 'd1' }] });
  const entry = await core.record();
  await restrictStoredEntry(core, RESTRICTED_ENTRY);
  const result = await core.mirrors.publishEntry(entry);
  assert.deepEqual(
    result.map(({ status, code }) => ({ status, code })),
    [{ status: 'failed', code: 'not-allowed' }]
  );
  assert.deepEqual(core.texts('d1'), []);
});

test('a same-origin restriction permits a mirror send without changing ordinary standing grants', async () => {
  // Catches replacing the exact-origin rule with a blanket ban on restricted entries.
  const core = await scene({ mirrors: [{ chatId: 'd1' }] });
  const entry = await core.record();
  await restrictStoredEntry(core, { kind: 'internal-turn', origin: { iface: 'fake', chatId: 'd1' } });
  const result = await core.mirrors.publishEntry(entry);
  assert.equal(result[0].status, 'sent');
  assert.deepEqual(core.texts('d1'), [TEXT]);
});

test('a supplied entry restriction prevents queueing and publication before its saved row changes', async () => {
  // Catches checking only durable metadata while a producer already carries a stricter live boundary.
  const core = await scene({ mirrors: [{ chatId: 'd1' }] });
  const entry = { ...(await core.record()), publicationBoundary: RESTRICTED_ENTRY };
  await core.mirrors.queueEntry(entry);
  assert.deepEqual(diaryPublications(core.memory.memoryDb), []);
  const result = await core.mirrors.publishEntry(entry);
  assert.deepEqual(
    result.map(({ status, code }) => ({ status, code })),
    [{ status: 'failed', code: 'not-allowed' }]
  );
  assert.deepEqual(core.texts('d1'), []);
});

// ---- the pictures of one publication ----

const loosePicture = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

test('chunkPictures: a new message past the byte limit or at 10 files; a picture over the limit goes alone', () => {
  const sized = (list: Untyped) => list.map((n: Untyped) => ({ buffer: { length: n } }));
  const lengths = (chunks: Untyped) =>
    chunks.map((chunk: Untyped) => chunk.map((p: string) => loosePicture(p).buffer.length));
  assert.deepEqual(lengths(chunkPictures(sized([400, 400, 400, 900, 100]), 1000)), [[400, 400], [400], [900, 100]]);
  assert.deepEqual(lengths(chunkPictures(sized([50, 2000, 50]), 1000)), [[50], [2000], [50]]);
  assert.deepEqual(
    chunkPictures(sized(Array(23).fill(1)), 1_000_000).map((chunk) => chunk.length),
    [10, 10, 3]
  );
  assert.deepEqual(chunkPictures([], 1000), []);
});

const DIARY_MIRROR_GUARD_NOW = Date.parse('2026-10-17T12:00:00Z');

const DIARY_MIRROR_GUARD_ROOT = 'g1';

const MIRROR = 'd1';

after(async () => {
  for (const item of OPEN.splice(0)) await item.close();
});

type Fake = ReturnType<typeof createFakeAdapter>;

/**
 * A root with `general` (c1), where Alice wrote last, and `journal` (d1), the diary's mirror (enabled unless
 * `enabled` is false), on a fake interface whose outbound port is the guarded one. Memory is a real database.
 */
async function root({ enabled = true }: { enabled?: boolean } = {}) {
  const memory = await openTestMemory({ now: () => DIARY_MIRROR_GUARD_NOW });
  OPEN.push(memory);
  seedMirror(memory.memoryDb, { iface: 'fake', chatId: MIRROR, name: 'journal', enabled, at: DIARY_MIRROR_GUARD_NOW });
  freshWorld();
  const line = (placeId: string) => ({
    ...rawMessage({ id: `m-${placeId}`, ts: DIARY_MIRROR_GUARD_NOW - 30_000, content: 'γεια' }),
    placeId,
  });
  world().channel({ id: 'c1', name: 'general', placeId: DIARY_MIRROR_GUARD_ROOT, historyMessages: [line('c1')] });
  world().channel({ id: MIRROR, name: 'journal', placeId: DIARY_MIRROR_GUARD_ROOT, historyMessages: [line(MIRROR)] });
  const adapter: Fake = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => DIARY_MIRROR_GUARD_NOW });
  const reads = world().adopt(adapter);
  const port = guardMirrorPort(adapter, { memoryDb: memory.memoryDb });
  /** Every send that reached the interface to `chatId`. */
  const sendsTo = (chatId: string) =>
    adapter.calls.filter((entry) => entry.op === 'send' && (entry.args[0] as { chatId?: string }).chatId === chatId);
  return { memory, adapter, reads, port, sendsTo };
}

// ---- the publisher, and a disabled mirror -----------------------------------------------------------------------

test('the publisher still publishes an entry to the mirror place', async () => {
  const core = await root();
  // A diary turn's entry, as the publisher takes it: the publisher holds the interface's own port.
  const mirrors = createMirrors({
    memoryDb: core.memory.memoryDb,
    port: () => core.adapter,
    now: () => DIARY_MIRROR_GUARD_NOW,
  });
  const result = { diary: { entry: { id: 'entry-1', messages: ['ημερολόγιο'] } } };
  await mirrors.publishEntry(entryOf(result));
  assert.deepEqual(
    core.adapter.messagesIn(MIRROR).map((message) => message.text),
    ['ημερολόγιο']
  );
});

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

// The diary channel is held by a fake interface named `fake`; the persona is `self-id`.
useIface('fake');

useSelf('self-id');

// onWorld takes a creator of any options; the real runner takes its own input type, so the options are cast once, here.
const createWorldRunner = onWorld((options) =>
  createRealTurnRunner(options as Parameters<typeof createRealTurnRunner>[0])
);

/**
 * A turn runner whose `runTurn` first opens the chat a test gave as a diary channel (see diaryChannel).
 */
function createTurnRunner(options: Parameters<typeof createWorldRunner>[0]) {
  const turns = createWorldRunner(options);
  return {
    ...turns,
    runTurn: (params: Record<string, unknown> & { channel?: { open?: () => unknown } }) => {
      params.channel?.open?.();
      return turns.runTurn(params);
    },
  };
}

const DIARY_TURN_NOW = Date.UTC(2026, 9, 6, 19, 30, 0);

const TZ = 'Europe/Athens';

/**
 * A diary channel the persona owns: every permission, Attach Files only when `attachFiles`. The chat is made in
 * the test's world when a turn runs in it (`open`), and `sent` and `reactCalls` read what the persona did there.
 */
function diaryChannel({
  attachFiles = true,
  historyMessages = [],
}: { attachFiles?: boolean; historyMessages?: Array<Rec> } = {}) {
  let handle: Channel | null = null;
  return {
    id: 'd1',
    open() {
      handle ??= world().channel({
        id: 'd1',
        name: 'journal',
        placeId: 'g1',
        permissions: { attach: attachFiles },
        historyMessages,
      });
      return handle;
    },
    get sent() {
      return handle?.sent ?? [];
    },
    get reactCalls() {
      return handle?.reactCalls ?? [];
    },
  };
}

/**
 * The diary wake: a diary turn records the persona's entry and sends nothing itself, and the diary's mirror
 * publishes the entry (src/behavior/mirror.ts). The cases that asserted the turn's send call this where the send used
 * to happen: it checks that the turn sent nothing to `channel`, then publishes the entry to a mirror on `d1` of `port`,
 * so what `channel.sent` or the adapter shows after it is what the publication sent.
 * @param result  The diary turn's result.
 * @param channel  The diary channel of the case, or null when the case reads the adapter.
 */
async function published(result: Untyped, channel: Untyped, port = world().port) {
  assert.deepEqual(channel?.sent ?? [], [], 'the turn itself sends nothing');
  return publishTo(result, port, { now: DIARY_TURN_NOW });
}

/**
 * An LLM that answers the director with `scene` (a scene's text, an Error it throws, or `{ raw }` sent as it is), then
 * the persona's requests with `post` (a list: one answer per request, the last repeated). `calls` holds every request,
 * the director's first.
 */
function fakeLlm(scene: string | Error | { raw: string } | null, post: Untyped) {
  const calls: Array<Untyped> = [];
  const options: Array<Untyped> = [];
  let composed = 0;
  return {
    calls,
    options,
    complete: async (messages: Untyped, opts: Untyped) => {
      calls.push(messages);
      options.push(opts);
      if (opts?.purpose === 'diary-scene') {
        if (scene instanceof Error) throw scene;
        if (scene !== null && typeof scene === 'object') return { text: scene.raw, usage: {}, estimated: 5 };
        return directorAnswer(messages, opts, typeof scene === 'string' ? scene : undefined);
      }
      const answer = Array.isArray(post) ? post[Math.min(composed, post.length - 1)] : post;
      composed += 1;
      return completionOf(answer);
    },
  };
}

/** The persona's draw.create calls (`n` of them; the first with self when `self`), as one answer with `text` ahead of them. */
const withDraws = (text: string, n: Untyped, self = false) => drawAnswer(text, n, self);

const drawAnswer = (text: string, n = 1, self = false) =>
  toolAnswer(
    text,
    Array.from({ length: n }, (_, i) =>
      call('draw.create', {
        people: [],
        text: n === 1 ? 'a pier at night' : `scene ${i + 1}`,
        ...(self && i === 0 ? { self: true } : {}),
      })
    )
  );

type Rec = Record<string, Untyped>;

function fakeStore({ posts = [], data = {} }: { posts?: Array<Rec>; data?: Rec } = {}) {
  const appended: Array<Untyped> = [];
  return {
    appended,
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
    getDiary: () => ({ posts, updatedAt: 0 }),
    appendDiaryPost: (post: Untyped, opts: Untyped) => appended.push({ post, opts }),
    state: { data: { ...data }, markDirty() {} },
  };
}

function fakeImages({ used = 0, cap = 10, fail = null }: { used?: number; cap?: number; fail?: Error | null } = {}) {
  const prompts: Array<Untyped> = [];
  return {
    prompts,
    quota: () => ({ used, cap, userUsed: 0, userCap: 5, spent: used >= cap, userSpent: false }),
    generate: async ({ prompt }: { prompt: Untyped }) => {
      prompts.push(prompt);
      if (fail) throw fail;
      return { buffer: Buffer.from('png'), mediaType: 'image/png', seconds: 1, cost: 0 };
    },
  };
}

// PR 7d: the switches are code, the dry run and the daily caps are gone, and the diary's kinds, sets, gist length and
// message count are constants of src/behavior/diary.ts, so the config holds only the keys that are still settings.
function fakeHot({ diary = {}, prompts = {} }: { diary?: Untyped; prompts?: Untyped } = {}) {
  return {
    config: {
      bot: { timezone: TZ },
      context: {
        channelMessages: 50,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { fetchTimeoutMs: 10_000 },
        pull: { sameAudience: true },
      },
      llm: { maxRequestTokens: 50000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
      image: {},
      diary: {
        placeId: 'd1',
        world: false,
        ...diary,
      },
    },
    prompts: {
      main: 'SYSTEM for {{name}}',
      persona: 'CARD_TEXT',
      format: 'FORMAT_TEXT',
      'diary/task': 'DIARY_TASK for {{name}}',
      'diary/scene': 'SCENE_TASK',
      'diary/kinds/thought': 'THOUGHT_TASK',
      'diary/kinds/story': 'STORY_TASK',
      'diary/seeds/place': 'a pier',
      'diary/seeds/setting': 'fog',
      draw: 'DRAW for {{name}}\n{{when}}\n{{request}}',
      labels,
      ...prompts,
    },
  };
}

function runner({
  hot = fakeHot(),
  store = fakeStore(),
  llm,
  images = fakeImages(),
  lookup = null,
  // The code draws the diary's kind.
  rng = () => 0.5,
  extra = {},
}: {
  hot?: Untyped;
  store?: Untyped;
  llm?: Untyped;
  images?: Untyped;
  lookup?: Untyped;
  rng?: () => number;
  extra?: Record<string, unknown>;
} = {}) {
  return createTurnRunner({
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (n: Untyped) => n, observe: () => {} },
    images,
    lookup,
    rng,
    now: () => DIARY_TURN_NOW,
    ...extra,
  });
}

// ---- set posts (diary.setKinds): several pictures, generated before anything is sent ----------

/** An image client that answers each generate call by the next step: a byte count, or an error to throw. */
function fakeSetImages(steps: Untyped, events: Array<string> = []) {
  const prompts: Array<Untyped> = [];
  let call = 0;
  return {
    prompts,
    events,
    quota: () => ({ used: 0, cap: 50, userUsed: 0, userCap: 5, spent: false, userSpent: false }),
    generate: async ({ prompt, accountId }: { prompt: Untyped; accountId: Untyped }) => {
      prompts.push({ prompt, accountId });
      const step = steps[call] ?? 10;
      call += 1;
      events.push(`generate ${call}`);
      if (step instanceof Error) throw step;
      return { buffer: Buffer.alloc(step, 1), mediaType: 'image/png', seconds: 1, cost: 0 };
    },
  };
}

/** A diary channel whose sends are logged into `events` too (one entry per message: its files, or `msg`). */
function eventChannel(events: Untyped) {
  const channel = diaryChannel();
  world().tap('send', ([, content]) => {
    const files = attachmentCount(content);
    events.push(files > 0 ? `files ${files}` : 'msg');
  });
  return channel;
}

test('diary set: six draw.create calls in one answer are generated before anything is sent, then the messages, then the files, chunked by bytes', async () => {
  // The code draws the diary's kind.
  const events: Array<Untyped> = [];
  const images = fakeSetImages([3_200_000, 3_200_000, 3_200_000, 7_200_000, 800_000, 400_000], events);
  const store = fakeStore();
  const channel = eventChannel(events);
  const llm = fakeLlm(null, withDraws('<msg>une promenade</msg><msg>au port</msg>', 6, true));
  const { result, logs } = await withCapturedLogs(() =>
    runner({ llm, store, images }).runTurn({
      channel,
      mode: 'diary',
      diary: { kind: 'photoset', forced: false },
    })
  );
  assert.equal(loose(result).outcome, 'spoke');
  assert.equal(llm.calls.length, 2, 'one post request');
  // Stage 3: the turn sends nothing; the expectation below is what the mirror's publication of the entry sends.
  await published(result, channel);
  assert.deepEqual(events, [
    'generate 1',
    'generate 2',
    'generate 3',
    'generate 4',
    'generate 5',
    'generate 6',
    'msg',
    'msg',
    'files 2',
    'files 1',
    'files 2',
    'files 1',
  ]);
  assert.ok(
    images.prompts.every(({ accountId }) => accountId === null),
    'nobody is charged'
  );
  assert.deepEqual(
    channel.sent
      .slice(2)
      .map((payload) => loose(payload.files).map((file: string) => loose(loose(file).attachment).length)),
    [[3_200_000, 3_200_000], [3_200_000], [7_200_000, 800_000], [400_000]]
  );
  const thirdSent = channel.sent[2];
  assert.equal(thirdSent.content, undefined);
  assert.equal(thirdSent.reply, undefined);
  const drew = logs.filter((l) => l.msg === 'turn: drew');
  assert.equal(drew.length, 6);
  assert.ok(drew.every((l) => l.set === true));
  assert.equal(loose(logs.find((l) => l.msg === 'turn: set posted')).pictures, 6);
  // Stage 3 design, section 3 item 6: the outcome names the entry it recorded; the entry itself is checked by its publication.
  assert.deepEqual(loose(result).diary, {
    kind: 'photoset',
    picture: true,
    scenes: loose(result).diary.scenes,
    messages: 2,
    pictures: 6,
    // The outcome also names the persona's audience: no tag in the answer reads as unrestricted.
    audience: { ok: true, audience: { kind: 'unrestricted' } },
    entry: entryOf(result),
  });
  const { post } = store.appended[0];
  assert.equal(post.picture, 'scene 1');
  assert.equal(post.pictures, 6);
});

/**
 * A runner whose port is a fake adapter with the given limits: the turn reads them from `capabilities()`.
 */
function limitedRunner({
  hot,
  llm,
  images,
  store = fakeStore(),
  limits,
}: {
  hot: Untyped;
  llm: Untyped;
  images: Untyped;
  store?: Untyped;
  limits: Untyped;
}) {
  const adapter = createFakeAdapter({ iface: 'fake', selfId: 'self-id', capabilities: limits });
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    images,
    port: adapter,
    rng: () => 0.5,
    now: () => DIARY_TURN_NOW,
  });
  return { turns, adapter };
}

test('diary set: the adapter that allows two files per message gets the six pictures in messages of two files', async () => {
  // The code draws the diary's kind.
  const images = fakeSetImages([10, 10, 10, 10, 10, 10]);
  const llm = fakeLlm(null, withDraws('<msg>une promenade</msg>', 6, true));
  const { turns, adapter } = limitedRunner({ hot: fakeHot(), llm, images, limits: { maxFiles: 2 } });
  const result = await turns.runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: { kind: 'photoset', forced: false },
  });
  assert.equal(loose(result).outcome, 'spoke');
  // Stage 3: the turn sends nothing; the mirror's publication to this adapter splits the set by its maxFiles.
  assert.deepEqual(adapter.messagesIn('d1'), [], 'the turn itself sends nothing');
  await published(result, null, adapter);
  const withFiles = adapter.messagesIn('d1').filter((message) => message.attachments.length > 0);
  assert.deepEqual(
    withFiles.map((message) => message.attachments.length),
    [2, 2, 2]
  );
});

test('diary set: an adapter that allows twelve files per message gets the same six pictures in one message', async () => {
  // The code draws the diary's kind.
  const images = fakeSetImages([10, 10, 10, 10, 10, 10]);
  const llm = fakeLlm(null, withDraws('<msg>une promenade</msg>', 6, true));
  const { turns, adapter } = limitedRunner({ hot: fakeHot(), llm, images, limits: { maxFiles: 12 } });
  const result = await turns.runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: { kind: 'photoset', forced: false },
  });
  // Stage 3: the turn sends nothing; the mirror's publication to this adapter puts the set in one message.
  assert.deepEqual(adapter.messagesIn('d1'), [], 'the turn itself sends nothing');
  await published(result, null, adapter);
  const withFiles = adapter.messagesIn('d1').filter((message) => message.attachments.length > 0);
  assert.deepEqual(
    withFiles.map((message) => message.attachments.length),
    [6]
  );
});

test('an entry recorded with chat null reaches every mirror', async () => {
  // Bug: with no chat the turn records nothing, or the entry only goes to the place the turn used to run in.
  const scene = await mirrorScene({ ifaces: ['fake', 'tele'], start: FRAME_NOW });
  // No earlier entry, so the drain has only this one to send.
  const run = await frameTurn({ memory: scene.memory, mirrors: [JOURNAL, PAGES], entries: 0 });
  const mirrors = scene.publisher();
  await mirrors.publishEntry(entryOf(run.result));
  await mirrors.drainQueued();
  assert.deepEqual(scene.transport('fake').posted('d1'), [FRAME_TEXT.entry]);
  assert.deepEqual(scene.transport('tele').posted('k9'), [FRAME_TEXT.entry]);
});

const D1 = 'fake:channel:d1';

const D2 = 'fake:channel:d2';

const OTHER_D1 = 'other:channel:d1';

/** A model whose plan is a thought and whose writer says `answer`; it keeps every request. */
function modelSaying(answer: string) {
  const calls: Array<unknown> = [];
  return {
    calls,
    complete: (messages: unknown, options?: { purpose?: string }) => {
      calls.push(structuredClone(messages));
      return Promise.resolve(directorAnswer(messages, options) ?? { text: answer, usage: {}, estimated: 5 });
    },
  };
}

/**
 * Two interfaces that share native ids: `fake` and `other`, each with a root `g1` and a channel `d1`, `fake` with
 * another channel `d2` and a channel `d3` outside the root, a private chat, and enabled mirrors as named.
 */
async function places(mirrorOn: ReadonlyArray<'fake:d1' | 'fake:d2' | 'fake:d3' | 'other:d1'> = []) {
  const scene = await mirrorScene({ ifaces: ['fake', 'other'] });
  const fakeRoot = scene.place({ iface: 'fake', native: 'g1', kind: 'root' });
  const otherRoot = scene.place({ iface: 'other', native: 'g1', kind: 'root' });
  scene.place({ iface: 'fake', native: 'd1', parent: fakeRoot });
  scene.place({ iface: 'fake', native: 'd2', parent: fakeRoot });
  scene.place({ iface: 'fake', native: 'd3' });
  scene.place({ iface: 'other', native: 'd1', parent: otherRoot });
  scene.place({ iface: 'fake', native: 'u1', kind: 'dm' });
  for (const one of mirrorOn) {
    const [iface, chatId] = one.split(':') as [string, string];
    scene.db
      .prepare(
        "INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by, extra) VALUES (?, 'diary', ?, 1, ?, 'owner', NULL)"
      )
      .run(`mirror:test:${one}`, `${iface}:channel:${chatId}`, new Date(T0).toISOString());
  }
  return scene;
}

/** One diary turn in which the persona answers `answer`, over the scene's memory: the turn's result and the model's requests. */
async function writeEntry(scene: Scene, answer: string) {
  freshWorld();
  world().channel({ id: 'd1', name: 'journal', placeId: ROOT });
  const store = createStore({ dataDir: scene.memory.dataDir, memoryDb: scene.memory.memoryDb });
  const model = modelSaying(answer);
  const result = await sceneRunner(model, store).runTurn({
    mode: 'diary',
    diary: { kind: 'thought', forced: true },
    placeId: ROOT,
  });
  await store.flushSettled({});
  return { result, entry: entryOf(result), store, writer: model.calls.at(-1) };
}

/** What the persona's turn said about the audience it named. */
const audienceOf = (result: unknown): unknown => (result as { diary?: { audience?: unknown } }).diary?.audience;

/** Every destination a send was attempted to, as `<iface>:<chat>`, sorted. */
function reached(scene: Scene): Array<string> {
  const out: Array<string> = [];
  for (const iface of ['fake', 'other'])
    for (const attempt of scene.transport(iface).attempts) out.push(`${iface}:${attempt.chatId}`);
  return out.sort();
}

test('an entry written with no mirrors at all reaches a mirror added later through backfill', async () => {
  // Catches: an entry bound to the mirrors of its creation time.
  const scene = await places();
  await writeEntry(scene, `<msg>${TEXT}</msg>`);
  scene.advance(1000);
  const mirrors = scene.publisher();
  await mirrors.addMirror({ destination: OTHER_D1, by: OWNER, backfill: { enabled: true, intervalMs: FOUR_HOURS } });
  await mirrors.drainQueued();
  assert.deepEqual(scene.transport('other').posted('d1'), [TEXT]);
});

test('an interface audience covers that interface and nothing of the other, same native ids included', async () => {
  // Catches: comparing native ids, since `d1` exists on both interfaces.
  const scene = await places(['fake:d1', 'fake:d3', 'other:d1']);
  const { result, entry } = await writeEntry(scene, `<audience>interface:fake</audience><msg>${TEXT}</msg>`);
  assert.deepEqual(audienceOf(result), { ok: true, audience: { kind: 'interface', iface: 'fake' } });
  const outcomes = await scene.publisher().publishEntry(entry);
  assert.deepEqual(reached(scene), ['fake:d1', 'fake:d3']);
  assert.equal(outcomes.find((one) => one.placeId === OTHER_D1)?.code, 'audience-excluded');
});

test('a channel audience covers that channel alone', async () => {
  // Catches: a place restriction widened to its parent or its siblings.
  const scene = await places(['fake:d1', 'fake:d2', 'other:d1']);
  const { entry } = await writeEntry(scene, `<audience>place:${D1}</audience><msg>${TEXT}</msg>`);
  await scene.publisher().publishEntry(entry);
  assert.deepEqual(reached(scene), ['fake:d1']);
});

test('the audience is read from the row after a restart, not from the entry the turn held', async () => {
  // Catches: an audience kept on the in-memory entry only, gone when a queued row is sent by a later process.
  const scene = await places(['fake:d1', 'other:d1']);
  scene.disconnect('fake');
  scene.disconnect('other');
  const { entry } = await writeEntry(scene, `<audience>interface:other</audience><msg>${TEXT}</msg>`);
  await scene.publisher().publishEntry(entry);
  scene.connect('fake');
  scene.connect('other');
  await scene.publisher().drainQueued();
  assert.deepEqual(reached(scene), ['other:d1']);
});

/** Sets an entry's stored audience through the store, as a later change of the row would. */
async function narrow(store: Awaited<ReturnType<typeof writeEntry>>['store'], audience: unknown): Promise<void> {
  const posts = store.getDiary().posts.map((post) => ({ ...post, publicationAudience: audience }));
  store.setDiaryPosts(posts);
  await store.flushSettled({});
}

test('an audience narrowed before queueing stops the queue', async () => {
  // Catches: trusting the audience the entry object carried when the turn ended over the stored row.
  const scene = await places(['fake:d1', 'other:d1']);
  const { entry, store } = await writeEntry(scene, `<msg>${TEXT}</msg>`);
  await narrow(store, { kind: 'interface', iface: 'fake' });
  await scene.publisher().publishEntry(entry);
  assert.deepEqual(reached(scene), ['fake:d1']);
  assert.deepEqual(
    diaryPublications(scene.memory.memoryDb).map((row) => row.placeId),
    [D1],
    'nothing is queued for the mirror outside the audience'
  );
});

test('an audience narrowed while a row is queued stops the send', async () => {
  // Catches: checking once at queue time, so a scope change during backfill still goes out.
  const scene = await places(['fake:d1', 'other:d1']);
  scene.disconnect('other');
  const { entry, store } = await writeEntry(scene, `<msg>${TEXT}</msg>`);
  const mirrors = scene.publisher();
  await mirrors.publishEntry(entry);
  await narrow(store, { kind: 'interface', iface: 'fake' });
  scene.connect('other');
  await mirrors.drainQueued();
  assert.deepEqual(scene.transport('other').attempts, []);
  const state = mirrors.publicationState(entry.id, OTHER_D1);
  assert.deepEqual([state?.status, state?.code], ['failed', 'audience-excluded']);
});

test('a copy delivered before a narrowing is reported apart from the pending filter', async () => {
  // Catches: status claiming an entry is private on a destination that already shows it.
  const scene = await places(['other:d1']);
  const { entry, store } = await writeEntry(scene, `<msg>${TEXT}</msg>`);
  const mirrors = scene.publisher();
  await mirrors.publishEntry(entry);
  await narrow(store, { kind: 'interface', iface: 'fake' });
  const state = mirrors.publicationState(entry.id, OTHER_D1);
  assert.equal(state?.status, 'sent');
  assert.equal(state?.outsideAudience, true);
  assert.deepEqual(
    mirrors.mirrorStatus()[0]?.deliveredOutsideAudience.map((one) => one.entryId),
    [entry.id]
  );
});

const BOUNDARY = { kind: 'internal-turn', origin: { iface: 'fake', chatId: 'd1' } } as const;

const INTERNAL = { scope_kind: 'internal', scope_iface: null, scope_dm: null };

/** One stored entry with `audience` under the trusted boundary, offered to mirrors on d1, d2 and other d1. */
async function underBoundary(audience: unknown): Promise<Array<string>> {
  const scene = await places(['fake:d1', 'fake:d2', 'other:d1']);
  scene.entry({ id: 'e1', boundary: BOUNDARY, audience, scope: INTERNAL });
  const mirrors = scene.publisher();
  await mirrors.publishEntry({ id: 'e1', messages: [TEXT] });
  // A mirror the restrictions leave out has nothing wrong with it.
  assert.deepEqual(
    mirrors.mirrorStatus().flatMap((mirror) => mirror.failed),
    []
  );
  return reached(scene);
}

for (const [name, audience, expected] of [
  ['unrestricted', { kind: 'unrestricted' }, ['fake:d1']],
  ['the same interface', { kind: 'interface', iface: 'fake' }, ['fake:d1']],
  ['another channel', { kind: 'place', placeId: D2 }, []],
  ['another interface', { kind: 'interface', iface: 'other' }, []],
] as const) {
  test(`a trusted restriction intersects with the audience ${name}`, async () => {
    // Catches: a model's audience, or its absence, widening private material past where it may go.
    assert.deepEqual(await underBoundary(audience), expected);
  });
}

test('a turn under a trusted restriction that names no audience stays restricted', async () => {
  // Catches: "omitted means unrestricted" reaching an entry whose source is private.
  const scene = await places(['fake:d1', 'other:d1']);
  freshWorld();
  world().channel({ id: 'd1', name: 'journal', placeId: ROOT });
  const store = createStore({ dataDir: scene.memory.dataDir, memoryDb: scene.memory.memoryDb });
  const result = await sceneRunner(modelSaying(`<msg>${TEXT}</msg>`), store).runTurn({
    mode: 'diary',
    diary: { kind: 'thought', forced: true },
    placeId: ROOT,
    publicationBoundary: BOUNDARY,
  });
  await store.flushSettled({});
  assert.deepEqual(audienceOf(result), { ok: true, audience: { kind: 'unrestricted' } });
  const entry: RecordedEntry = entryOf(result);
  await scene.publisher().publishEntry(entry);
  assert.deepEqual(reached(scene), ['fake:d1']);
});

test('an old group entry stays on its own interface', async () => {
  // Catches: a legacy row with no audience read as unrestricted, so an old post reaches a new platform.
  const scene = await places(['fake:d1', 'other:d1']);
  scene.entry({ id: 'old', legacy: true, scope: { scope_kind: 'group', scope_iface: 'fake', scope_dm: null } });
  const outcomes = await scene.publisher().publishEntry({ id: 'old', messages: [TEXT] });
  assert.deepEqual(reached(scene), ['fake:d1']);
  assert.equal(outcomes.find((one) => one.placeId === OTHER_D1)?.code, 'audience-excluded');
});

for (const [name, scope] of [
  ['internal', INTERNAL],
  ['with no interface', { scope_kind: 'group', scope_iface: null, scope_dm: null }],
  ['private', { scope_kind: 'dm', scope_iface: 'fake', scope_dm: 'person:fake:u1' }],
] as const) {
  test(`an old entry ${name} is published nowhere`, async () => {
    // Catches: an ambiguous row counted as globally publishable by a migration or a default.
    const scene = await places(['fake:d1', 'other:d1']);
    scene.entry({ id: 'old', legacy: true, scope });
    await scene.publisher().publishEntry({ id: 'old', messages: [TEXT] });
    assert.deepEqual(reached(scene), []);
  });
}

test('an old entry keeps its stored restriction', async () => {
  // Catches: a migration that writes a default audience over the restriction the row already has.
  const scene = await places(['fake:d1', 'fake:d2']);
  scene.entry({ id: 'old', legacy: true, boundary: BOUNDARY, scope: INTERNAL });
  const mirrors = scene.publisher();
  await mirrors.publishEntry({ id: 'old', messages: [TEXT] });
  assert.deepEqual(reached(scene), ['fake:d1']);
  assert.equal(mirrors.publicationState('old', D1)?.outsideAudience, false);
  assert.equal(mirrors.publicationState('old', D2), null);
});

test('a mirror seeded before this model still works for a new entry', async () => {
  // Catches: the audience check requiring a column or setting a `mirrors` row from the seed does not have.
  const scene = await mirrorScene();
  seedMirror(scene.memory.memoryDb, { iface: 'fake', chatId: 'd1', at: T0 });
  scene.entry({ id: 'e1', scope: { scope_kind: 'group', scope_iface: 'fake', scope_dm: null } });
  const mirrors = scene.publisher();
  await mirrors.publishEntry({ id: 'e1', messages: [TEXT] });
  assert.equal(mirrors.publicationState('e1', D1)?.outsideAudience, false);
});

/** A scene with one enabled mirror on `d1` and one entry `e1`. */
async function oneMirror({ reconcile = false }: { reconcile?: boolean } = {}) {
  const scene = await mirrorScene({ reconcile });
  const { placeId } = seedMirror(scene.memory.memoryDb, { iface: 'fake', chatId: 'd1', at: T0 });
  scene.entry({ id: 'e1' });
  return { scene, place: placeId, transport: scene.transport() };
}

const ONE = { id: 'e1', messages: ['one'] };

const THREE = { id: 'e1', messages: ['a', 'b', 'c'] };

const PICTURE = { buffer: new Uint8Array([1, 2, 3]), mediaType: 'image/png' };

test('a send the port answers unknown is uncertain, shown in status and never retried without a proof', async () => {
  // Catches: an unknown outcome handled as a failure to retry, which is a duplicate whenever the send did go out.
  const { scene, place, transport } = await oneMirror();
  const mirrors = scene.publisher();
  transport.behave = () => 'lost-answer';
  await mirrors.publishEntry(ONE);
  transport.behave = () => 'deliver';
  assert.equal(await mirrors.drainQueued(), 0);
  scene.advance(FOUR_HOURS);
  assert.equal(await mirrors.drainQueued(), 0);
  assert.deepEqual(transport.posted('d1'), ['one']);
  assert.equal(mirrors.publicationState('e1', place)?.status, 'uncertain');
  assert.deepEqual(
    mirrors.mirrorStatus()[0]?.uncertain.map((one) => one.entryId),
    ['e1']
  );
});

test('a send that rejects is uncertain, since nobody knows what reached the platform', async () => {
  // Catches: an exception left to the caller, leaving the row `queued` for the next drain to repeat.
  const { scene, place, transport } = await oneMirror();
  const mirrors = scene.publisher();
  transport.behave = () => 'throw';
  await mirrors.publishEntry(ONE).catch(() => null);
  transport.behave = () => 'deliver';
  assert.equal(await mirrors.drainQueued(), 0);
  assert.equal(mirrors.publicationState('e1', place)?.status, 'uncertain');
  assert.deepEqual(transport.posted('d1'), []);
});

test('missing media is an explicit incomplete result and marks nothing delivered', async () => {
  // Catches: the audit's skip at mirror.ts:375, which posts the text alone and records the entry as sent.
  const { scene, place, transport } = await oneMirror();
  const mirrors = scene.publisher();
  scene.disconnect();
  await mirrors.publishEntry({ ...ONE, pictures: [PICTURE] });
  const [file] = scene.mediaFiles('e1');
  assert.ok(file);
  fs.rmSync(file);
  scene.connect();
  const restarted = scene.publisher();
  assert.equal(await restarted.drainQueued(), 0);
  assert.deepEqual(transport.attempts, []);
  const state = restarted.publicationState('e1', place);
  assert.deepEqual([state?.status, state?.code], ['incomplete', 'media-missing']);
  assert.deepEqual(
    state?.segments.flatMap((one) => one.messageIds),
    []
  );
  assert.deepEqual(restarted.mirrorStatus()[0]?.incomplete, [{ entryId: 'e1', code: 'media-missing' }]);
});

test('an incomplete entry goes out whole once its file is back, its attachment in the receipts', async () => {
  // Catches: an incomplete mark that is final, or a text receipt without its picture's after the resend.
  const { scene, place, transport } = await oneMirror();
  const mirrors = scene.publisher();
  scene.disconnect();
  await mirrors.publishEntry({ ...ONE, pictures: [PICTURE] });
  const [file] = scene.mediaFiles('e1');
  assert.ok(file);
  const bytes = fs.readFileSync(file);
  fs.rmSync(file);
  scene.connect();
  await mirrors.drainQueued();
  restoreFile(file, bytes);
  assert.equal(await mirrors.drainQueued(), 1);
  assert.deepEqual(
    transport.attempts.map((attempt) => [attempt.text, attempt.files]),
    [
      ['one', 0],
      ['', 1],
    ]
  );
  const state = mirrors.publicationState('e1', place);
  assert.equal(state?.status, 'sent');
  assert.deepEqual(
    state?.segments.map((one) => [one.messageIds.length, one.attachmentIds.length]),
    [
      [1, 0],
      [1, 1],
    ]
  );
  assert.deepEqual(mirrors.mirrorStatus()[0]?.incomplete, []);
});

test('an entry with a missing file does not stop the next entry', async () => {
  // Catches: a drain loop that returns at the first entry it cannot send.
  const { scene, place, transport } = await oneMirror();
  const mirrors = scene.publisher();
  scene.entry({ id: 'e2' });
  scene.disconnect();
  await mirrors.publishEntry({ ...ONE, pictures: [PICTURE] });
  await mirrors.publishEntry({ id: 'e2', messages: ['two'] });
  const [file] = scene.mediaFiles('e1');
  assert.ok(file);
  fs.rmSync(file);
  scene.connect();
  assert.equal(await mirrors.drainQueued(), 1);
  assert.deepEqual(transport.posted('d1'), ['two']);
  assert.equal(mirrors.publicationState('e1', place)?.status, 'incomplete');
  assert.equal(mirrors.publicationState('e2', place)?.status, 'sent');
});

/** Ten mirrors: nine channels of the fake interface and one of an interface that is not connected. */
async function tenMirrors() {
  const scene = await mirrorScene({ ifaces: ['fake', 'gone'] });
  const places = new Map<string, string>();
  for (let i = 0; i < 9; i += 1)
    places.set(`d${i}`, seedMirror(scene.memory.memoryDb, { iface: 'fake', chatId: `d${i}`, at: T0 + i }).placeId);
  places.set('d9', seedMirror(scene.memory.memoryDb, { iface: 'gone', chatId: 'd9', at: T0 + 9 }).placeId);
  scene.disconnect('gone');
  scene.entry({ id: 'e1' });
  const behave = (attempt: { chatId: string }) =>
    attempt.chatId === 'd3'
      ? ({ refuse: 'channel-no-permission' } as const)
      : attempt.chatId === 'd5'
        ? ('throw' as const)
        : ('deliver' as const);
  scene.transport().behave = behave;
  return { scene, places, mirrors: scene.publisher(), transport: scene.transport(), behave };
}

test('among ten mirrors a forbidden, a broken and an offline one stop none of the others', async () => {
  // Catches: one mirror's rejected send escaping the loop, so every mirror after it gets nothing.
  const { scene, places, mirrors, transport } = await tenMirrors();
  const outcomes = await mirrors.publishEntry(ONE);
  assert.equal(outcomes.length, 10);
  for (const chat of ['d0', 'd1', 'd2', 'd4', 'd6', 'd7', 'd8'])
    assert.deepEqual(transport.posted(chat), ['one'], chat);
  assert.deepEqual(transport.posted('d3'), []);
  const state = (chat: string) => mirrors.publicationState('e1', places.get(chat) ?? '');
  assert.deepEqual([state('d3')?.status, state('d3')?.code], ['failed', 'channel-no-permission']);
  assert.equal(state('d5')?.status, 'uncertain');
  assert.equal(state('d9')?.status, 'queued');
  assert.deepEqual(
    diaryRows(scene.memory.memoryDb).map((row) => row.id),
    ['e1'],
    'the entry stays in memory'
  );
});

test('zero mirrors publishes nothing, fails nothing and keeps the entry', async () => {
  // Catches: a publisher or status that assumes a first mirror, on the install that starts with none.
  const scene = await mirrorScene();
  scene.entry({ id: 'e1' });
  const mirrors = scene.publisher();
  assert.deepEqual(mirrors.mirrorStatus(), []);
  assert.deepEqual(await mirrors.publishEntry(ONE), []);
  assert.equal(await mirrors.drainQueued(), 0);
  assert.deepEqual(scene.transport().attempts, []);
  assert.equal(diaryRows(scene.memory.memoryDb).length, 1);
});

/** `work`, or a failure when it has not ended within five seconds: how a test sees a hang. */
async function ended<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const stuck = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('still running after 5 s')), 5000);
  });
  try {
    return await Promise.race([work, stuck]);
  } finally {
    clearTimeout(timer);
  }
}

test('a send that hangs ends at the send timeout as uncertain and is not sent again', async () => {
  // Catches: one stalled interface holding the publisher and every mirror after it until a restart.
  const scene = await mirrorScene({ sendTimeoutMs: 20 });
  const { placeId } = seedMirror(scene.memory.memoryDb, { iface: 'fake', chatId: 'd1', at: T0 });
  const second = seedMirror(scene.memory.memoryDb, { iface: 'fake', chatId: 'd2', at: T0 + 1 }).placeId;
  scene.entry({ id: 'e1' });
  const transport = scene.transport();
  transport.behave = (attempt, index) => (attempt.chatId === 'd1' && index === 1 ? 'hang-after-delivery' : 'deliver');
  const mirrors = scene.publisher();
  await ended(mirrors.publishEntry(THREE));
  const state = mirrors.publicationState('e1', placeId);
  assert.equal(state?.status, 'uncertain');
  assert.deepEqual(
    state?.segments.map((one) => one.status),
    ['sent', 'uncertain', 'pending']
  );
  assert.deepEqual(transport.posted('d2'), ['a', 'b', 'c'], 'the next mirror is not held up');
  assert.equal(mirrors.publicationState('e1', second)?.status, 'sent');
  transport.behave = () => 'deliver';
  assert.equal(await ended(mirrors.drainQueued()), 0);
  assert.deepEqual(transport.posted('d1'), ['a', 'b']);
});

test('beginEntry keeps a drain away from an entry whose media is not yet kept', async () => {
  // Catches: the tick that takes a just-stored entry for a crash and posts its text with no pictures.
  const { scene, place, transport } = await oneMirror();
  const mirrors = scene.publisher();
  const other = scene.publisher();
  scene.advance(1000);
  const release = mirrors.beginEntry();
  scene.entry({ id: 'e2' });
  assert.equal(await mirrors.drainQueued(), 0);
  assert.equal(mirrors.publicationState('e2', place), null);
  assert.deepEqual(
    transport.attempts.filter((attempt) => attempt.text === 'text of e2'),
    []
  );
  await mirrors.publishEntry({ id: 'e2', messages: ['two'], pictures: [PICTURE] });
  release();
  assert.equal(await mirrors.drainQueued(), 0);
  assert.deepEqual(
    transport.attempts.filter((attempt) => attempt.files === 1 || attempt.text === 'two').map((one) => one.files),
    [0, 1],
    'the entry went out whole, once'
  );
  assert.equal(await other.drainQueued(), 0);
});

test("the marks of a diary picture the persona drew reach the entry's row and its posted attachment", async () => {
  // Bug: the staged picture's people are dropped when the entry's files are kept, so the persona's diary drawing reads as anyone's.
  const { scene } = await oneMirror();
  const mirrors = scene.publisher();
  await mirrors.publishEntry({
    ...ONE,
    pictures: [{ ...PICTURE, made: 'self', depicts: [SELF_PERSON, 'person:m1ra-synthetic'] }],
  });
  const { memoryDb } = scene.memory;
  const db = memoryDb.database() as Db;
  const entryPicture = db.prepare(
    `SELECT m.native_ref AS native_ref, m.extra AS extra FROM media_links l JOIN media m ON m.id = l.media_id
     WHERE l.owner_kind = 'diary' AND l.owner_id = 'e1' AND m.kind = 'image'`
  );
  const row = entryPicture.get();
  assert.ok(row?.native_ref, 'the row is the one the posted attachment names');
  const extra = JSON.parse(String(row.extra)) as Record<string, unknown>;
  assert.deepEqual([extra.made, extra.depicts], ['self', [SELF_PERSON, 'person:m1ra-synthetic']]);
});
