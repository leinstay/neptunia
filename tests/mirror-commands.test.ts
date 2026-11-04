// PR A: the owner's `/mirror` commands (plan section 4). The family is table-registered, so the chat and
// `neptunia mirror ...` share it, and every change goes through the memory writer. Configuration is separate from
// delivery history, so removing and re-adding a destination keeps deduplication, and a remote message count never stands
// in for a receipt. The owner's reconciliation records which old entries already count as published on a destination.
// Real memory, fake transports; synthetic data only.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { COMMAND_NAMES, parseRequest } from '../bin/neptunia-request.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import type { Dirs } from './fixtures/core-units.ts';
import { cliFolders, handled, runChild, startRecordingCore } from './fixtures/recording-core.ts';
import type { RecordingCore } from './fixtures/recording-core.ts';
import { FOUR_HOURS, OWNER, T0, mirrorScene } from './fixtures/mirror-scene.ts';

const D1 = 'fake:channel:d1';

let dirs: Dirs;
let core: RecordingCore;

before(async () => {
  dirs = cliFolders();
  core = await startRecordingCore(dirs, handled);
});

after(async () => {
  await core.close();
  rmSync(dirs.root, { recursive: true, force: true });
});

/** A scene with `d1` of the fake interface known as a place, and its console. */
async function known() {
  const scene = await mirrorScene();
  const place = scene.place({ iface: 'fake', native: 'd1' });
  const mirrors = scene.publisher();
  return { scene, place, mirrors, run: scene.desk(mirrors) };
}

for (const [words, name, args] of [
  [['list'], 'mirror.list', {}],
  [['status'], 'mirror.status', {}],
  [['add', D1], 'mirror.add', { destination: D1 }],
  [
    ['add', D1, '--backfill', 'true', '--every', '4h'],
    'mirror.add',
    { destination: D1, backfill: 'true', every: '4h' },
  ],
  [['configure', D1, '--enabled', 'true'], 'mirror.configure', { mirror: D1, enabled: 'true' }],
  [
    ['configure', D1, '--backfill', 'false', '--every', '4h'],
    'mirror.configure',
    { mirror: D1, backfill: 'false', every: '4h' },
  ],
  [['disable', D1], 'mirror.disable', { mirror: D1 }],
  [['remove', D1], 'mirror.remove', { mirror: D1 }],
  [['reconcile', D1, '--through', 'e3'], 'mirror.reconcile', { mirror: D1, through: 'e3' }],
  [['reconcile', D1, '--entries', 'e1,e3'], 'mirror.reconcile', { mirror: D1, entries: 'e1,e3' }],
] as const) {
  test(`neptunia mirror ${words.join(' ')} and the chat line parse into ${name}`, () => {
    // Catches: an owner command that exists on one surface only, or an argument that lands under another name.
    assert.deepEqual(parseRequest(['mirror', ...words]).parsed, { ok: true, name, args });
    assert.deepEqual(parseCommandLine(`/mirror ${words.join(' ')}`), { ok: true, name, args });
  });
}

test('the direct form dispatches a mirror command to the core with its words unchanged', async () => {
  // Catches: `mirror` missing from the first words of the dispatcher, so the command turns into a model prompt.
  assert.ok(COMMAND_NAMES.includes('mirror'));
  core.commands.length = 0;
  core.lines.length = 0;
  const run = await runChild(dirs, ['mirror', 'add', D1, '--backfill', 'false']);
  assert.equal(run.code, 0, run.stderr.slice(0, 200));
  assert.deepEqual(core.commands, [{ name: 'mirror.add', args: { destination: D1, backfill: 'false' } }]);
  assert.deepEqual(core.lines, []);
});

test('mirror add registers a known place through the memory writer', async () => {
  // Catches: a command that writes the table on its own connection, around the one writer.
  const { scene, place, mirrors, run } = await known();
  const answer = await run('add', D1);
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(
    mirrors.listMirrors().map((one) => [one.placeId, one.enabled]),
    [[place, true]]
  );
  assert.ok(
    scene.writes.some((update) => update.kind === 'mirror'),
    'the change went through the memory writer'
  );
});

test('mirror add refuses a destination that is no known place and writes nothing', async () => {
  // Catches: a typo becoming a mirror that holds entries for a place nobody can send to.
  const { scene, mirrors, run } = await known();
  const answer = await run('add', 'fake:channel:nowhere');
  assert.equal(answer.status, 'invalid');
  assert.deepEqual(mirrors.listMirrors(), []);
  assert.deepEqual(scene.writes, []);
  assert.deepEqual(await mirrors.addMirror({ destination: 'fake:channel:nowhere', by: OWNER }), {
    ok: false,
    code: 'unknown-place',
  });
});

test('mirror add takes interface-qualified ids apart and refuses a bare native id two interfaces share', async () => {
  // Catches: resolving a destination by its native id, which posts a diary to the wrong platform.
  const scene = await mirrorScene({ ifaces: ['fake', 'other'] });
  const fake = scene.place({ iface: 'fake', native: 'same' });
  const other = scene.place({ iface: 'other', native: 'same' });
  const mirrors = scene.publisher();
  const run = scene.desk(mirrors);
  assert.deepEqual(await mirrors.addMirror({ destination: 'same', by: OWNER }), { ok: false, code: 'ambiguous-place' });
  assert.equal((await run('add', other)).status, 'ok');
  assert.deepEqual(
    mirrors.listMirrors().map((one) => one.placeId),
    [other]
  );
  assert.equal((await run('add', fake)).status, 'ok');
  assert.deepEqual(
    mirrors
      .listMirrors()
      .map((one) => one.placeId)
      .sort(),
    [fake, other].sort()
  );
});

test('a repeated add reuses the mirror', async () => {
  // Catches: a second add that errors on the unique key, or one that replaces the row and loses its settings.
  const { place, mirrors } = await known();
  const first = await mirrors.addMirror({
    destination: place,
    by: OWNER,
    backfill: { enabled: false, intervalMs: FOUR_HOURS },
  });
  const second = await mirrors.addMirror({ destination: place, by: OWNER });
  assert.ok(first.ok && second.ok);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.mirror.id, first.mirror.id);
  assert.equal(mirrors.listMirrors().length, 1);
  assert.equal(mirrors.mirrorStatus()[0]?.backfill.intervalMs, FOUR_HOURS);
});

test('mirror configure changes the mirror it names and a bad value changes nothing', async () => {
  // Catches: a duration parsed to NaN and stored, which would make the mirror's pacing fire at every drain.
  const { mirrors, run } = await known();
  await run('add', D1);
  assert.equal((await run('configure', D1, '--backfill', 'false', '--every', '4h')).status, 'ok');
  assert.equal(mirrors.mirrorStatus()[0]?.backfill.intervalMs, FOUR_HOURS);
  assert.equal((await run('configure', D1, '--every', 'soon')).status, 'invalid');
  assert.equal((await run('configure', D1, '--every', '0h')).status, 'invalid');
  assert.equal((await run('configure', D1, '--enabled', 'perhaps')).status, 'invalid');
  assert.equal(mirrors.mirrorStatus()[0]?.backfill.intervalMs, FOUR_HOURS);
  assert.equal(mirrors.listMirrors()[0]?.enabled, true);
  assert.equal((await run('configure', D1, '--enabled', 'false')).status, 'ok');
  assert.equal(mirrors.listMirrors()[0]?.enabled, false);
  assert.equal((await run('configure', 'fake:channel:nowhere', '--enabled', 'true')).status, 'invalid');
});

test('mirror disable keeps the configuration and sends nothing until the mirror is enabled again', async () => {
  // Catches: disable deleting the row, or a disabled mirror still receiving what was queued for it.
  const { scene, place, mirrors, run } = await known();
  await run('add', D1);
  scene.disconnect();
  scene.entry({ id: 'e1' });
  await mirrors.publishEntry({ id: 'e1', messages: ['one'] });
  scene.connect();
  assert.equal((await run('disable', D1)).status, 'ok');
  assert.deepEqual(
    mirrors.listMirrors().map((one) => [one.placeId, one.enabled]),
    [[place, false]]
  );
  await mirrors.drainQueued();
  assert.deepEqual(scene.transport().posted('d1'), []);
  await run('configure', D1, '--enabled', 'true');
  await mirrors.drainQueued();
  assert.deepEqual(scene.transport().posted('d1'), ['one']);
});

test('mirror remove takes the destination out of the list and refuses an unknown one', async () => {
  // Catches: a removed mirror still listed, or still treated as a place only the diary may write in.
  const { mirrors, run } = await known();
  await run('add', D1);
  assert.equal((await run('remove', D1)).status, 'ok');
  assert.deepEqual(mirrors.listMirrors(), []);
  assert.equal((await run('remove', D1)).status, 'invalid');
});

test('mirror list answers a zero-mirror database', async () => {
  // Catches: a list or status that fails because nothing is set up, which is the normal state before the owner acts.
  const { mirrors, run } = await known();
  assert.equal((await run('list')).status, 'ok');
  assert.equal((await run('status')).status, 'ok');
  assert.deepEqual(mirrors.mirrorStatus(), []);
});

test('an unreachable interface delays delivery and keeps the mirror and the entry', async () => {
  // Catches: add or publish refusing because the interface is down, which loses the owner's setup or the entry.
  const { scene, mirrors, run } = await known();
  scene.disconnect();
  assert.equal((await run('add', D1)).status, 'ok');
  scene.entry({ id: 'e1' });
  await mirrors.publishEntry({ id: 'e1', messages: ['one'] });
  assert.equal(mirrors.mirrorStatus()[0]?.queued, 1);
  assert.equal(mirrors.mirrorStatus()[0]?.interfaceConnected, false);
  scene.connect();
  const restarted = scene.publisher();
  assert.equal(await restarted.drainQueued(), 1);
  assert.deepEqual(scene.transport().posted('d1'), ['one']);
  assert.equal(restarted.mirrorStatus()[0]?.queued, 0);
});

test('removing and re-adding a destination does not send a delivered entry again', async () => {
  // Catches: delivery history stored on the mirror row, so a removal forgets what the destination already holds.
  const { scene, place, mirrors, run } = await known();
  await run('add', D1);
  scene.entry({ id: 'e1' });
  await mirrors.publishEntry({ id: 'e1', messages: ['one'] });
  await run('remove', D1);
  await run('add', D1, '--backfill', 'true', '--every', '4h');
  await mirrors.publishEntry({ id: 'e1', messages: ['one'] });
  await mirrors.drainQueued();
  scene.advance(FOUR_HOURS);
  await mirrors.drainQueued();
  assert.deepEqual(scene.transport().posted('d1'), ['one']);
  assert.equal(mirrors.publicationState('e1', place)?.status, 'sent');
});

test('a database of 50 entries with receipts for 49 queues exactly the remaining entry on enabling backfill', async () => {
  // Catches: a backfill that starts from a position or a count, which skips the gap or reposts 49 entries.
  const { scene, place, mirrors, run } = await known();
  for (let i = 0; i < 50; i += 1) {
    const id = `e${i}`;
    scene.entry({ id, at: T0 - (50 - i) * 60_000, position: i });
    if (i !== 17) scene.receipt(id, place, 'fake', [`old-${i}`]);
  }
  assert.equal((await run('add', D1, '--backfill', 'true', '--every', '4h')).status, 'ok');
  assert.equal(mirrors.mirrorStatus()[0]?.backfill.remaining, 1);
  assert.equal(await mirrors.drainQueued(), 1);
  assert.deepEqual(scene.transport().posted('d1'), ['text of e17']);
  assert.equal(mirrors.publicationState('e17', place)?.status, 'sent');
  scene.advance(FOUR_HOURS);
  assert.equal(await mirrors.drainQueued(), 0);
});

test('a remote message count neither creates a receipt nor is read to decide what to send', async () => {
  // Catches: inferring delivery from how many messages the channel holds, when one entry can be several messages.
  const { scene, mirrors, run } = await known();
  for (let i = 0; i < 3; i += 1) {
    scene.transport().fake.seed('d1', { authorId: 'self', text: `old post ${i}`, messageId: `old-${i}` });
    scene.entry({ id: `e${i}`, at: T0 - (3 - i) * 60_000, position: i });
  }
  await run('add', D1, '--backfill', 'true', '--every', '4h');
  assert.equal(mirrors.mirrorStatus()[0]?.backfill.remaining, 3, 'three remote messages are not three receipts');
  await mirrors.drainQueued();
  assert.deepEqual(
    scene
      .transport()
      .fake.calls.map((call) => call.op)
      .filter((op) => op !== 'send'),
    [],
    'nothing was read from the destination'
  );
});

// ---- the owner's reconciliation of old receipts ---------------------------------------------------------------------

/** Five old entries in order, a mirror with no backfill on `d1`. */
async function fiveOld() {
  const known_ = await known();
  for (let i = 1; i <= 5; i += 1) known_.scene.entry({ id: `e${i}`, at: T0 - (10 - i) * 60_000, position: i });
  await known_.run('add', D1, '--backfill', 'false');
  return known_;
}

test('reconciling through a boundary records the entries up to it, sends nothing and names the owner', async () => {
  // Catches: an old channel reposted whole because its history has no receipts, or a receipt nobody can attribute.
  const { scene, place, mirrors, run } = await fiveOld();
  const answer = await run('reconcile', D1, '--through', 'e3');
  assert.equal(answer.status, 'ok', answer.text);
  for (const id of ['e1', 'e2', 'e3']) {
    const state = mirrors.publicationState(id, place);
    assert.equal(state?.status, 'sent', id);
    assert.equal(state?.reconciledBy, OWNER, id);
  }
  assert.equal(mirrors.publicationState('e4', place), null);
  assert.deepEqual(scene.transport().attempts, []);
});

test('backfill after a boundary starts at the first entry past it', async () => {
  // Catches: reconciliation stored apart from the publications, so the backfill scan does not see it.
  const { scene, mirrors, run } = await fiveOld();
  await run('reconcile', D1, '--through', 'e3');
  await run('configure', D1, '--backfill', 'true', '--every', '4h');
  assert.equal(mirrors.mirrorStatus()[0]?.backfill.remaining, 2);
  await mirrors.drainQueued();
  assert.deepEqual(scene.transport().posted('d1'), ['text of e4']);
});

test('reconciling chosen entries records only those', async () => {
  // Catches: a chosen list read as a boundary, which would mark the entries between them as published.
  const { scene, place, mirrors, run } = await fiveOld();
  assert.equal((await run('reconcile', D1, '--entries', 'e1,e4')).status, 'ok');
  assert.equal(mirrors.publicationState('e1', place)?.reconciledBy, OWNER);
  assert.equal(mirrors.publicationState('e4', place)?.reconciledBy, OWNER);
  assert.equal(mirrors.publicationState('e2', place), null);
  assert.deepEqual(scene.transport().attempts, []);
});

test('an unknown entry refuses the whole reconciliation and writes nothing', async () => {
  // Catches: half of a list recorded before the typo is found, or an invented id written as a receipt.
  const { scene, place, mirrors, run } = await fiveOld();
  const before_ = scene.writes.length;
  assert.equal((await run('reconcile', D1, '--entries', 'e1,e99')).status, 'invalid');
  assert.equal((await run('reconcile', D1, '--through', 'e99')).status, 'invalid');
  assert.deepEqual(await mirrors.reconcileReceipts({ mirror: place, by: OWNER, entries: ['e1', 'e99'] }), {
    ok: false,
    code: 'unknown-entry',
    entryId: 'e99',
  });
  assert.equal(scene.writes.length, before_);
  assert.equal(mirrors.publicationState('e1', place), null);
});

test('a count alone never creates a receipt', async () => {
  // Catches: "the channel has 49 posts, so count 49 as published": a number names no entry.
  const { place, mirrors, run } = await fiveOld();
  assert.equal(parseRequest(['mirror', 'reconcile', D1, '--count', '3']).parsed.ok, false);
  assert.equal((await run('reconcile', D1, '--through', '3')).status, 'invalid', 'a number is no entry id');
  assert.equal((await run('reconcile', D1)).status, 'invalid', 'neither a boundary nor entries');
  assert.equal(mirrors.publicationState('e1', place), null);
});

test('reconciling a destination that is no mirror is refused', async () => {
  // Catches: a receipt written for a place the diary never had, which would silence a later mirror there.
  const { scene, mirrors } = await known();
  scene.entry({ id: 'e1' });
  const other = scene.place({ iface: 'fake', native: 'd2' });
  assert.deepEqual(await mirrors.reconcileReceipts({ mirror: other, by: OWNER, through: 'e1' }), {
    ok: false,
    code: 'unknown-mirror',
  });
});

test('reconciliation keeps the real receipts of an entry that was sent', async () => {
  // Catches: the owner's mark overwriting the message ids a later edit or lookup still needs.
  const { scene, place, mirrors, run } = await fiveOld();
  await mirrors.publishEntry({ id: 'e2', messages: ['two'] });
  const sent = mirrors.publicationState('e2', place)?.segments[0]?.messageIds;
  assert.equal(sent?.length, 1);
  await run('reconcile', D1, '--through', 'e3');
  assert.deepEqual(mirrors.publicationState('e2', place)?.segments[0]?.messageIds, sent);
  assert.equal(mirrors.publicationState('e2', place)?.reconciledBy, null);
  assert.deepEqual(scene.transport().posted('d1'), ['two']);
});

test('the owner settles an uncertain delivery by reconciling it, and it is not sent again', async () => {
  // Catches: an uncertain delivery with no way out when the platform cannot be asked.
  const { scene, place, mirrors, run } = await fiveOld();
  scene.transport().behave = () => 'lost-answer';
  await mirrors.publishEntry({ id: 'e1', messages: ['one'] });
  assert.equal(mirrors.publicationState('e1', place)?.status, 'uncertain');
  assert.equal((await run('reconcile', D1, '--entries', 'e1')).status, 'ok');
  assert.equal(mirrors.publicationState('e1', place)?.status, 'sent');
  assert.equal(mirrors.publicationState('e1', place)?.reconciledBy, OWNER);
  assert.deepEqual(mirrors.mirrorStatus()[0]?.uncertain, []);
  scene.transport().behave = () => 'deliver';
  await mirrors.drainQueued();
  assert.deepEqual(scene.transport().posted('d1'), ['one']);
});
