// Tests for src/memory/db/publication-delivery.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Db } from '../../../../src/memory/db/types.ts';
import { seedMirror } from '../../../fixtures/diary-mirror.ts';
import { FOUR_HOURS, LEASE, T0, mirrorScene, settle } from '../../../fixtures/mirror-scene.ts';

// PR A: delivery of the diary's publications (plan section 4). A publication is claimed through the memory writer before
// anything goes out, so overlapping timer and reconnect drains send once. Receipts are kept per entry, destination and
// segment (one send of an entry: the voice, each of the persona's messages, each message of pictures). A send whose result nobody
// knows is `uncertain` and is not retried blindly: only a receipt, an adapter lookup or the owner settles it. Missing
// media is an explicit incomplete result. One mirror's trouble stops nothing else. The mirrors are seeded rows here, so
// these tests stay on delivery; real memory and fake transports, synthetic data only.

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

test('two drains that overlap send a queued entry once', async () => {
  // Catches: the timer and the reconnect both reading `queued` and both sending, a double post on the channel.
  const { scene, transport } = await oneMirror();
  const mirrors = scene.publisher();
  scene.disconnect();
  await mirrors.publishEntry(ONE);
  scene.connect();
  const release = transport.hold();
  const drains = Promise.all([mirrors.drainQueued(), mirrors.drainQueued()]);
  await settle();
  release();
  const counts = await drains;
  assert.deepEqual(transport.posted('d1'), ['one']);
  assert.equal(counts[0] + counts[1], 1);
});

test('two publishers draining at once send a queued entry once', async () => {
  // Catches: a claim kept in the publisher's memory instead of through the writer.
  const { scene, transport } = await oneMirror();
  const first = scene.publisher();
  const second = scene.publisher();
  scene.disconnect();
  await first.publishEntry(ONE);
  scene.connect();
  const release = transport.hold();
  const drains = Promise.all([first.drainQueued(), second.drainQueued()]);
  await settle();
  release();
  await drains;
  assert.deepEqual(transport.posted('d1'), ['one']);
});

test('a drain overlapping the publish of the same entry sends it once', async () => {
  // Catches: the row `queueEntry` left being sent both by the turn's end and by the tick that happens to run.
  const { scene, transport } = await oneMirror();
  const mirrors = scene.publisher();
  await mirrors.queueEntry(ONE);
  const release = transport.hold();
  const both = Promise.all([mirrors.publishEntry(ONE), mirrors.drainQueued()]);
  await settle();
  release();
  await both;
  assert.deepEqual(transport.posted('d1'), ['one']);
  assert.equal(transport.attempts.length, 1, 'the row with no content yet is not offered to the interface');
});

test('the claim is in memory before anything reaches the interface', async () => {
  // Catches: claiming after the send, which leaves the crash window open again.
  const { scene, place, transport } = await oneMirror();
  const mirrors = scene.publisher();
  const seen: Array<string | undefined> = [];
  transport.onSend = () => seen.push(mirrors.publicationState('e1', place)?.status);
  await mirrors.publishEntry(ONE);
  assert.deepEqual(seen, ['sending']);
  assert.equal(mirrors.publicationState('e1', place)?.status, 'sent');
});

test('receipts are kept per segment and per destination, with a key of its own for each send', async () => {
  // Catches: one flat list of ids, which cannot say what a retry may skip, or a key shared across destinations.
  const { scene, place, transport } = await oneMirror();
  const second = seedMirror(scene.memory.memoryDb, { iface: 'fake', chatId: 'd2', at: T0 }).placeId;
  const mirrors = scene.publisher();
  await mirrors.publishEntry({ ...THREE, pictures: [PICTURE] });
  const state = mirrors.publicationState('e1', place);
  assert.deepEqual(
    state?.segments.map((one) => [one.segment, one.status, one.messageIds.length, one.attachmentIds.length]),
    [
      [0, 'sent', 1, 0],
      [1, 'sent', 1, 0],
      [2, 'sent', 1, 0],
      [3, 'sent', 1, 1],
    ]
  );
  assert.equal(mirrors.publicationState('e1', second)?.segments.length, 4);
  const firstSegment = state?.segments[0];
  assert.notDeepEqual(
    mirrors.publicationState('e1', second)?.segments[0]?.messageIds,
    firstSegment?.messageIds,
    'each destination holds its own receipts'
  );
  const keys = transport.attempts.map((attempt) => attempt.key);
  assert.ok(keys.every((key) => typeof key === 'string' && key !== ''));
  assert.equal(new Set(keys).size, 8, 'one key per segment per destination');
});

test('a failure between the remote success and the local receipt is uncertain and is not sent again', async () => {
  // Catches: the row left `queued` by a lost receipt write, which the next start posts a second time.
  const { scene, place, transport } = await oneMirror();
  const mirrors = scene.publisher();
  transport.onDelivered = () => scene.failWrites();
  await mirrors.publishEntry(ONE).catch(() => null);
  transport.onDelivered = () => {};
  scene.failWrites(false);
  scene.advance(LEASE + 1);
  const restarted = scene.publisher();
  assert.equal(await restarted.drainQueued(), 0);
  assert.deepEqual(transport.posted('d1'), ['one']);
  assert.equal(restarted.publicationState('e1', place)?.status, 'uncertain');
  assert.deepEqual(
    restarted.mirrorStatus()[0]?.uncertain.map((one) => one.entryId),
    ['e1']
  );
});

test('a claim whose publisher died stands until its lease ends, then counts as uncertain', async () => {
  // Catches: a restart that resends what a crash left in flight, or a live second writer's claim taken over at once.
  const { scene, place, transport } = await oneMirror();
  transport.behave = () => 'hang-after-delivery';
  void scene.publisher().publishEntry(ONE);
  await settle();
  transport.behave = () => 'deliver';
  scene.advance(LEASE - 1);
  const restarted = scene.publisher();
  assert.equal(await restarted.drainQueued(), 0);
  assert.equal(restarted.publicationState('e1', place)?.status, 'sending');
  scene.advance(2);
  assert.equal(await restarted.drainQueued(), 0);
  assert.equal(restarted.publicationState('e1', place)?.status, 'uncertain');
  assert.deepEqual(transport.posted('d1'), ['one']);
});

test('a claim is safe when the clock moves back', async () => {
  // Catches: a lease computed with a negative age read as expired, or a claim that lets a second send through.
  const { scene, place, transport } = await oneMirror();
  transport.behave = () => 'hang-after-delivery';
  void scene.publisher().publishEntry(ONE);
  await settle();
  transport.behave = () => 'deliver';
  scene.setTime(T0 - FOUR_HOURS);
  const restarted = scene.publisher();
  assert.equal(await restarted.drainQueued(), 0);
  assert.equal(restarted.publicationState('e1', place)?.status, 'sending');
  assert.deepEqual(transport.posted('d1'), ['one']);
});

test('a multipart interruption keeps the receipt of what went out and sends nothing more', async () => {
  // Catches: the ids of the first messages lost when a later one fails, and the rest posted out of order on a retry.
  const { scene, place, transport } = await oneMirror();
  const mirrors = scene.publisher();
  transport.behave = (_attempt, index) => (index === 1 ? 'lost-answer' : 'deliver');
  await mirrors.publishEntry(THREE);
  const state = mirrors.publicationState('e1', place);
  assert.equal(state?.status, 'uncertain');
  assert.deepEqual(
    state?.segments.map((one) => one.status),
    ['sent', 'uncertain', 'pending']
  );
  const firstSegment = state?.segments[0];
  assert.equal(firstSegment?.messageIds.length, 1);
  assert.equal(await mirrors.drainQueued(), 0);
  assert.deepEqual(transport.posted('d1'), ['a', 'b']);
});

test('a crash after the first segment leaves its receipt in memory', async () => {
  // Catches: receipts written once at the end of the entry, so a crash in the middle forgets what is already posted.
  const { scene, place, transport } = await oneMirror();
  transport.behave = (_attempt, index) => (index === 1 ? 'hang-after-delivery' : 'deliver');
  void scene.publisher().publishEntry(THREE);
  await settle(20);
  transport.behave = () => 'deliver';
  scene.advance(LEASE + 1);
  const restarted = scene.publisher();
  assert.equal(await restarted.drainQueued(), 0);
  const state = restarted.publicationState('e1', place);
  assert.equal(state?.status, 'uncertain');
  assert.deepEqual(
    state?.segments.map((one) => one.status),
    ['sent', 'uncertain', 'pending']
  );
  assert.deepEqual(transport.posted('d1'), ['a', 'b']);
});

test('a retryable failure in the middle resumes at that segment under the same key', async () => {
  // Catches: a retry that starts the entry over and posts its first messages twice.
  const { scene, place, transport } = await oneMirror();
  const mirrors = scene.publisher();
  transport.behave = (_attempt, index) => (index === 1 ? { refuse: 'rate-limited', retryable: true } : 'deliver');
  await mirrors.publishEntry(THREE);
  const failed = mirrors.publicationState('e1', place);
  assert.deepEqual([failed?.status, failed?.code], ['failed', 'rate-limited']);
  assert.deepEqual(
    failed?.segments.map((one) => one.status),
    ['sent', 'failed', 'pending']
  );
  assert.equal(await mirrors.drainQueued(), 1);
  assert.deepEqual(transport.posted('d1'), ['a', 'b', 'c']);
  const state = mirrors.publicationState('e1', place);
  assert.equal(state?.status, 'sent');
  assert.equal(state?.segments.flatMap((one) => one.messageIds).length, 3);
  const [, firstTry, retry] = transport.attempts;
  assert.equal(retry?.key, firstTry?.key, 'the retry of a segment keeps its key');
});

test('an adapter lookup that finds the send settles it as sent with the receipts it found', async () => {
  // Catches: a platform that can prove the result still left waiting for the owner, or the entry posted again.
  const { scene, place, transport } = await oneMirror({ reconcile: true });
  const mirrors = scene.publisher();
  transport.behave = () => 'lost-answer';
  await mirrors.publishEntry(ONE);
  transport.behave = () => 'deliver';
  await mirrors.drainQueued();
  assert.deepEqual(transport.posted('d1'), ['one']);
  const state = mirrors.publicationState('e1', place);
  assert.equal(state?.status, 'sent');
  const firstSegment = state?.segments[0];
  assert.deepEqual(firstSegment?.messageIds, [transport.fake.messagesIn('d1')[0]?.ref.messageId]);
});

test('an adapter lookup that proves the send absent lets it go out once', async () => {
  // Catches: "uncertain" treated as final when the platform has answered that nothing arrived.
  const { scene, place, transport } = await oneMirror({ reconcile: true });
  const mirrors = scene.publisher();
  transport.behave = () => 'never-sent';
  await mirrors.publishEntry(ONE);
  transport.behave = () => 'deliver';
  await mirrors.drainQueued();
  await mirrors.drainQueued();
  assert.deepEqual(transport.posted('d1'), ['one']);
  assert.equal(mirrors.publicationState('e1', place)?.status, 'sent');
});

test('an adapter lookup that fails leaves the delivery uncertain', async () => {
  // Catches: a failed read taken for "not found", which resends something that may be on the channel.
  const { scene, place, transport } = await oneMirror({ reconcile: true });
  const mirrors = scene.publisher();
  transport.behave = () => 'lost-answer';
  await mirrors.publishEntry(ONE);
  transport.behave = () => 'deliver';
  transport.fake.failNext('fetchMessages', { status: 'failed', error: { code: 'timeout', retryable: true } });
  assert.equal(await mirrors.drainQueued(), 0);
  assert.equal(mirrors.publicationState('e1', place)?.status, 'uncertain');
  assert.deepEqual(transport.posted('d1'), ['one']);
});

/** A publication row as an upgrade left it: retired, in `status`, with the columns that state keeps. */
function retiredRow(db: Db, entryId: string, placeId: string, status: string, fields: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: `pub:retired:${entryId}`,
    row_kind: 'diary',
    row_id: entryId,
    content_hash: `hash-${entryId}`,
    rendered: `text of ${entryId}`,
    destination_place_id: placeId,
    status,
    idempotency_key: `diary:${entryId}:${placeId}`,
    created_at: new Date(T0).toISOString(),
    retired_at: new Date(T0).toISOString(),
    ...fields,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO publications (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
    ...cols.map((col) => row[col] as string | number | null)
  );
}

test('a drain neither sends, looks up nor expires a retired publication, whatever state it was left in', async () => {
  // Catches: a drain that reads the queue without `retired_at`, which resumes a send the upgrade took out of the queue.
  const scene = await mirrorScene({ reconcile: true });
  const { placeId } = seedMirror(scene.memory.memoryDb, { iface: 'fake', chatId: 'd1', at: T0 });
  const uncertain = JSON.stringify({
    messages: ['x'],
    segments: [{ segment: 0, status: 'uncertain', key: 'k:0', messageIds: [], attachmentIds: [] }],
  });
  for (const id of ['e1', 'e2', 'e3', 'e4', 'e5']) scene.entry({ id });
  retiredRow(scene.db, 'e1', placeId, 'queued');
  retiredRow(scene.db, 'e2', placeId, 'failed', { retryable: 1 });
  retiredRow(scene.db, 'e3', placeId, 'incomplete', { retryable: 1 });
  retiredRow(scene.db, 'e4', placeId, 'sending', { claimed_by: 'gone', claimed_at: T0, delivery: uncertain });
  retiredRow(scene.db, 'e5', placeId, 'unknown', { delivery: uncertain });
  const before = scene.db.prepare('SELECT * FROM publications ORDER BY id').all();
  const transport = scene.transport();
  const lookups: Array<unknown> = [];
  const { fake } = transport;
  const fetch = fake.fetchMessages.bind(fake);
  transport.fetchMessages = (...args: Parameters<typeof fetch>) => {
    lookups.push(args);
    return fetch(...args);
  };
  const mirrors = scene.publisher();
  assert.equal(await mirrors.drainQueued(), 0);
  scene.advance(LEASE + 1);
  assert.equal(await mirrors.drainQueued(), 0);
  assert.deepEqual(transport.attempts, []);
  assert.deepEqual(lookups, []);
  assert.deepEqual(scene.db.prepare('SELECT * FROM publications ORDER BY id').all(), before);
});
