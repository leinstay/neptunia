// PR B: the persona's publication audience (plan section 5). A diary request shows the places she can name; her
// `<audience>` picks unrestricted, one interface or one canonical place with its descendants; leaving it out on a new
// entry means unrestricted across eligible mirrors, mirrors added later included. An unknown or malformed value fails
// closed with a concrete result. The audience is read again at queue time and right before a send, and it only ever
// narrows what trusted restrictions allow. Old entries keep what they had. Real turn, real store and memory, a scripted
// model and fake transports; assertions read request blocks, never prose. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/memory/store.ts';
import { issueContext } from '../src/memory/db/scope.ts';
import { ROOT, sceneRunner } from './fixtures/selfreflection-requests-recorded.ts';
import {
  entryOf,
  selfreflectionPublications,
  selfreflectionRows,
  seedMirror,
} from './fixtures/selfreflection-mirror.ts';
import type { RecordedEntry } from './fixtures/selfreflection-mirror.ts';
import { FOUR_HOURS, OWNER, T0, mirrorScene } from './fixtures/mirror-scene.ts';
import type { Scene } from './fixtures/mirror-scene.ts';
import { freshWorld, world } from './fixtures/turn-world.ts';
import { planAnswerText } from './fixtures/plan-answer.ts';

const TEXT = 'ήσυχο βράδυ στο λιμάνι';
const ROOT_PLACE = 'fake:root:g1';
const D1 = 'fake:channel:d1';
const D2 = 'fake:channel:d2';
const OTHER_D1 = 'other:channel:d1';

/** A model whose plan is a status and whose writer says `answer`; it keeps every request. */
function modelSaying(answer: string) {
  const calls: Array<unknown> = [];
  return {
    calls,
    complete: (messages: unknown, options?: { purpose?: string }) => {
      calls.push(structuredClone(messages));
      const text =
        options?.purpose === 'selfreflection-planner'
          ? // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
            planAnswerText({ kind: 'status', brief: 'a calm evening', search: '', picture: false }, options)
          : answer;
      return Promise.resolve({ text, usage: {}, estimated: 5 });
    },
  };
}

/** Every string of a request, joined: what the blocks are read from. */
function requestText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(requestText).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(requestText).join('\n');
  return '';
}

/** The words of one block of a request, or null when the request has no such block. */
function blockWords(request: unknown, tag: string): Array<string> | null {
  const found = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(requestText(request));
  return found ? (found[1] ?? '').split(/\s+/).filter(Boolean) : null;
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
        "INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by, extra) VALUES (?, 'selfreflection', ?, 1, ?, 'owner', NULL)"
      )
      .run(`mirror:test:${one}`, `${iface}:channel:${chatId}`, new Date(T0).toISOString());
  }
  return scene;
}

/** One diary turn in which she answers `answer`, over the scene's memory: the turn's result and the model's requests. */
async function writeEntry(scene: Scene, answer: string) {
  freshWorld();
  world().channel({ id: 'd1', name: 'journal', placeId: ROOT });
  const store = createStore({ dataDir: scene.memory.dataDir, memoryDb: scene.memory.memoryDb });
  const model = modelSaying(answer);
  const result = await sceneRunner(model, store).runTurn({
    mode: 'selfreflection',
    selfreflection: { kind: 'status', forced: true },
    placeId: ROOT,
  });
  await store.flushSettled({});
  return { result, entry: entryOf(result), store, writer: model.calls.at(-1) };
}

/** What her turn said about the audience she named. */
const audienceOf = (result: unknown): unknown =>
  (result as { selfreflection?: { audience?: unknown } }).selfreflection?.audience;

/** Every destination a send was attempted to, as `<iface>:<chat>`, sorted. */
function reached(scene: Scene): Array<string> {
  const out: Array<string> = [];
  for (const iface of ['fake', 'other'])
    for (const attempt of scene.transport(iface).attempts) out.push(`${iface}:${attempt.chatId}`);
  return out.sort();
}

test('a diary request lists its mirrors by canonical id with their interfaces and leaves out private ones', async () => {
  // Catches: raw native ids she could not tell apart, or a private chat offered as an audience.
  // Slice 6: the places she may choose among are the mirrors, listed with two or more, so the scene has two mirrors
  // that share the native id `d1` on two interfaces.
  const scene = await places(['fake:d1', 'other:d1']);
  const { writer } = await writeEntry(scene, `<msg>${TEXT}</msg>`);
  const words = blockWords(writer, 'publication_places');
  assert.ok(words, 'the writer request has the block');
  for (const token of ['interface:fake', 'interface:other', `place:${D1}`, `place:${OTHER_D1}`])
    assert.ok(words.includes(token), token);
  assert.equal(
    words.some((word) => word.includes(':dm:')),
    false
  );
});

test('leaving the audience out records an unrestricted entry that reaches every interface', async () => {
  // Catches: an omitted audience stored as nothing, which is what an old ambiguous entry looks like.
  const scene = await places(['fake:d1', 'other:d1']);
  const { result, entry } = await writeEntry(scene, `<msg>${TEXT}</msg>`);
  assert.deepEqual(audienceOf(result), { ok: true, audience: { kind: 'unrestricted' } });
  await scene.publisher().publishEntry(entry);
  assert.deepEqual(reached(scene), ['fake:d1', 'other:d1']);
});

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

test('the audience tag is no part of what she says', async () => {
  // Catches: the tag falling into the untagged fallback and being posted on the channel.
  const scene = await places(['fake:d1']);
  // No `<msg>`: the whole answer takes the parser's untagged path, where a tag it does not know stays in the text.
  const { entry } = await writeEntry(scene, `<audience>interface:fake</audience>${TEXT}`);
  assert.deepEqual(entry.messages, [TEXT]);
  await scene.publisher().publishEntry(entry);
  assert.deepEqual(scene.transport('fake').posted('d1'), [TEXT]);
  assert.equal(selfreflectionRows(scene.memory.memoryDb)[0]?.text, TEXT);
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

test('a root audience names no mirror, so it is refused and reaches no channel', async () => {
  // Catches: her choice resolved against every group place memory knows instead of the mirrors listed to her.
  // Slice 6: the places she may name are the mirrors alone, so a root that is no mirror is an unknown place and
  // the entry stays in her diary, copied nowhere, as any unlisted token is.
  const scene = await places(['fake:d1', 'fake:d2', 'fake:d3', 'other:d1']);
  const { result, entry } = await writeEntry(scene, `<audience>place:${ROOT_PLACE}</audience><msg>${TEXT}</msg>`);
  assert.deepEqual(audienceOf(result), { ok: false, code: 'audience-unknown-place' });
  await scene.publisher().publishEntry(entry);
  assert.deepEqual(reached(scene), []);
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

for (const [value, code] of [
  ['place:fake:channel:nowhere', 'audience-unknown-place'],
  ['place:d1', 'audience-unknown-place'],
  ['place:fake:dm:u1', 'audience-unknown-place'],
  ['interface:nothing', 'audience-unknown-interface'],
  ['everywhere', 'audience-malformed'],
  ['place:', 'audience-malformed'],
  ['', 'audience-malformed'],
] as const) {
  test(`the audience "${value}" fails closed with ${code}, keeps the entry and publishes nothing`, async () => {
    // Catches: a bad value read as no restriction, which publishes what she meant to hold back.
    const scene = await places(['fake:d1', 'other:d1']);
    const { result, entry } = await writeEntry(scene, `<audience>${value}</audience><msg>${TEXT}</msg>`);
    assert.deepEqual(audienceOf(result), { ok: false, code });
    assert.equal(selfreflectionRows(scene.memory.memoryDb)[0]?.text, TEXT, 'memory holds the entry');
    const outcomes = await scene.publisher().publishEntry(entry);
    assert.deepEqual(reached(scene), []);
    assert.ok(
      outcomes.length === 2 && outcomes.every((one) => one.status === 'failed' && one.code === 'audience-invalid')
    );
    await scene.publisher().drainQueued();
    assert.deepEqual(reached(scene), []);
  });
}

test('two different audiences in one answer fail closed', async () => {
  // Catches: "the first one wins", when the second one may be the narrower thing she meant.
  const scene = await places(['fake:d1']);
  const { result, entry } = await writeEntry(
    scene,
    `<audience>unrestricted</audience><audience>place:${D1}</audience><msg>${TEXT}</msg>`
  );
  assert.deepEqual(audienceOf(result), { ok: false, code: 'audience-malformed' });
  await scene.publisher().publishEntry(entry);
  assert.deepEqual(reached(scene), []);
});

/** Sets an entry's stored audience through the store, as a later change of the row would. */
async function narrow(store: Awaited<ReturnType<typeof writeEntry>>['store'], audience: unknown): Promise<void> {
  const posts = store.getSelfreflection().posts.map((post) => ({ ...post, publicationAudience: audience }));
  store.setSelfreflectionPosts(posts);
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
    selfreflectionPublications(scene.memory.memoryDb).map((row) => row.placeId),
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
    mode: 'selfreflection',
    selfreflection: { kind: 'status', forced: true },
    placeId: ROOT,
    publicationBoundary: BOUNDARY,
  });
  await store.flushSettled({});
  assert.deepEqual(audienceOf(result), { ok: true, audience: { kind: 'unrestricted' } });
  const entry: RecordedEntry = entryOf(result);
  await scene.publisher().publishEntry(entry);
  assert.deepEqual(reached(scene), ['fake:d1']);
});

test('the writer itself refuses a publication outside the stored audience', async () => {
  // Catches: the audience enforced only in the publisher, so a direct prepare queues around it.
  const scene = await places(['fake:d1', 'other:d1']);
  scene.entry({ id: 'e1', audience: { kind: 'interface', iface: 'fake' } });
  const context = issueContext({ kind: 'group', iface: 'other', destination: OTHER_D1, now: scene.now });
  const answer = await scene.memory.memoryDb.memoryWrite({
    kind: 'publication',
    op: 'prepare',
    input: { context, rowKind: 'selfreflection', rowId: 'e1', rendered: TEXT, destination: OTHER_D1 },
  });
  assert.deepEqual(answer, { ok: false, code: 'audience-excluded' });
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
