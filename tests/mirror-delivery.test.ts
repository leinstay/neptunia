// PR A: delivery of the diary's publications (plan section 4). A publication is claimed through the memory writer before
// anything goes out, so overlapping timer and reconnect drains send once. Receipts are kept per entry, destination and
// segment (one send of an entry: the voice, each of her messages, each message of pictures). A send whose result nobody
// knows is `uncertain` and is not retried blindly: only a receipt, an adapter lookup or the owner settles it. Missing
// media is an explicit incomplete result. One mirror's trouble stops nothing else. The mirrors are seeded rows here, so
// these tests stay on delivery; real memory and fake transports, synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { selfreflectionRows, seedMirror } from './fixtures/selfreflection-mirror.ts';
import { FOUR_HOURS, LEASE, T0, mirrorScene, restoreFile, settle } from './fixtures/mirror-scene.ts';

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
  assert.notDeepEqual(
    mirrors.publicationState('e1', second)?.segments[0]?.messageIds,
    state?.segments[0]?.messageIds,
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
  assert.equal(state?.segments[0]?.messageIds.length, 1);
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
  assert.equal(transport.attempts[2]?.key, transport.attempts[1]?.key, 'the retry of a segment keeps its key');
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
  assert.deepEqual(state?.segments[0]?.messageIds, [transport.fake.messagesIn('d1')[0]?.ref.messageId]);
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
    selfreflectionRows(scene.memory.memoryDb).map((row) => row.id),
    ['e1'],
    'the entry stays in memory'
  );
});

test('status shows each mirror its own trouble and a certain refusal is not retried by itself', async () => {
  // Catches: a failure hidden behind one aggregate line, or a forbidden channel hammered at every tick.
  const { places, mirrors, transport } = await tenMirrors();
  await mirrors.publishEntry(ONE);
  await mirrors.drainQueued();
  const status = (chat: string) => mirrors.mirrorStatus().find((mirror) => mirror.placeId === places.get(chat));
  assert.deepEqual(status('d3')?.failed, [{ entryId: 'e1', code: 'channel-no-permission', retryable: false }]);
  assert.deepEqual(status('d3')?.uncertain, []);
  assert.deepEqual(
    status('d5')?.uncertain.map((one) => one.entryId),
    ['e1']
  );
  assert.equal(status('d9')?.queued, 1);
  assert.equal(status('d9')?.interfaceConnected, false);
  assert.deepEqual(status('d0')?.failed, []);
  assert.equal(transport.attempts.filter((attempt) => attempt.chatId === 'd3').length, 1);
});

test('the next entry reaches every healthy mirror while others are in trouble, and an offline one catches up alone', async () => {
  // Catches: a failed publication of an earlier entry blocking the immediate publication of a new one.
  const { scene, mirrors, transport } = await tenMirrors();
  await mirrors.publishEntry(ONE);
  scene.advance(1000);
  scene.entry({ id: 'e2' });
  await mirrors.publishEntry({ id: 'e2', messages: ['two'] });
  assert.deepEqual(transport.posted('d0'), ['one', 'two']);
  assert.deepEqual(transport.posted('d3'), []);
  scene.connect('gone');
  const gone = scene.transport('gone');
  await mirrors.drainQueued();
  assert.deepEqual(gone.posted('d9'), ['one', 'two']);
  assert.deepEqual(transport.posted('d0'), ['one', 'two'], 'the others got nothing again');
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
  assert.equal(selfreflectionRows(scene.memory.memoryDb).length, 1);
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

test('an entry whose turn ended without a publish is queued by the next drain after the release', async () => {
  // Catches: a begun entry left out for good when its turn fails between the store and the publish.
  const { scene, place, transport } = await oneMirror();
  const mirrors = scene.publisher();
  await mirrors.publishEntry(ONE);
  scene.advance(1000);
  const release = mirrors.beginEntry();
  scene.entry({ id: 'e2' });
  release();
  release();
  assert.equal(await mirrors.drainQueued(), 1);
  assert.deepEqual(transport.posted('d1'), ['one', 'text of e2']);
  assert.equal(mirrors.publicationState('e2', place)?.status, 'sent');
});

test('an entry a crash left with no publication is queued as new after a restart', async () => {
  // Catches: memory holding an entry no mirror ever gets because the process died before its publish.
  const { scene, place, transport } = await oneMirror();
  await scene.publisher().publishEntry(ONE);
  scene.advance(1000);
  scene.entry({ id: 'e2' });
  const restarted = scene.publisher();
  assert.equal(await restarted.drainQueued(), 1);
  assert.equal(await restarted.drainQueued(), 0);
  assert.deepEqual(transport.posted('d1'), ['one', 'text of e2']);
  assert.equal(restarted.publicationState('e2', place)?.status, 'sent');
});
