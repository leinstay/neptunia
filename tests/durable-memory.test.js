// The durable memory end to end: one eviction through the real modules -- the append store, the
// record, the archive, the journal and the store -- over a temp data/ directory, with the
// backfill tool's dedupe pass (tools/backfill.mjs over tools/lib/backfill.mjs) at the end. Only
// Discord and the model are absent: their output is written as the record lines and the
// candidates they would have produced. A crash is a process that stops without its last write
// (a throwing fs for one file write, then every append store closed); a restart is a new store
// over the same directory.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore, readLedger } from '../src/memory/store.js';
import { createAppendStore } from '../src/memory/append-store.js';
import { createRecord, toRecordLine } from '../src/memory/record.js';
import { createArchive } from '../src/memory/archive.js';
import { createJournal } from '../src/memory/journal.js';
import { matchMemory } from '../src/behavior/recall.js';
import { main as backfill } from '../tools/backfill.mjs';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { tempDir } from './fixtures/tmp.js';

const GUILD = '600000000000000001';
const ELENI = '411111111111111111';
const NIKOS = '422222222222222222';
const CH = '700000000000000001';
const T = Date.UTC(2026, 9, 10, 9, 0, 0);
// After the real clock: the store stamps its archive entries with Date.now(), and the ledger drops what was archived before the forget.
const FORGET_AT = Date.UTC(2099, 0, 1, 12, 0, 0);
const LATER = Date.UTC(2099, 0, 2, 8, 0, 0);
const EPISODES = { maxEpisodes: 3, maxNew: 5 };
const quietLog = { info() {}, warn() {}, error() {} };

/** A fresh `<root>/data` directory; the backfill tool reads `data/` under its working directory. */
function tmpRoot() {
  const root = tempDir('nep-durable-');
  return { root, dir: path.join(root, 'data') };
}

/**
 * The bot's memory over `dir`: the record, the archive and the journal, each on its own append
 * store, and the store archiving every eviction (`archiveOn` true). `archive` replaces the
 * store's archive (a wrapper over the real one) when given.
 */
function openKit(dir, now, { wrapArchive = (archive) => archive } = {}) {
  const stores = [0, 1, 2].map(() => createAppendStore({ fsyncMs: 0, log: quietLog }));
  const journal = createJournal({ appendStore: stores[0], dataDir: dir, now, log: quietLog });
  const record = createRecord({ appendStore: stores[1], dataDir: dir, now, log: quietLog });
  const archive = createArchive({ appendStore: stores[2], dataDir: dir, now, log: quietLog });
  const store = createStore({ dataDir: dir, record, recordOn: () => false, archive: wrapArchive(archive), archiveOn: () => true });
  // A process exit: every append store closed, so another instance may open the files.
  const close = () => Promise.all(stores.map((appendStore) => appendStore.close()));
  return { journal, record, archive, store, close };
}

/** Every file under `dir`, as forward-slash paths relative to it. */
function filesUnder(dir) {
  const out = [];
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

/** The parsed lines of the JSONL files under `dir` whose relative path matches `re`. */
function linesUnder(dir, re) {
  return filesUnder(dir)
    .filter((rel) => re.test(rel))
    .flatMap((rel) => fs.readFileSync(path.join(dir, rel), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
}

/** The guild's archive entries, as the archive yields them. */
async function archived(archive) {
  const out = [];
  for await (const entry of archive.iterate(GUILD)) out.push(entry);
  return out;
}

/** Whether an archive entry or a candidate concerns `userId` in any way a forget looks at. */
function concerns(value, userId) {
  return (
    value?.scope?.user === userId ||
    value?.userId === userId ||
    (Array.isArray(value?.participants) && value.participants.includes(userId)) ||
    (Array.isArray(value?.sourceRefs) && value.sourceRefs.some((ref) => ref?.messageId === 'm1'))
  );
}

/** A backfill candidate as tools/lib/backfill.mjs#parseExtractAnswer writes it. */
function candidate(userId, what, messageId, participants) {
  return {
    kind: 'episode', windowId: 'w1', channelId: CH, date: '2026-10-10', observedAt: '2026-10-10',
    userId, what, quote: '', weight: 3, brief: '', sourceRefs: [{ channelId: CH, messageId }], participants,
  };
}

const LIGHTHOUSE = 'sang an old lighthouse song by the harbour';

/**
 * Seed the member at the cap: two heavy moments and a light one (the victim), the record lines
 * the light one came from, a journal record naming them; then the member who stays.
 */
async function seedAtCap(kit) {
  const { store, record, journal } = kit;
  store.touchUser(GUILD, ELENI, 'Ελένη', T);
  store.touchUser(GUILD, NIKOS, 'Νίκος', T);
  const added = store.addEpisodes(
    GUILD,
    ELENI,
    [
      { date: '2026-10-01', what: LIGHTHOUSE, weight: 1 },
      { date: '2026-10-02', what: 'brought café crème for everyone', weight: 4 },
      { date: '2026-10-03', what: 'won the chess night twice', weight: 4 },
    ],
    { ...EPISODES, now: T },
  );
  assert.equal(added, 3);
  store.flush();
  await record.append(GUILD, [
    toRecordLine({ id: 'm1', channelId: CH, authorId: ELENI, content: 'the lighthouse song again', ts: T }),
    toRecordLine({ id: 'm2', channelId: CH, authorId: NIKOS, content: 'καλημέρα', ts: T }),
  ]);
  await journal.memory(GUILD, { participants: [ELENI, NIKOS], occurredAt: new Date(T).toISOString() });
  await journal.memory(GUILD, { participants: [NIKOS], occurredAt: new Date(T).toISOString() });
  return store.getUser(GUILD, ELENI).episodes.find((episode) => episode.what === LIGHTHOUSE).itemId;
}

/** Evict the light moment: one heavier moment arrives, the archive confirms the victim, the hot list is trimmed and written. */
async function evictOne(kit) {
  kit.store.addEpisodes(GUILD, ELENI, [{ date: '2026-10-04', what: 'taught the channel a Greek tongue twister', weight: 3 }], { ...EPISODES, now: T + 1000 });
  await kit.store.settleArchive(GUILD);
  kit.store.flush();
}

test('durable memory: an evicted moment survives a crash, is recalled from the archive, and a forget keeps it gone through a backfill', async () => {
  const { root, dir } = tmpRoot();
  const guild = path.join(dir, 'guilds', GUILD);
  const userPath = path.join(guild, 'users', `${ELENI}.json`);
  let kit = openKit(dir, () => T);
  const victimId = await seedAtCap(kit);
  const readDisk = () => JSON.parse(fs.readFileSync(userPath, 'utf8')).episodes.map((episode) => episode.itemId);

  // A new moment arrives at the cap: the light one is the merge's victim, still hot until the archive has it.
  const before = kit.store.archiveMark(GUILD);
  assert.equal(kit.store.addEpisodes(GUILD, ELENI, [{ date: '2026-10-04', what: 'taught the channel a Greek tongue twister', weight: 3 }], { ...EPISODES, now: T + 1000 }), 1);
  assert.equal(kit.store.getUser(GUILD, ELENI).episodes.length, 4, 'over the cap while the copy is on its way');
  assert.ok(kit.store.getUser(GUILD, ELENI).episodes.some((episode) => episode.itemId === victimId));
  // A flush now (a timer) writes the victim with the list: nothing leaves the disk without a copy.
  kit.store.flush();
  assert.ok(readDisk().includes(victimId));
  assert.equal(readDisk().length, 4);

  const settled = await kit.store.settleArchive(GUILD, { from: before });
  assert.deepEqual(settled.archived.map((item) => [item.itemId, item.itemKind, item.event]), [[victimId, 'episode', 'evicted']]);
  assert.equal(settled.deferred, 0);
  const copies = await kit.archive.find(GUILD, victimId);
  assert.equal(copies.length, 1);
  assert.deepEqual([copies[0].text.what, copies[0].scope.user], [LIGHTHOUSE, ELENI]);
  assert.equal(kit.store.getUser(GUILD, ELENI).episodes.length, 3, 'trimmed in the cache once the archive confirmed it');
  assert.ok(!kit.store.getUser(GUILD, ELENI).episodes.some((episode) => episode.itemId === victimId));

  // The crash: the write of the trimmed list fails once, then the process is gone.
  const writeFileSync = fs.writeFileSync;
  let failures = 0;
  const failing = mock.method(fs, 'writeFileSync', function write(file, ...rest) {
    if (failures === 0 && String(file).startsWith(userPath)) {
      failures += 1;
      throw Object.assign(new Error('the disk went away'), { code: 'EIO' });
    }
    return writeFileSync.call(fs, file, ...rest);
  });
  let flushed;
  let logs;
  try {
    ({ result: flushed, logs } = await withCapturedLogs(() => kit.store.flush()));
  } finally {
    failing.mock.restore();
  }
  assert.equal(failures, 1);
  assert.equal(flushed.failed, 1);
  assert.ok(logs.some((entry) => entry.msg === 'store: flush failed'));
  await kit.close();

  // The restart: a new store over the same directory holds both moments, the archive one copy.
  // Its first archive append is refused, so the next eviction waits in the pending queue.
  let refuse = 1;
  kit = openKit(dir, () => LATER, {
    wrapArchive: (archive) => ({
      ...archive,
      async append(...args) {
        if (refuse > 0) {
          refuse -= 1;
          throw Object.assign(new Error('archive busy'), { code: 'EBUSY' });
        }
        return archive.append(...args);
      },
    }),
  });
  const restarted = kit.store.getUser(GUILD, ELENI).episodes;
  assert.equal(restarted.length, 4);
  assert.ok(restarted.some((episode) => episode.itemId === victimId));
  assert.ok(restarted.some((episode) => episode.what === 'taught the channel a Greek tongue twister'));
  assert.equal((await kit.archive.find(GUILD, victimId)).length, 1);
  // Nothing waits yet: the drain has nothing to trim; the list stays over the cap, nothing lost.
  assert.deepEqual(await kit.store.drainArchive(GUILD), { archived: 0, left: 0 });
  assert.equal(kit.store.getUser(GUILD, ELENI).episodes.length, 4);

  // The next moment evicts again; the refused append sends the victims to the pending queue and they stay hot.
  kit.store.addEpisodes(GUILD, ELENI, [{ date: '2026-10-05', what: 'drew the whole server as cats', weight: 4 }], { ...EPISODES, now: LATER });
  const deferred = await kit.store.settleArchive(GUILD);
  assert.deepEqual([deferred.archived.length, deferred.deferred], [0, 2]);
  assert.equal(kit.store.getUser(GUILD, ELENI).episodes.length, 5, 'every victim stays hot while it waits');
  kit.store.flush();
  assert.equal(readDisk().length, 5);
  // The drain archives them (the victim's copy is refused by the index) and trims the list.
  const drained = await kit.store.drainArchive(GUILD);
  assert.deepEqual(drained, { archived: 2, left: 0 });
  kit.store.flush();
  assert.equal(readDisk().length, 3);
  assert.ok(!readDisk().includes(victimId));
  assert.equal((await kit.archive.find(GUILD, victimId)).length, 1, 'exactly one copy after the second eviction');

  // Recall reaches the archived moment.
  const entries = await archived(kit.archive);
  const hits = matchMemory({ forms: ['lighthouse'], profiles: kit.store.listUserProfiles(GUILD), archived: entries, max: 5 });
  assert.deepEqual(hits.map((hit) => [hit.kind, hit.itemId, hit.memberId]), [['archived episode', victimId, ELENI]]);

  // A first backfill extract has left a candidate about the member.
  const candidatesFile = path.join(guild, 'backfill', 'candidates.jsonl');
  fs.mkdirSync(path.dirname(candidatesFile), { recursive: true });
  fs.writeFileSync(candidatesFile, `${JSON.stringify(candidate(ELENI, LIGHTHOUSE, 'm1', [ELENI]))}\n`);

  // The forget: archive, record, journal and candidates, a vault before, a ledger after.
  const { vault, counts } = await kit.store.forgetUser(GUILD, ELENI, { journal: kit.journal, vaultDir: 'vault', now: () => FORGET_AT });
  assert.equal(vault, path.join(dir, 'vault', `forget-${ELENI}-2099-01-01T12-00-00-000Z`));
  assert.deepEqual([counts.profile, counts.record, counts.journal, counts.backfill], [1, 1, 1, 1]);
  assert.ok(counts.archive >= 2, 'the victim and the other evicted moments of the member');
  assert.deepEqual(await kit.archive.find(GUILD, victimId), []);
  assert.deepEqual(linesUnder(path.join(guild, 'archive'), /\.jsonl$/).filter((entry) => concerns(entry, ELENI)), []);
  assert.deepEqual(linesUnder(path.join(guild, 'record'), /\.jsonl$/).map((line) => line.messageId), ['m2']);
  assert.deepEqual(linesUnder(path.join(guild, 'journal'), /^[^/]*\.jsonl$/).map((rec) => rec.participants), [[NIKOS]]);
  assert.deepEqual(filesUnder(path.join(guild, 'backfill')), ['candidates.jsonl']);
  assert.equal(fs.readFileSync(candidatesFile, 'utf8'), '');
  assert.ok(fs.existsSync(path.join(vault, 'guilds', GUILD, 'users', `${ELENI}.json`)));
  const vaulted = filesUnder(vault);
  const droppedArchive = vaulted.filter((rel) => /archive\/.*\.dropped\.jsonl$/.test(rel));
  assert.ok(droppedArchive.length > 0);
  assert.ok(linesUnder(vault, /archive\/.*\.dropped\.jsonl$/).some((entry) => entry.itemId === victimId && entry.text.what === LIGHTHOUSE));
  assert.deepEqual(linesUnder(vault, /record\/.*\.dropped\.jsonl$/).map((line) => line.messageId), ['m1']);
  assert.deepEqual(linesUnder(vault, /backfill\/candidates\.jsonl\.dropped\.jsonl$/).map((value) => value.userId), [ELENI]);
  assert.deepEqual(readLedger(dir, GUILD), [{ userId: ELENI, at: new Date(FORGET_AT).toISOString() }]);
  assert.equal(kit.store.getUser(GUILD, ELENI), null);
  await kit.close();

  // Later the owner puts an older copy of the archive segment back by hand, and a new extract
  // over the same messages names the member again; the bot is stopped.
  for (const rel of droppedArchive) {
    const target = path.join(dir, rel.replace(/\.dropped\.jsonl$/, ''));
    fs.appendFileSync(target, fs.readFileSync(path.join(vault, rel)));
  }
  fs.writeFileSync(
    candidatesFile,
    [
      candidate(ELENI, LIGHTHOUSE, 'm1', [ELENI]),
      { ...candidate(NIKOS, 'said good morning in Greek', 'm1', [NIKOS, ELENI]) },
      candidate(NIKOS, 'said good morning in Greek to the whole channel', 'm2', [NIKOS]),
    ]
      .map((value) => `${JSON.stringify(value)}\n`)
      .join(''),
  );

  // The dedupe pass: the ledger first (applied, since data/ holds the restored lines), then the candidates.
  const report = await backfill(['dedupe', '--guild', GUILD], { cwd: root, hot: { config: { bot: {} }, prompts: {}, close() {} }, now: () => LATER + 60_000, log: quietLog });
  assert.match(report, /archived: 1/);
  const reopened = openKit(dir, () => LATER + 120_000);
  const after = await archived(reopened.archive);
  assert.deepEqual(after.filter((entry) => concerns(entry, ELENI)), [], 'nothing of the member came back');
  assert.deepEqual(await reopened.archive.find(GUILD, victimId), []);
  assert.deepEqual(after.filter((entry) => entry.origin === 'backfill').map((entry) => [entry.scope.user, entry.text.what]), [[NIKOS, 'said good morning in Greek to the whole channel']]);
  assert.equal(reopened.store.getUser(GUILD, ELENI), null);
  assert.deepEqual(matchMemory({ forms: ['lighthouse'], profiles: reopened.store.listUserProfiles(GUILD), archived: after, max: 5 }), []);
  await reopened.close();
});

test('durable memory: a forget cut short after the archive step is finished by resumeForgets on the next start', async () => {
  const { dir } = tmpRoot();
  const guild = path.join(dir, 'guilds', GUILD);
  let kit = openKit(dir, () => T);
  const victimId = await seedAtCap(kit);
  await evictOne(kit);
  assert.equal((await kit.archive.find(GUILD, victimId)).length, 1);

  const killed = { forgetUser: async () => { throw new Error('killed'); } };
  const failed = await kit.store.forgetUser(GUILD, ELENI, { journal: kit.journal, record: killed, vaultDir: 'vault', now: () => FORGET_AT }).catch((error) => error);
  assert.match(failed.message, /killed/);
  const marker = path.join(guild, 'forgetting', `${ELENI}.json`);
  assert.ok(fs.existsSync(marker));
  assert.deepEqual(await kit.archive.find(GUILD, victimId), [], 'the archive step ran');
  assert.deepEqual(linesUnder(path.join(guild, 'record'), /\.jsonl$/).map((line) => line.messageId), ['m1', 'm2'], 'the record step did not');
  assert.deepEqual(readLedger(dir, GUILD), []);
  await kit.close();

  kit = openKit(dir, () => FORGET_AT + 60_000);
  assert.equal(kit.store.getUser(GUILD, ELENI), null, 'hidden while the marker exists');
  assert.deepEqual(await kit.store.resumeForgets(GUILD, { journal: kit.journal, now: () => FORGET_AT + 60_000 }), { finished: 1 });
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(linesUnder(path.join(guild, 'record'), /\.jsonl$/).map((line) => line.messageId), ['m2']);
  assert.deepEqual(linesUnder(path.join(guild, 'journal'), /^[^/]*\.jsonl$/).map((rec) => rec.participants), [[NIKOS]]);
  assert.deepEqual(linesUnder(path.join(guild, 'archive'), /\.jsonl$/).filter((entry) => concerns(entry, ELENI)), []);
  assert.deepEqual(readLedger(dir, GUILD).map((entry) => entry.userId), [ELENI]);
  const vault = path.join(dir, 'vault', `forget-${ELENI}-2099-01-01T12-00-00-000Z`);
  assert.ok(linesUnder(vault, /archive\/.*\.dropped\.jsonl$/).some((entry) => entry.itemId === victimId), 'the first run filled the vault');
  assert.deepEqual(linesUnder(vault, /record\/.*\.dropped\.jsonl$/).map((line) => line.messageId), ['m1']);
  assert.ok(kit.store.getUser(GUILD, NIKOS), 'the member who stays is untouched');
  await kit.close();
});

test('durable memory: applyLedger takes the member out again of a restored older snapshot copy', async () => {
  const { dir } = tmpRoot();
  let kit = openKit(dir, () => T);
  const victimId = await seedAtCap(kit);
  await evictOne(kit);
  await kit.close();
  // A snapshot from before the forget, as /nep memory snapshot lays it out.
  const snapshotGuild = path.join(dir, 'snapshots', '2026-10-12T00-00-00-000Z', 'guilds', GUILD);
  fs.cpSync(path.join(dir, 'guilds', GUILD), snapshotGuild, { recursive: true });

  kit = openKit(dir, () => FORGET_AT);
  await kit.store.forgetUser(GUILD, ELENI, { journal: kit.journal, now: () => FORGET_AT });
  await kit.close();
  // The forget took the member's files out of the snapshot and wrote its ledger; the snapshot's
  // append-only files still hold their lines.
  assert.equal(fs.existsSync(path.join(snapshotGuild, 'users', `${ELENI}.json`)), false);
  assert.deepEqual(readLedger(path.join(dir, 'snapshots', '2026-10-12T00-00-00-000Z'), GUILD).map((entry) => entry.userId), [ELENI]);

  // The owner restores that snapshot into a data/ of its own and starts on it.
  const { dir: restored } = tmpRoot();
  fs.cpSync(snapshotGuild, path.join(restored, 'guilds', GUILD), { recursive: true });
  const copy = openKit(restored, () => LATER);
  assert.equal((await copy.archive.find(GUILD, victimId)).length, 1, 'the restored copy brought the moment back');
  assert.ok(linesUnder(path.join(restored, 'guilds', GUILD, 'record'), /\.jsonl$/).some((line) => line.messageId === 'm1'));

  const counts = await copy.store.applyLedger(GUILD, { journal: copy.journal });
  assert.deepEqual([counts.users, counts.archive, counts.record, counts.journal], [1, 1, 1, 1]);
  assert.deepEqual(await copy.archive.find(GUILD, victimId), []);
  assert.deepEqual((await archived(copy.archive)).filter((entry) => concerns(entry, ELENI)), []);
  assert.deepEqual(linesUnder(path.join(restored, 'guilds', GUILD, 'record'), /\.jsonl$/).map((line) => line.messageId), ['m2']);
  assert.equal(copy.store.getUser(GUILD, ELENI), null);
  assert.ok(copy.store.getUser(GUILD, NIKOS));
  await copy.close();
});
