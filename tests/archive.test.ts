// Tests for src/memory/archive.ts: the archive of every memory item that left a hot list, written to the memory
// database of a temporary directory (never the deployment's data/); the entries waiting for it are JSON lines
// through a real append store.
import { legacyServerPlaceId } from './fixtures/memory-db/legacy-paths.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAppendStore } from '../src/memory/append-store.ts';
import { archiveEntry, createArchive } from '../src/memory/archive.ts';
import { openTestMemory, unitFile } from './fixtures/memory-db/service.ts';
import type { Untyped } from '../src/tools/types.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

const quiet = { info() {}, warn() {}, error() {} };
const G1 = legacyServerPlaceId('discord', 'g1');
const DM_U1 = 'discord:dm:u1';
const OCT = Date.UTC(2026, 9, 13, 9, 0, 0);
const NOV = Date.UTC(2026, 10, 2, 9, 0, 0);

function counter(prefix: Untyped) {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
}

async function scene() {
  const mem = await openTestMemory();
  const dataDir = mem.dataDir;
  const appendStore = createAppendStore({ fsyncMs: 0, log: quiet });
  const archive = createArchive({
    appendStore,
    dataDir,
    log: quiet,
    now: () => OCT,
    // @ts-expect-error: createArchive takes no `uuid` dependency, so the key is ignored
    uuid: counter('a-'),
    memoryDb: mem.memoryDb,
  });
  const done = async () => {
    await appendStore.close();
    await mem.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { dataDir, appendStore, archive, memoryDb: mem.memoryDb, done };
}

/** The lines the database holds for the archive unit `rel`. */
function unitLines(memoryDb: Untyped, rel: Untyped) {
  const text = unitFile(memoryDb, rel);
  return text
    ? text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

function readLines(file: string) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function collect(iterable: Untyped) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function episode(overrides = {}) {
  return {
    date: '2026-10-12',
    what: 'Έχασε το στοίχημα για τον καφέ',
    quote: 'café ή τσάι',
    feeling: 'λίγη ντροπή',
    weight: 3,
    addedAt: '2026-10-12T22:59:46.874Z',
    itemId: 'ep-1',
    ...overrides,
  };
}

// One event id sequence for the whole file: two entries never share an id.
const eventIds = counter('e-');
const at = (now: number) => ({ now: () => now, uuid: eventIds });

test('archive: archiveEntry builds the three ids and never guesses sourceRefs', () => {
  const entry = archiveEntry(episode(), {
    itemKind: 'episode',
    event: 'evicted',
    scope: { user: '348100000000000001' },
    ...at(OCT),
  });
  assert.equal(loose(entry).v, 1);
  assert.equal(loose(entry).kind, 'archive');
  assert.match(loose(entry).id, /^e-\d+$/, 'the event id');
  assert.equal(loose(entry).itemId, 'ep-1', 'the item keeps its identity');
  assert.match(loose(entry).revisionId, /^rv-[0-9a-f]{12}$/, 'the revision is a hash of the content');
  assert.equal(loose(entry).event, 'evicted');
  assert.equal(loose(entry).itemKind, 'episode');
  assert.deepEqual(
    loose(entry).text,
    { what: 'Έχασε το στοίχημα για τον καφέ', quote: 'café ή τσάι', feeling: 'λίγη ντροπή' },
    'verbatim'
  );
  assert.deepEqual(loose(entry).observedAt, { date: '2026-10-12', precision: 'day' });
  assert.deepEqual(loose(entry).sourceRefs, [], 'unknown sources stay empty');
  assert.deepEqual(loose(entry).scope, { user: '348100000000000001' });
  assert.deepEqual(loose(entry).participants, ['348100000000000001']);
  assert.equal(loose(entry).weight, 3);
  assert.equal(loose(entry).recordedAt, new Date(OCT).toISOString());
  assert.deepEqual([loose(entry).origin, loose(entry).by], ['live', 'store']);

  // The same content gives the same revision; a change of text gives another.
  const same = archiveEntry(episode({ weight: 1 }), {
    itemKind: 'episode',
    event: 'evicted',
    scope: { root: true },
    ...at(NOV),
  });
  assert.equal(loose(same).revisionId, loose(entry).revisionId);
  const changed = archiveEntry(episode({ feeling: 'χαρά' }), {
    itemKind: 'episode',
    event: 'replaced',
    scope: { root: true },
    ...at(OCT),
  });
  assert.notEqual(loose(changed).revisionId, loose(entry).revisionId);

  // A recent line knows its channel but no message: still no reference.
  const line = archiveEntry(
    { id: 4, at: OCT - 1000, placeId: '900000000000000001', text: 'μια γραμμή', weight: 2, itemId: 'rc-1' },
    { itemKind: 'recent', event: 'expired', scope: { channel: '900000000000000001' }, ...at(OCT) }
  );
  assert.deepEqual(loose(line).sourceRefs, []);
  assert.deepEqual(loose(line).observedAt, { date: new Date(OCT - 1000).toISOString(), precision: 'time' });
  // Explicit sources are kept as given; a self fact (a plain string) gets a minted id and an approximate date.
  const given = archiveEntry(episode({ itemId: 'ep-2' }), {
    itemKind: 'episode',
    event: 'evicted',
    scope: { user: 'u1' },
    sourceRefs: [{ placeId: 'c1', messageId: 'm1', revision: 1 }, { messageId: '' }],
    ...at(OCT),
  });
  assert.deepEqual(loose(given).sourceRefs, [{ placeId: 'c1', messageId: 'm1', revision: 1 }]);
  const fact = archiveEntry('μου αρέσει ο café', {
    itemKind: 'selfFact',
    event: 'replaced',
    scope: { root: true },
    ...at(OCT),
  });
  assert.match(loose(fact).itemId, /^sf-/);
  assert.deepEqual(loose(fact).text, { text: 'μου αρέσει ο café' });
  assert.deepEqual(loose(fact).observedAt, { date: '2026-10-13', precision: 'approx' });
  assert.throws(
    () => archiveEntry(episode(), { itemKind: 'episode', event: 'gone', scope: { root: true } }),
    TypeError
  );
});

test('archive: append dedupes by itemId+revisionId and writes to the month of recordedAt', async () => {
  const { dataDir, appendStore, archive, memoryDb, done } = await scene();
  const october = archiveEntry(episode(), { itemKind: 'episode', event: 'evicted', scope: { user: 'u1' }, ...at(OCT) });
  const november = archiveEntry(episode({ itemId: 'ep-2', what: 'Κέρδισε στο σκάκι' }), {
    itemKind: 'episode',
    event: 'evicted',
    scope: { user: 'u1' },
    ...at(NOV),
  });
  assert.deepEqual(await archive.append(G1, [october, november]), { written: 2, duplicates: 0 });
  // The same item and revision again, under another event id: refused.
  const again = archiveEntry(episode(), { itemKind: 'episode', event: 'evicted', scope: { user: 'u1' }, ...at(OCT) });
  assert.deepEqual(await archive.append(G1, [again]), { written: 0, duplicates: 1 });

  assert.deepEqual(
    unitLines(memoryDb, 'guilds/g1/archive/2026-10.jsonl').map((e) => e.itemId),
    ['ep-1']
  );
  assert.deepEqual(
    unitLines(memoryDb, 'guilds/g1/archive/2026-11.jsonl').map((e) => e.itemId),
    ['ep-2']
  );
  assert.equal(fs.existsSync(path.join(dataDir, 'guilds', 'g1', 'archive', '2026-10.jsonl')), false, 'no archive file');

  // A fresh instance reads the database and still refuses it.
  // @ts-expect-error: createArchive takes no `uuid` dependency, so the key is ignored
  const reopened = createArchive({ appendStore, dataDir, log: quiet, now: () => OCT, uuid: counter('b-'), memoryDb });
  assert.deepEqual(await reopened.append(G1, [again]), { written: 0, duplicates: 1 });

  // A private entry lands under the member's private archive, scoped to them.
  const secret = archiveEntry(episode({ itemId: 'ep-3', what: 'Ένα μυστικό' }), {
    itemKind: 'episode',
    event: 'evicted',
    // The store names a private item's scope (src/memory/store.ts#memberScope); the archive keeps it.
    scope: { user: 'u1', private: true },
    ...at(OCT),
  });
  await archive.append(DM_U1, [secret]);
  const privateLines = unitLines(memoryDb, 'guilds/g1/private/u1/archive/2026-10.jsonl');
  assert.deepEqual(
    privateLines.map((e) => [e.itemId, e.scope]),
    [['ep-3', { user: 'u1', private: true }]]
  );

  // The readers: iterate by range and kind, find by item id (the private copy included).
  assert.deepEqual(
    (await collect(archive.iterate(G1, { kinds: ['episode'] }))).map((e) => e.itemId),
    ['ep-1', 'ep-2']
  );
  assert.deepEqual(
    (await collect(archive.iterate(G1, { from: '2026-11-01T00:00:00.000Z' }))).map((e) => e.itemId),
    ['ep-2']
  );
  assert.deepEqual(
    (await archive.find('ep-3')).map((e) => loose(e).scope.private),
    [true]
  );
  assert.deepEqual(await archive.find('ep-9'), []);
  await done();
});

test('archive: queuePending and drainPending round-trip and compact', async () => {
  const { dataDir, appendStore, archive, memoryDb, done } = await scene();
  const entries = [1, 2, 3].map((n) =>
    archiveEntry(episode({ itemId: `ep-${n}`, what: `στιγμή ${n}` }), {
      itemKind: 'episode',
      event: 'evicted',
      scope: { user: 'u1' },
      ...at(OCT),
    })
  );
  await archive.queuePending(G1, entries.slice(0, 2));
  await archive.queuePending(DM_U1, entries.slice(2));
  assert.deepEqual(archive.stats(), { pending: 3 });

  // The first entry already reached the archive before a crash: a duplicate, still confirmed.
  await archive.append(G1, [entries[0]]);
  const drained = await archive.drainPending();
  assert.deepEqual([drained.archived, drained.left], [3, 0]);
  assert.deepEqual(drained.confirmed.map((e) => loose(e).itemId).sort(), ['ep-1', 'ep-2', 'ep-3']);
  assert.deepEqual(archive.stats(), { pending: 0 });
  await appendStore.flush();

  const base = path.join(dataDir, 'guilds', 'g1', 'archive');
  assert.deepEqual(
    unitLines(memoryDb, 'guilds/g1/archive/2026-10.jsonl').map((e) => e.itemId),
    ['ep-1', 'ep-2'],
    'written once each'
  );
  assert.deepEqual(
    unitLines(memoryDb, 'guilds/g1/private/u1/archive/2026-10.jsonl').map((e) => e.itemId),
    ['ep-3']
  );
  assert.deepEqual(readLines(path.join(base, 'pending.jsonl')), [], 'compacted');
  assert.deepEqual(readLines(path.join(base, 'pending-done.jsonl')), [], 'compacted');

  // Nothing queued: nothing to do.
  assert.deepEqual(await archive.drainPending(), { archived: 0, left: 0, confirmed: [] });
  await done();
});

test('archive: a DM memory file under private/ is not a private archive layer', async () => {
  const { dataDir, archive, done } = await scene();
  // The private directory holds the DM memory files (`<accountId>.json`) next to the layers' directories.
  const privateDir = path.join(dataDir, 'guilds', 'g1', 'private');
  fs.mkdirSync(privateDir, { recursive: true });
  fs.writeFileSync(path.join(privateDir, '283916930761621514.json'), '{}');
  const entry = archiveEntry(episode({ itemId: 'ep-p', what: 'ιδιωτική στιγμή' }), {
    itemKind: 'episode',
    event: 'evicted',
    scope: { user: 'u1', private: true },
    ...at(OCT),
  });
  await archive.queuePending(DM_U1, [entry]);

  const drained = await archive.drainPending();
  assert.deepEqual([drained.archived, drained.left], [1, 0], 'the file is skipped, the layer directory is drained');
  await done();
});
