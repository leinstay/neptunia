// The diary's mirrors (src/behavior/mirror.ts, stage 3 design, section 5): a recorded entry is published once to every
// enabled mirror, each publication a `publications` row keyed `selfreflection:<entry id>:<place id>`, queued while the interface
// is down and sent when it connects, `failed` with the port's code when the port refuses, never sent twice. And
// `preparePublication` (src/memory/db/publish.ts) takes an enabled `selfreflection` mirror of a place as the owner's grant.
// Every entry comes from a real diary turn over a real store and memory database, on the fake interface, with a
// scripted model. Synthetic text only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sendEntry, createMirrors } from '../src/behavior/mirror.ts';
import { createSelfreflection } from '../src/behavior/selfreflection.ts';
import { createStore } from '../src/memory/store.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { contentHash, preparePublication, recheck } from '../src/memory/db/publish.ts';
import { issueContext } from '../src/memory/db/scope.ts';
import { walk } from '../src/memory/db/graph.ts';
import { notOk } from '../src/protocol/actions.ts';
import type { Content } from '../src/protocol/actions.ts';
import { GUILD, NOW, sceneHot, sceneLlm, sceneRunner } from './fixtures/selfreflection-requests-recorded.ts';
import {
  dbOf,
  selfreflectionPublications,
  selfreflectionRows,
  entryOf,
  seedMirror,
} from './fixtures/selfreflection-mirror.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { freshWorld, world } from './fixtures/turn-world.ts';
import { worldTurnRunner } from './fixtures/world-runner.ts';

const TEXT = 'ήσυχο βράδυ στο λιμάνι';

/** The memory databases the scenes opened, closed when the file is done. */
const OPEN: Array<{ close(): unknown }> = [];
after(async () => {
  for (const item of OPEN.splice(0)) await item.close();
});

/**
 * A core with the fake interface (conversations `d1` and `d2` of the community), a real store over a memory database
 * holding the mirrors of `mirrors`, the publisher over both, and the diary scheduler that runs a turn and hands its
 * entry to the publisher. `link.connected` is whether an interface is connected (the publisher's port, or none).
 */
async function scene({
  mirrors: specs,
  connected = true,
}: {
  mirrors: Array<{ conversationId: string; enabled?: boolean }>;
  connected?: boolean;
}) {
  const memory = await openTestMemory({ now: () => NOW });
  OPEN.push(memory);
  freshWorld();
  world().channel({ id: 'd1', name: 'journal', placeId: GUILD });
  world().channel({ id: 'd2', name: 'notes', placeId: GUILD });
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
  const selfreflection = createSelfreflection({
    hot: sceneHot(),
    store,
    reads: null,
    turns,
    mirrors,
    now: () => NOW,
  });
  /** One diary turn as the wake runs it, its entry recorded and its writes landed. */
  async function record() {
    const result = await turns.runTurn({
      mode: 'selfreflection',
      selfreflection: { kind: 'status', forced: true },
      placeId: GUILD,
    });
    await store.flushSettled({});
    return entryOf(result);
  }
  /** Her messages the interface holds in `conversationId`. */
  const texts = (conversationId: string) =>
    world()
      .port.messagesIn(conversationId)
      .map((message) => message.text);
  return { memory, store, places, link, mirrors, selfreflection, record, texts };
}

test('a forced post with one enabled mirror publishes the entry once, and a reconnect sends nothing more', async () => {
  const core = await scene({ mirrors: [{ conversationId: 'd1' }] });
  await core.selfreflection.force({ kind: 'status' });
  await core.store.flushSettled({});
  assert.deepEqual(core.texts('d1'), [TEXT]);
  core.link.connected = false;
  core.link.connected = true;
  assert.equal(await core.mirrors.drainQueued(), 0, 'nothing is left to send');
  assert.deepEqual(core.texts('d1'), [TEXT], 'still one message');
  const [entry] = selfreflectionRows(core.memory.memoryDb);
  assert.ok(entry);
  const sentIds = world()
    .port.messagesIn('d1')
    .map((message) => message.ref.messageId);
  assert.deepEqual(selfreflectionPublications(core.memory.memoryDb), [
    {
      status: 'sent',
      key: `selfreflection:${entry.id}:${core.places[0]}`,
      placeId: core.places[0],
      receiptKeys: sentIds,
    },
  ]);
});

test('an entry recorded while no interface is connected stays queued, and the connection sends it once', async () => {
  const core = await scene({ mirrors: [{ conversationId: 'd1' }], connected: false });
  await core.selfreflection.force({ kind: 'status' });
  await core.store.flushSettled({});
  assert.deepEqual(core.texts('d1'), []);
  assert.deepEqual(
    selfreflectionPublications(core.memory.memoryDb).map((row) => row.status),
    ['queued']
  );
  core.link.connected = true;
  assert.equal(await core.mirrors.drainQueued(), 1);
  assert.equal(await core.mirrors.drainQueued(), 0, 'a second drain finds nothing queued');
  assert.deepEqual(core.texts('d1'), [TEXT]);
  assert.deepEqual(
    selfreflectionPublications(core.memory.memoryDb).map((row) => row.status),
    ['sent']
  );
});

test('a send the port refuses leaves the publication failed with its code, and the entry stays in memory', async () => {
  const core = await scene({ mirrors: [{ conversationId: 'd1' }] });
  const entry = await core.record();
  world().port.failNext('send', notOk('failed', 'channel-no-permission'));
  const outcomes = await core.mirrors.publishEntry(entry);
  assert.deepEqual(outcomes, [{ placeId: core.places[0], status: 'failed', code: 'channel-no-permission' }]);
  assert.deepEqual(
    selfreflectionPublications(core.memory.memoryDb).map((row) => row.status),
    ['failed']
  );
  assert.deepEqual(selfreflectionRows(core.memory.memoryDb), [{ id: entry.id, kind: 'status', text: TEXT }]);
});

test('a disabled mirror gets nothing and is still listed', async () => {
  const core = await scene({ mirrors: [{ conversationId: 'd1' }, { conversationId: 'd2', enabled: false }] });
  const entry = await core.record();
  const outcomes = await core.mirrors.publishEntry(entry);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.placeId),
    [core.places[0]]
  );
  assert.deepEqual(core.texts('d2'), []);
  assert.deepEqual(
    selfreflectionPublications(core.memory.memoryDb).map((row) => row.placeId),
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
  const core = await scene({ mirrors: [{ conversationId: 'd1' }, { conversationId: 'd2' }] });
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
    selfreflectionPublications(core.memory.memoryDb)
      .map((row) => row.key)
      .sort(),
    [`selfreflection:${entry.id}:${core.places[0]}`, `selfreflection:${entry.id}:${core.places[1]}`].sort()
  );
});

// ---- an entry with pictures and a voice ------------------------------------------------------------------------

const WALK = 'une promenade au port';

/**
 * The scene's settings with the draw prompt. PR 7d: drawing and speech are code, and `photoset` is a set kind of the
 * constants of src/behavior/selfreflection.ts (at least two pictures posted, at most 8 000 000 bytes in one message).
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
      if (options?.purpose === 'selfreflection-planner')
        return Promise.resolve({
          text: JSON.stringify({ kind: 'photoset', brief: 'a walk', search: '', picture: true }),
          usage: {},
          estimated: 5,
        });
      written += 1;
      return Promise.resolve(
        written === 1
          ? toolAnswer(`<msg>${WALK}</msg>`, [
              call('draw.create', { text: 'scene 1' }),
              call('draw.create', { text: 'scene 2' }),
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

// The order is the one a diary post goes out in from the turn today: the voice is sent while the step's calls run, her
// message and the staged pictures after them (src/behavior/turn.ts, the act path). The publisher sends all three one
// after another.
test('an entry with two pictures and a voice reaches the mirror as the voice, the message, then the pictures', async () => {
  const core = await scene({ mirrors: [{ conversationId: 'd1' }] });
  const turns = setAndVoiceTurns(core.store);
  const result = await turns.runTurn({
    mode: 'selfreflection',
    selfreflection: { kind: 'photoset', forced: true },
    placeId: GUILD,
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
    selfreflectionPublications(core.memory.memoryDb).map((row) => row.receiptKeys),
    [sent.map((message) => message.ref.messageId)],
    'the receipts name every message, the voice included'
  );
});

// Stage 3 design, section 3 item 5: a row still queued is sent when the interface connects, also after a restart. The
// entry's pictures and voice are on disk, so the restarted publisher sends the whole entry, not its text alone.
test('an entry with pictures and a voice queued before a restart goes out whole when the interface connects', async () => {
  const core = await scene({ mirrors: [{ conversationId: 'd1' }], connected: false });
  const result = await setAndVoiceTurns(core.store).runTurn({
    mode: 'selfreflection',
    selfreflection: { kind: 'photoset', forced: true },
    placeId: GUILD,
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
    selfreflectionPublications(core.memory.memoryDb).map((row) => row.receiptKeys),
    [sent.map((message) => message.ref.messageId)],
    'the receipts name every message, the voice included'
  );
});

// Her diary is the truth (the owner, 2026-10-27): when the port names the attachments each message became, the
// publication keeps them in its receipts and the entry's media rows take their attachment ids from there.
test("a publication keeps the port's attachment ids in its receipts and on the entry's media rows", async () => {
  const core = await scene({ mirrors: [{ conversationId: 'd1' }] });
  const result = await setAndVoiceTurns(core.store).runTurn({
    mode: 'selfreflection',
    selfreflection: { kind: 'photoset', forced: true },
    placeId: GUILD,
  });
  await core.store.flushSettled({});
  let made = 0;
  // The port's answer to a send names each attachment by the platform's id, with the message that carries it.
  const naming = {
    iface: 'fake',
    send: async (conversation: { iface: string; conversationId: string }, content: Content) => {
      const delivery = await world().port.send(conversation, content);
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
  const [publication] = selfreflectionPublications(core.memory.memoryDb);
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
       WHERE l.owner_kind = 'selfreflection' AND l.owner_id = ? ORDER BY l.position`
    )
    .all(entry.id)
    .map((row) => row.native_ref);
  assert.deepEqual([...rows].sort(), named, "the entry's media rows carry the ids");
});

// A post whose pictures do not fit one message goes out as several messages of files (selfreflection.set.maxMessageBytes): each
// attachment the port names keeps the message that carried it, in the receipts and on its media row.
test('a picture set sent across two messages keeps every attachment id with the message that carried it', async () => {
  const core = await scene({ mirrors: [{ conversationId: 'd1' }] });
  // PR 7d: a message holds the constant 8 000 000 bytes, so two pictures of 4 100 000 bytes need two messages.
  const result = await setAndVoiceTurns(core.store, 4_100_000).runTurn({
    mode: 'selfreflection',
    selfreflection: { kind: 'photoset', forced: true },
    placeId: GUILD,
  });
  await core.store.flushSettled({});
  const carried: Array<{ messageId: string; attachmentId: string }> = [];
  const naming = {
    iface: 'fake',
    send: async (conversation: { iface: string; conversationId: string }, content: Content) => {
      const delivery = await world().port.send(conversation, content);
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
  const [publication] = selfreflectionPublications(core.memory.memoryDb);
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
       WHERE l.owner_kind = 'selfreflection' AND l.owner_id = ? ORDER BY l.position`
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

// ---- preparePublication and the mirror grant --------------------------------------------------------------------

/** What `preparePublication` (JS) answers, as these tests read it. */
type Prepared =
  { ok: true; publication: { status: string; content_hash: string } | null } | { ok: false; code: string };
/** The node:sqlite connection of an `openMemoryDb` handle, as these tests use it. */
type Db = { prepare(sql: string): { run(...params: Array<unknown>): unknown } };

const GENERAL = 'discord:channel:c-general';
const OTHER = 'discord:channel:c-other';
const DRAFT = 'Σήμερα ήταν ήσυχα.';

/** A v15 database with two group places, one diary entry, and a diary mirror on GENERAL (`enabled` or not). */
function grantFixture({ enabled }: { enabled: boolean }) {
  const handle = openMemoryDb(':memory:');
  OPEN.push(handle);
  const at = new Date(NOW).toISOString();
  const place = (id: string, name: string) => ({
    id,
    iface: 'discord',
    kind: 'channel',
    native_id: id.split(':')[2],
    parent_id: null,
    scope_kind: 'group',
    name,
  });
  insertRows(
    handle.db,
    {
      places: [place(GENERAL, 'general'), place(OTHER, 'other')],
      selfreflection: [
        {
          id: 'entry-1',
          at_ms: NOW,
          kind: 'status',
          gist: DRAFT,
          text: DRAFT,
          scope_kind: 'group',
          scope_iface: 'discord',
          scope_dm: null,
        },
      ],
    },
    { at }
  );
  const db = handle.db as Db; // open.js is untyped JS; `db` is its node:sqlite connection
  db.prepare(
    "INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by, extra) VALUES ('mirror-1', 'selfreflection', ?, ?, ?, 'owner', NULL)"
  ).run(GENERAL, enabled ? 1 : 0, at);
  let n = 0;
  const context = (kind: 'group' | 'internal', destination: string | null = null) =>
    issueContext({ kind, destination, now: () => NOW, newId: () => `ctx:${kind}:${(n += 1)}` });
  /** The diary entry, written in the wake's internal context, prepared for `destination` (or `rowKind` instead). */
  const prepare = (destination: string, rowKind = 'selfreflection'): Prepared =>
    // publish.js is untyped JS; it answers one of the two shapes of Prepared.
    preparePublication(handle, {
      context: context('group', destination),
      rowKind,
      rowId: 'entry-1',
      rendered: DRAFT,
      destination,
      producedIn: context('internal'),
      now: NOW,
    }) as Prepared;
  return { handle, prepare };
}

test('preparePublication queues a diary entry for the place of an enabled mirror without a grant row', () => {
  const { prepare } = grantFixture({ enabled: true });
  const prepared = prepare(GENERAL);
  assert.ok(prepared.ok, 'the mirror is the grant');
  assert.equal(prepared.publication?.status, 'queued');
  assert.equal(prepared.publication.content_hash, contentHash(DRAFT));
});

test('preparePublication refuses the same entry to a place with no mirror', () => {
  const { prepare } = grantFixture({ enabled: true });
  assert.deepEqual(prepare(OTHER), { ok: false, code: 'no-grant' });
});

test('preparePublication takes a disabled mirror as no grant', () => {
  const { prepare } = grantFixture({ enabled: false });
  assert.deepEqual(prepare(GENERAL), { ok: false, code: 'no-grant' });
});

test('preparePublication keeps the grant rule for a row that is not a diary entry, also to a mirrored place', () => {
  const { prepare } = grantFixture({ enabled: true });
  assert.deepEqual(prepare(GENERAL, 'claim'), { ok: false, code: 'no-grant' });
});

const RESTRICTED_ENTRY = { kind: 'internal-turn', origin: { iface: 'cli', conversationId: 'd1' } } as const;

async function restrictStoredEntry(core: Awaited<ReturnType<typeof scene>>, metadata: unknown): Promise<void> {
  const posts = core.store.getSelfreflection().posts.map((post) => ({ ...post, publicationBoundary: metadata }));
  core.store.setSelfreflectionPosts(posts);
  await core.store.flushSettled({});
}

for (const metadata of [RESTRICTED_ENTRY, null, { kind: 'internal-turn', origin: {} }]) {
  test(`a fresh mirror publisher refuses a queued entry with a stored ${metadata === RESTRICTED_ENTRY ? 'foreign' : metadata === null ? 'null' : 'malformed'} restriction`, async () => {
    // Catches restoring a queued row through rendered text without rechecking its stored diary restriction.
    const core = await scene({ mirrors: [{ conversationId: 'd1' }], connected: false });
    const entry = await core.record();
    await core.mirrors.queueEntry(entry);
    assert.deepEqual(
      selfreflectionPublications(core.memory.memoryDb).map((row) => row.status),
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
      selfreflectionPublications(core.memory.memoryDb).map((row) => row.status),
      ['failed']
    );
    assert.equal(selfreflectionRows(core.memory.memoryDb)[0].text, TEXT);
  });
}

test('publishing an entry without supplied metadata cannot clear its stored restriction', async () => {
  // Catches trusting the caller entry object over the authoritative saved diary row.
  const core = await scene({ mirrors: [{ conversationId: 'd1' }] });
  const entry = await core.record();
  await restrictStoredEntry(core, RESTRICTED_ENTRY);
  const result = await core.mirrors.publishEntry(entry);
  assert.deepEqual(
    result.map(({ status, code }) => ({ status, code })),
    [{ status: 'failed', code: 'not-allowed' }]
  );
  assert.deepEqual(core.texts('d1'), []);
});

test('publication preparation intersects the mirror standing grant with the stored restriction', async () => {
  // Catches direct writer preparation bypassing a restriction enforced only in the mirror wrapper.
  const core = await scene({ mirrors: [{ conversationId: 'd1' }] });
  const entry = await core.record();
  await restrictStoredEntry(core, RESTRICTED_ENTRY);
  const context = issueContext({ kind: 'group', iface: 'fake', destination: core.places[0], now: () => NOW });
  const result = await core.memory.memoryDb.memoryWrite({
    kind: 'publication',
    op: 'prepare',
    input: {
      context,
      rowKind: 'selfreflection',
      rowId: entry.id,
      rendered: TEXT,
      destination: core.places[0],
    },
  });
  assert.deepEqual(result, { ok: false, code: 'not-allowed' });
  assert.deepEqual(selfreflectionPublications(core.memory.memoryDb), []);
});

test('recheck refuses a queued diary publication whose stored origin became restricted', async () => {
  // Catches treating an earlier standing grant as permanent permission after private content replaces the entry.
  const core = await scene({ mirrors: [{ conversationId: 'd1' }], connected: false });
  const entry = await core.record();
  await core.mirrors.queueEntry(entry);
  await restrictStoredEntry(core, RESTRICTED_ENTRY);
  const handle = core.memory.memoryDb.readHandle();
  assert.ok(handle);
  const publication = dbOf(core.memory.memoryDb)
    .prepare("SELECT id FROM publications WHERE row_kind = 'selfreflection'")
    .all()[0];
  assert.ok(publication && typeof publication.id === 'string');
  const context = issueContext({ kind: 'group', iface: 'fake', destination: core.places[0], now: () => NOW });
  assert.deepEqual(recheck(handle, publication.id, context), { ok: false, code: 'not-allowed' });
});

test('sendEntry refuses the same native conversation on a different origin interface', async () => {
  // Catches comparing only conversation IDs at the actual attachment and text send boundary.
  const core = await scene({ mirrors: [{ conversationId: 'd1' }] });
  const entry = {
    id: 'direct-restricted',
    messages: [TEXT],
    publicationBoundary: RESTRICTED_ENTRY,
    pictures: [{ buffer: new Uint8Array([1, 2]), mediaType: 'image/png' }],
  };
  const result = await sendEntry(world().port, { iface: 'fake', conversationId: 'd1' }, entry, {
    maxMessageBytes: 1000000,
    now: () => NOW,
  });
  assert.deepEqual([result.status, result.code], ['failed', 'not-allowed']);
  assert.deepEqual(core.texts('d1'), []);
});

test('a same-origin restriction permits a mirror send without changing ordinary standing grants', async () => {
  // Catches replacing the exact-origin rule with a blanket ban on restricted entries.
  const core = await scene({ mirrors: [{ conversationId: 'd1' }] });
  const entry = await core.record();
  await restrictStoredEntry(core, { kind: 'internal-turn', origin: { iface: 'fake', conversationId: 'd1' } });
  const result = await core.mirrors.publishEntry(entry);
  assert.equal(result[0].status, 'sent');
  assert.deepEqual(core.texts('d1'), [TEXT]);
});

test('a stored restriction refuses publication when its destination has no native route', async () => {
  // Catches interpreting a missing native destination as an unrestricted mirror.
  const core = await scene({ mirrors: [{ conversationId: 'd1' }] });
  const entry = await core.record();
  await restrictStoredEntry(core, { kind: 'internal-turn', origin: { iface: 'fake', conversationId: 'd1' } });
  dbOf(core.memory.memoryDb).prepare('UPDATE places SET native_id = NULL WHERE id = ?').run(core.places[0]);
  const context = issueContext({ kind: 'group', iface: 'fake', destination: core.places[0], now: () => NOW });
  const result = await core.memory.memoryDb.memoryWrite({
    kind: 'publication',
    op: 'prepare',
    input: {
      context,
      rowKind: 'selfreflection',
      rowId: entry.id,
      rendered: TEXT,
      destination: core.places[0],
    },
  });
  assert.deepEqual(result, { ok: false, code: 'not-allowed' });
  assert.deepEqual(selfreflectionPublications(core.memory.memoryDb), []);
});

test('a supplied entry restriction prevents queueing and publication before its saved row changes', async () => {
  // Catches checking only durable metadata while a producer already carries a stricter live boundary.
  const core = await scene({ mirrors: [{ conversationId: 'd1' }] });
  const entry = { ...(await core.record()), publicationBoundary: RESTRICTED_ENTRY };
  await core.mirrors.queueEntry(entry);
  assert.deepEqual(selfreflectionPublications(core.memory.memoryDb), []);
  const result = await core.mirrors.publishEntry(entry);
  assert.deepEqual(
    result.map(({ status, code }) => ({ status, code })),
    [{ status: 'failed', code: 'not-allowed' }]
  );
  assert.deepEqual(core.texts('d1'), []);
});

test('restricting a saved diary entry hides its existing media while independent public media stays readable', async () => {
  // Catches a diary scope update leaving its retained attachments visible through the memory graph.
  const core = await scene({ mirrors: [] });
  const entry = await core.record();
  const publicId = 'selfreflection:independent-public';
  const original = core.store.getSelfreflection().posts;
  core.store.setSelfreflectionPosts([...original, { ...original[0], itemId: publicId }]);
  await core.store.flushSettled({});
  for (const id of [entry.id, publicId])
    await core.memory.memoryDb.memoryWrite({
      kind: 'entry-media',
      id,
      items: [{ data: new Uint8Array([1, 2, 3]), mime: 'image/png' }],
    });
  const db = dbOf(core.memory.memoryDb);
  const nodes = db
    .prepare(
      "SELECT g.id, m.id AS media_id, m.owner FROM graph_nodes g JOIN media m ON g.row_id = m.id WHERE g.kind = 'media' AND m.id LIKE 'media:diary:%'"
    )
    .all();
  assert.equal(nodes.length, 2);
  const group = issueContext({ kind: 'group', iface: 'fake', now: () => NOW });
  const owner = issueContext({ kind: 'internal', now: () => NOW });
  for (const node of nodes) {
    if (typeof node.id !== 'string') throw new Error('media node has no ID');
    assert.deepEqual(
      walk(db, group, { from: node.id, maxDepth: 0 }).rows.map((row) => row.rowId),
      [node.media_id]
    );
  }
  core.store.setSelfreflectionPosts(
    core.store
      .getSelfreflection()
      .posts.map((post) => (post.itemId === entry.id ? { ...post, publicationBoundary: RESTRICTED_ENTRY } : post))
  );
  await core.store.flushSettled({});
  const restricted = db.prepare('SELECT scope_kind FROM selfreflection WHERE id = ?').all(entry.id)[0];
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
