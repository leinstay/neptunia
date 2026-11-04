// PR B: paced historical backfill per mirror (plan section 6). Each mirror holds its interval, enabled state, the
// high-water mark captured at the start and its next due time. The oldest eligible entry goes first, by persisted order,
// one per interval, with no burst after downtime. A blocked entry holds back the later old entries of that mirror,
// visibly, and new entries go out at once and never move the finish line. The drain the scheduler already runs does the
// sending. Injected clock, real memory, fake transports; synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FOUR_HOURS, HOUR, OWNER, T0, mirrorScene, restoreFile, settle } from './fixtures/mirror-scene.ts';
import type { Scene } from './fixtures/mirror-scene.ts';

const D1 = 'fake:channel:d1';
const ON = { enabled: true, intervalMs: FOUR_HOURS } as const;

/** A scene whose place `d1` is known, holding old entries `e1`..`e<count>`, oldest first, before T0. */
async function oldEntries(count: number) {
  const scene = await mirrorScene();
  scene.place({ iface: 'fake', native: 'd1' });
  for (let i = 1; i <= count; i += 1) scene.entry({ id: `e${i}`, at: T0 - (count + 1 - i) * HOUR, position: i });
  return { scene, transport: scene.transport(), mirrors: scene.publisher() };
}

const statusOf = (mirrors: ReturnType<Scene['publisher']>) => {
  const [first] = mirrors.mirrorStatus();
  assert.ok(first, 'the mirror is listed');
  return first;
};

test('with backfill off a new mirror gets entries created after it and never an old one', async () => {
  // Catches: registering a mirror posting the whole diary to a channel the owner only meant to use from now on.
  const { scene, transport, mirrors } = await oldEntries(3);
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: { enabled: false, intervalMs: FOUR_HOURS } });
  assert.equal(await mirrors.drainQueued(), 0);
  scene.advance(10 * FOUR_HOURS);
  assert.equal(await mirrors.drainQueued(), 0);
  assert.deepEqual(transport.attempts, []);
  scene.entry({ id: 'new', position: 9 });
  await mirrors.publishEntry({ id: 'new', messages: ['new one'] });
  assert.deepEqual(transport.posted('d1'), ['new one']);
  assert.equal(statusOf(mirrors).backfill.enabled, false);
});

test('enabling captures the high-water mark, makes the first entry due now and paces the rest by the interval', async () => {
  // Catches: an off-by-one at the four-hour boundary, or a first entry made to wait a whole interval.
  const { scene, transport, mirrors } = await oldEntries(3);
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
  const started = statusOf(mirrors).backfill;
  assert.deepEqual(
    [started.enabled, started.intervalMs, started.highWater, started.nextDueAt, started.remaining],
    [true, FOUR_HOURS, 'e3', T0, 3]
  );
  assert.equal(await mirrors.drainQueued(), 1);
  assert.equal(await mirrors.drainQueued(), 0, 'a second drain at the same moment sends nothing');
  assert.equal(statusOf(mirrors).backfill.nextDueAt, T0 + FOUR_HOURS);
  scene.setTime(T0 + FOUR_HOURS - 1);
  assert.equal(await mirrors.drainQueued(), 0);
  scene.setTime(T0 + FOUR_HOURS);
  assert.equal(await mirrors.drainQueued(), 1);
  assert.deepEqual(transport.posted('d1'), ['text of e1', 'text of e2']);
});

test('old entries go out by persisted order, whatever the insert order or the file times', async () => {
  // Catches: ordering by rowid or file mtime, which publishes a diary out of its own order.
  const scene = await mirrorScene();
  scene.place({ iface: 'fake', native: 'd1' });
  scene.entry({ id: 'zz-third', at: T0 - HOUR, position: 3 });
  scene.entry({ id: 'aa-first', at: T0 - 3 * HOUR, position: 1 });
  scene.entry({ id: 'mm-second', at: T0 - 2 * HOUR, position: 2 });
  const mirrors = scene.publisher();
  for (const [id, seconds] of [
    ['zz-third', 100],
    ['aa-first', 300],
    ['mm-second', 200],
  ] as const) {
    await mirrors.keepEntryMedia({
      id,
      messages: [],
      pictures: [{ buffer: new Uint8Array([1]), mediaType: 'image/png' }],
    });
    for (const file of scene.mediaFiles(id)) fs.utimesSync(file, seconds, seconds);
  }
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
  for (let i = 0; i < 3; i += 1) {
    await mirrors.drainQueued();
    scene.advance(FOUR_HOURS);
  }
  assert.deepEqual(
    scene
      .transport()
      .attempts.map((attempt) => attempt.text)
      .filter(Boolean),
    ['text of aa-first', 'text of mm-second', 'text of zz-third']
  );
});

test('equal times fall back on the position, and two entries at one moment keep their order', async () => {
  // Catches: an order with no tie break, which can swap posts written within the same millisecond.
  const scene = await mirrorScene();
  scene.place({ iface: 'fake', native: 'd1' });
  scene.entry({ id: 'zz', at: T0 - HOUR, position: 1 });
  scene.entry({ id: 'aa', at: T0 - HOUR, position: 2 });
  const mirrors = scene.publisher();
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
  await mirrors.drainQueued();
  assert.deepEqual(scene.transport().posted('d1'), ['text of zz']);
});

test('after downtime one due entry goes out and the next is scheduled from now', async () => {
  // Catches: a catch-up burst of every missed interval, which floods the channel after a week offline.
  const { scene, transport, mirrors } = await oldEntries(5);
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
  await mirrors.drainQueued();
  const back = T0 + 100 * HOUR;
  scene.setTime(back);
  const restarted = scene.publisher();
  assert.equal(await restarted.drainQueued(), 1);
  assert.equal(await restarted.drainQueued(), 0);
  assert.equal(statusOf(restarted).backfill.nextDueAt, back + FOUR_HOURS);
  assert.deepEqual(transport.posted('d1'), ['text of e1', 'text of e2']);
});

test('a new entry goes out at once during backfill, moves neither the due time nor the finish line', async () => {
  // Catches: new entries queued behind the old ones, or a backfill that never ends because the diary keeps growing.
  const { scene, transport, mirrors } = await oldEntries(2);
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
  await mirrors.drainQueued();
  scene.advance(HOUR);
  scene.entry({ id: 'new', position: 9 });
  await mirrors.publishEntry({ id: 'new', messages: ['new one'] });
  assert.deepEqual(transport.posted('d1'), ['text of e1', 'new one']);
  const during = statusOf(mirrors).backfill;
  assert.deepEqual([during.highWater, during.nextDueAt, during.remaining], ['e2', T0 + FOUR_HOURS, 1]);
  scene.setTime(T0 + FOUR_HOURS);
  await mirrors.drainQueued();
  assert.deepEqual(transport.posted('d1'), ['text of e1', 'new one', 'text of e2']);
  assert.equal(statusOf(mirrors).backfill.enabled, false);
});

test('an entry stored after the start with no publication goes out as new, past the mark and outside the slots', async () => {
  // Catches: an entry lost to a crash before its publish, or one that takes a historical slot and moves the finish line.
  const { scene, transport, mirrors } = await oldEntries(2);
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
  await mirrors.drainQueued();
  scene.setTime(T0 + HOUR);
  scene.entry({ id: 'later', at: T0 + HOUR, position: 9 });
  const restarted = scene.publisher();
  assert.equal(await restarted.drainQueued(), 1);
  assert.deepEqual(transport.posted('d1'), ['text of e1', 'text of later']);
  const during = statusOf(restarted).backfill;
  assert.deepEqual([during.highWater, during.nextDueAt, during.remaining], ['e2', T0 + FOUR_HOURS, 1]);
  scene.setTime(T0 + FOUR_HOURS);
  assert.equal(await restarted.drainQueued(), 1);
  assert.deepEqual(transport.posted('d1'), ['text of e1', 'text of later', 'text of e2']);
  assert.equal(statusOf(restarted).backfill.enabled, false);
});

test('backfill turns itself off when the bounded queue is done', async () => {
  // Catches: a mirror left "backfilling" forever, firing a scan at every tick.
  const { scene, mirrors } = await oldEntries(2);
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
  await mirrors.drainQueued();
  assert.equal(statusOf(mirrors).backfill.enabled, true);
  scene.advance(FOUR_HOURS);
  await mirrors.drainQueued();
  const done = statusOf(mirrors).backfill;
  assert.deepEqual([done.enabled, done.remaining, done.completedAt], [false, 0, T0 + FOUR_HOURS]);
});

test('zero eligible entries complete the backfill at once', async () => {
  // Catches: a backfill waiting for a first send that will never come.
  const { mirrors } = await oldEntries(0);
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
  const done = statusOf(mirrors).backfill;
  assert.deepEqual([done.enabled, done.remaining, done.completedAt, done.nextDueAt], [false, 0, T0, null]);
});

test('an entry whose receipts all exist counts as not eligible, so enabling completes at once', async () => {
  // Catches: a queue built from entries alone, which reposts what a legacy receipt already covers.
  const { scene, transport, mirrors } = await oldEntries(2);
  scene.receipt('e1', D1, 'fake', ['old-1']);
  scene.receipt('e2', D1, 'fake', ['old-2']);
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
  assert.equal(statusOf(mirrors).backfill.enabled, false);
  await mirrors.drainQueued();
  assert.deepEqual(transport.attempts, []);
});

test('entries outside the audience are passed over without blocking the entries after them', async () => {
  // Catches: an entry that may never go to this mirror being reported as blocked, which would stop the backfill for good.
  const scene = await mirrorScene({ ifaces: ['fake', 'other'] });
  scene.place({ iface: 'fake', native: 'd1' });
  scene.entry({ id: 'e1', at: T0 - 3 * HOUR, position: 1, audience: { kind: 'interface', iface: 'other' } });
  scene.entry({
    id: 'e2',
    at: T0 - 2 * HOUR,
    position: 2,
    legacy: true,
    scope: { scope_kind: 'internal', scope_iface: null, scope_dm: null },
  });
  scene.entry({ id: 'e3', at: T0 - HOUR, position: 3 });
  const mirrors = scene.publisher();
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
  assert.equal(statusOf(mirrors).backfill.remaining, 1);
  await mirrors.drainQueued();
  assert.deepEqual(scene.transport().posted('d1'), ['text of e3']);
  assert.equal(statusOf(mirrors).backfill.blocked, null);
});

test('an audience narrowed during backfill stops a later send and the next entry takes its slot later', async () => {
  // Catches: a queue checked once when backfill started, which publishes what she has since restricted.
  const { scene, transport, mirrors } = await oldEntries(3);
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
  await mirrors.drainQueued();
  scene.db
    .prepare('UPDATE diary SET extra = ? WHERE id = ?')
    .run(JSON.stringify({ publicationAudience: { kind: 'interface', iface: 'other' } }), 'e2');
  scene.advance(FOUR_HOURS);
  await mirrors.drainQueued();
  scene.advance(FOUR_HOURS);
  await mirrors.drainQueued();
  assert.deepEqual(transport.posted('d1'), ['text of e1', 'text of e3']);
  assert.equal(statusOf(mirrors).backfill.blocked, null);
});

test('a missing attachment blocks the later old entries of that mirror, visibly, and new entries still go out', async () => {
  // Catches: an entry skipped silently so history has a hole, or a later entry published ahead of it.
  const { scene, transport, mirrors } = await oldEntries(3);
  await mirrors.keepEntryMedia({
    id: 'e1',
    messages: [],
    pictures: [{ buffer: new Uint8Array([1, 2]), mediaType: 'image/png' }],
  });
  const [file] = scene.mediaFiles('e1');
  assert.ok(file);
  const bytes = fs.readFileSync(file);
  fs.rmSync(file);
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
  await mirrors.drainQueued();
  assert.deepEqual(statusOf(mirrors).backfill.blocked, { entryId: 'e1', code: 'media-missing' });
  for (let i = 0; i < 3; i += 1) {
    scene.advance(FOUR_HOURS);
    await mirrors.drainQueued();
  }
  assert.equal(transport.attempts.length, 0, 'nothing goes past it');
  assert.equal(statusOf(mirrors).backfill.enabled, true);
  scene.entry({ id: 'new', position: 9 });
  await mirrors.publishEntry({ id: 'new', messages: ['new one'] });
  assert.deepEqual(transport.posted('d1'), ['new one']);
  restoreFile(file, bytes);
  scene.advance(FOUR_HOURS);
  await mirrors.drainQueued();
  assert.equal(statusOf(mirrors).backfill.blocked, null);
  assert.equal(transport.posted('d1')[1], 'text of e1');
  assert.equal(
    transport.attempts.some((attempt) => attempt.text === 'text of e2'),
    false
  );
});

test('a refused old entry blocks the mirror, is retried at the next slot and never earlier', async () => {
  // Catches: a retry at every 30-second tick, or a refusal that moves on to the next entry.
  const { scene, transport, mirrors } = await oldEntries(2);
  transport.behave = () => ({ refuse: 'channel-no-permission' });
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
  await mirrors.drainQueued();
  assert.deepEqual(statusOf(mirrors).backfill.blocked, { entryId: 'e1', code: 'channel-no-permission' });
  assert.equal(statusOf(mirrors).backfill.nextDueAt, T0 + FOUR_HOURS);
  await mirrors.drainQueued();
  assert.equal(transport.attempts.length, 1);
  transport.behave = () => 'deliver';
  scene.setTime(T0 + FOUR_HOURS);
  await mirrors.drainQueued();
  assert.deepEqual(transport.posted('d1'), ['text of e1']);
  assert.equal(statusOf(mirrors).backfill.blocked, null);
});

test('the owner unblocks a lost entry by reconciling it, and the next old entry follows at its slot', async () => {
  // Catches: a permanently lost file that stops a backfill with no way out.
  const { scene, transport, mirrors } = await oldEntries(2);
  await mirrors.keepEntryMedia({
    id: 'e1',
    messages: [],
    pictures: [{ buffer: new Uint8Array([1]), mediaType: 'image/png' }],
  });
  for (const file of scene.mediaFiles('e1')) fs.rmSync(file);
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
  await mirrors.drainQueued();
  assert.equal(statusOf(mirrors).backfill.blocked?.entryId, 'e1');
  const settled = await mirrors.reconcileReceipts({ mirror: D1, by: OWNER, entries: ['e1'] });
  assert.ok(settled.ok);
  scene.advance(FOUR_HOURS);
  await mirrors.drainQueued();
  assert.deepEqual(transport.posted('d1'), ['text of e2']);
});

test('uncertain deliveries are left out of the scan and stay shown', async () => {
  // Catches: a backfill that resends what may already be on the channel because it has no `sent` row.
  const { scene, transport, mirrors } = await oldEntries(3);
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: { enabled: false, intervalMs: FOUR_HOURS } });
  scene.receipt('e1', D1, 'fake', ['old-1']);
  transport.behave = () => 'lost-answer';
  await mirrors.publishEntry({ id: 'e2', messages: ['text of e2'] });
  transport.behave = () => 'deliver';
  const attempted = transport.attempts.length;
  await mirrors.configureMirror({ mirror: D1, by: OWNER, backfill: ON });
  assert.equal(statusOf(mirrors).backfill.remaining, 1);
  await mirrors.drainQueued();
  assert.deepEqual(
    transport.attempts.slice(attempted).map((attempt) => attempt.text),
    ['text of e3']
  );
  assert.deepEqual(
    statusOf(mirrors).uncertain.map((one) => one.entryId),
    ['e2']
  );
});

test('progress survives a disable and a restart, with no repeat and no burst', async () => {
  // Catches: progress kept in the publisher's memory, or a re-enable that restarts from the first entry.
  const { scene, transport, mirrors } = await oldEntries(3);
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
  await mirrors.drainQueued();
  await mirrors.disableMirror({ mirror: D1, by: OWNER });
  scene.advance(3 * FOUR_HOURS);
  assert.equal(await mirrors.drainQueued(), 0);
  const restarted = scene.publisher();
  assert.equal(await restarted.drainQueued(), 0);
  await restarted.configureMirror({ mirror: D1, by: OWNER, enabled: true });
  const resumed = statusOf(restarted).backfill;
  assert.deepEqual([resumed.enabled, resumed.highWater, resumed.remaining], [true, 'e3', 2]);
  assert.equal(await restarted.drainQueued(), 1);
  assert.equal(await restarted.drainQueued(), 0);
  assert.deepEqual(transport.posted('d1'), ['text of e1', 'text of e2']);
});

test('turning backfill off keeps the progress and turning it on again continues without a new mark', async () => {
  // Catches: a re-enable capturing a new high-water mark, or an entry written meanwhile waiting on the backfill.
  const { scene, transport, mirrors } = await oldEntries(2);
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
  await mirrors.drainQueued();
  await mirrors.configureMirror({ mirror: D1, by: OWNER, backfill: { enabled: false } });
  scene.advance(FOUR_HOURS);
  assert.equal(await mirrors.drainQueued(), 0);
  scene.entry({ id: 'later', at: scene.now(), position: 9 });
  assert.equal(await mirrors.drainQueued(), 1, 'a new entry needs no backfill');
  assert.deepEqual(transport.posted('d1'), ['text of e1', 'text of later']);
  assert.equal(statusOf(mirrors).backfill.highWater, 'e2');
  await mirrors.configureMirror({ mirror: D1, by: OWNER, backfill: { enabled: true } });
  assert.equal(statusOf(mirrors).backfill.highWater, 'e2');
  assert.equal(await mirrors.drainQueued(), 1);
  scene.advance(FOUR_HOURS);
  assert.equal(await mirrors.drainQueued(), 0);
  assert.deepEqual(transport.posted('d1'), ['text of e1', 'text of later', 'text of e2']);
});

test('a second writer attempting the same due slot sends nothing extra', async () => {
  // Catches: a due time read and advanced in two steps, so both publishers take the slot with different entries.
  const { scene, transport, mirrors } = await oldEntries(3);
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
  const other = scene.publisher();
  const release = transport.hold();
  const both = Promise.all([mirrors.drainQueued(), other.drainQueued()]);
  await settle();
  release();
  await both;
  assert.deepEqual(transport.posted('d1'), ['text of e1']);
  assert.equal(statusOf(mirrors).backfill.nextDueAt, T0 + FOUR_HOURS);
});

test('a clock moved back sends nothing extra and does not stall the backfill', async () => {
  // Catches: a slot repeated by a time jump, or a due time left days ahead of a corrected clock.
  const { scene, transport, mirrors } = await oldEntries(3);
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
  await mirrors.drainQueued();
  const back = T0 - 48 * HOUR;
  scene.setTime(back);
  assert.equal(await mirrors.drainQueued(), 0);
  assert.equal(statusOf(mirrors).backfill.nextDueAt, back + FOUR_HOURS, 'never more than one interval away');
  scene.setTime(back + FOUR_HOURS);
  assert.equal(await mirrors.drainQueued(), 1);
  assert.deepEqual(transport.posted('d1'), ['text of e1', 'text of e2']);
});

test('a clock that jumped ahead and came back causes one send and no stall', async () => {
  // Catches: a due time pushed a year ahead by a wrong clock, which stops the backfill once the clock is right.
  const { scene, transport, mirrors } = await oldEntries(3);
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
  scene.setTime(T0 + 8760 * HOUR);
  assert.equal(await mirrors.drainQueued(), 1);
  scene.setTime(T0);
  assert.equal(await mirrors.drainQueued(), 0);
  scene.setTime(T0 + FOUR_HOURS);
  assert.equal(await mirrors.drainQueued(), 1);
  assert.deepEqual(transport.posted('d1'), ['text of e1', 'text of e2']);
});

test('a temporarily missing interface holds the slot and sends one entry when it returns', async () => {
  // Catches: slots consumed while nobody could send, or a burst of them on reconnect.
  const { scene, transport, mirrors } = await oldEntries(3);
  scene.disconnect();
  await mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
  scene.advance(3 * FOUR_HOURS);
  assert.equal(await mirrors.drainQueued(), 0);
  assert.equal(statusOf(mirrors).backfill.remaining, 3);
  scene.connect();
  assert.equal(await mirrors.drainQueued(), 1);
  assert.equal(await mirrors.drainQueued(), 0);
  assert.deepEqual(transport.posted('d1'), ['text of e1']);
  assert.equal(statusOf(mirrors).backfill.nextDueAt, T0 + 3 * FOUR_HOURS + FOUR_HOURS);
});

test('ten mirrors pace independently, one blocked or offline holding back none of the others', async () => {
  // Catches: one shared due time or one shared queue, so a slow mirror sets the pace of all of them.
  const scene = await mirrorScene({ ifaces: ['fake', 'gone'] });
  for (let i = 0; i < 9; i += 1) scene.place({ iface: 'fake', native: `d${i}` });
  scene.place({ iface: 'gone', native: 'd9' });
  for (let i = 1; i <= 2; i += 1) scene.entry({ id: `e${i}`, at: T0 - (3 - i) * HOUR, position: i });
  scene.disconnect('gone');
  scene.transport().behave = (attempt) =>
    attempt.conversationId === 'd3' ? { refuse: 'channel-no-permission' } : 'deliver';
  const mirrors = scene.publisher();
  for (let i = 0; i < 9; i += 1)
    await mirrors.addMirror({
      destination: `fake:channel:d${i}`,
      by: OWNER,
      // The last mirrors run at a slower pace of their own.
      backfill: { enabled: true, intervalMs: i < 5 ? FOUR_HOURS : 2 * FOUR_HOURS },
    });
  await mirrors.addMirror({ destination: 'gone:channel:d9', by: OWNER, backfill: ON });
  await mirrors.drainQueued();
  const transport = scene.transport();
  assert.deepEqual(transport.posted('d0'), ['text of e1']);
  assert.deepEqual(transport.posted('d8'), ['text of e1']);
  assert.deepEqual(transport.posted('d3'), []);
  scene.advance(FOUR_HOURS);
  await mirrors.drainQueued();
  assert.deepEqual(transport.posted('d0'), ['text of e1', 'text of e2']);
  assert.deepEqual(transport.posted('d8'), ['text of e1'], 'its own interval has not passed');
  assert.deepEqual(transport.posted('d3'), []);
  const byPlace = new Map(mirrors.mirrorStatus().map((one) => [one.placeId, one.backfill]));
  assert.equal(byPlace.get('fake:channel:d0')?.enabled, false, 'done');
  assert.equal(byPlace.get('fake:channel:d3')?.blocked?.entryId, 'e1');
  assert.equal(byPlace.get('gone:channel:d9')?.remaining, 2);
  assert.equal(mirrors.mirrorStatus().length, 10);
});

test('a mirror added while an entry is being stored misses nothing and repeats nothing', async () => {
  // Catches: an entry that falls between the mark and the live path, unseen by both.
  const { scene, transport, mirrors } = await oldEntries(1);
  const adding = mirrors.addMirror({ destination: D1, by: OWNER, backfill: ON });
  scene.entry({ id: 'racing', at: T0, position: 5 });
  await adding;
  await mirrors.publishEntry({ id: 'racing', messages: ['text of racing'] });
  for (let i = 0; i < 3; i += 1) {
    await mirrors.drainQueued();
    scene.advance(FOUR_HOURS);
  }
  const posted = transport.posted('d1');
  assert.deepEqual([...posted].sort(), ['text of e1', 'text of racing']);
});
