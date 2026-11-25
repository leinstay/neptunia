import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test, type TestContext } from 'node:test';
import { createAdmin } from '../../../../src/admin.ts';
import { accountOf, placeOfRoot } from '../../../../src/memory/addresses.ts';
import { createAppendStore } from '../../../../src/memory/append-store.ts';
import { archiveEntry, createArchive } from '../../../../src/memory/archive.ts';
import { PERSONA_ID } from '../../../../src/memory/db/ids.ts';
import type { JournalLinesWrite } from '../../../../src/memory/db/journal-lines.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { createMemoryDb, type MemoryDbService } from '../../../../src/memory/db/service.ts';
import { type Db, dbOf } from '../../../../src/memory/db/types.ts';
import { accountCollection } from '../../../../src/memory/db/unit-keys.ts';
import { createJournal } from '../../../../src/memory/journal.ts';
import { createRecord } from '../../../../src/memory/record.ts';
import { createStore } from '../../../../src/memory/store.ts';
import { MEMORY_LIMITS } from '../../../../src/memory/text-limits.ts';
import { createVectors } from '../../../../src/memory/vectors.ts';
import { executeCall, resolveCall } from '../../../../src/tools/executors.ts';
import { createOpsEnv } from '../../../../src/tools/operations/env.ts';
import { runOp } from '../../../../src/tools/operations/index.ts';
import { skillRegistry } from '../../../../src/tools/registry.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import { makeAdmin, makeHot, makeRoot } from '../../../fixtures/admin-rig.ts';
import { makeStore } from '../../../fixtures/admin-store.ts';
import { present, wrongly } from '../../../fixtures/loose-types.ts';
import {
  addAccount,
  addDmPlace,
  addGroupPlace,
  ANNA,
  BORIS,
  seedOpaqueWorld,
} from '../../../fixtures/memory-db/opaque-people.ts';
import { journalLineLabel, openTestMemory, openTestMemorySync } from '../../../fixtures/memory-db/service.ts';
import { writeUnitUpdate } from '../../../fixtures/memory-db/unit-writes.ts';
import { ownedBy, OWNER_PERSON } from '../../../fixtures/owner-accounts.ts';
import { tempDir } from '../../../fixtures/tmp.ts';

test('memory.profile.read affinity: a member with no profile is refused and none is created', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);

  await assert.rejects(
    () => admin.run('memory.profile.read', { accountId: '555', section: 'affinity', score: 10 }, { placeId: 'g1' }),
    /^Error: no profile for 555$/
  );
  assert.equal(store.getUser(accountOf(store, '555')), null);
});

test('run: memory.profile.read section affinity is refused when the context names no place, whatever is served', async () => {
  // The fallback to the single served guild pinned the home place the owner removed: the console names the one place.
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('123', { id: '123', affinity: { score: 5, reason: 'ok so far', history: [] } });

  await assert.rejects(
    () => admin.run('memory.profile.read', { accountId: '123', section: 'affinity' }, {}),
    /no place resolved yet/
  );
  assert.ok(
    (await admin.run('memory.profile.read', { accountId: '123', section: 'affinity' }, { placeId: 'g1' })).includes(
      'score: 5'
    )
  );
});

// ---------------------------------------------------------------------------
// private.show and the private-aware memory commands
// ---------------------------------------------------------------------------

function samplePrivate(overrides = {}) {
  return {
    relationship: 'trusts the persona with plans',
    interests: [
      {
        topic: 'astronomy',
        note: 'owns a telescope',
        weight: 3,
        firstSeen: '2026-09-01T00:00:00.000Z',
        lastSeen: '2026-09-20T00:00:00.000Z',
      },
    ],
    details: [
      {
        id: 1,
        text: 'studies at night',
        weight: 2,
        firstSeen: '2026-09-01T00:00:00.000Z',
        lastSeen: '2026-09-10T00:00:00.000Z',
      },
    ],
    detailsSeq: 2,
    episodes: [
      {
        date: '2026-09-15',
        what: 'shared a café story',
        quote: 'crème brûlée',
        weight: 2,
        addedAt: '2026-09-15T00:00:00.000Z',
      },
    ],
    affinity: { score: 12, reason: 'kind in private', history: [] },
    firstSeen: '2026-09-01T00:00:00.000Z',
    lastSeen: '2026-09-20T00:00:00.000Z',
    buffer: [
      { id: 'm1', content: 'SECRET-BUFFERED-TEXT', ts: 1 },
      { id: 'm2', content: 'another buffered line', ts: 2 },
    ],
    ...overrides,
  };
}

// PR 7d: the per-person reply caps are gone with their count, so the view carries no replies line.
test('run: private.show renders the private layer under the public name, with both scores', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('123', {
    id: '123',
    names: ['Zoé', 'old name'],
    affinity: { score: 50, reason: 'public reason', history: [] },
  });
  store.privates.set('123', samplePrivate());

  const result = await admin.run('memory.private.read', { action: 'show', accountId: '123' }, { placeId: 'g1' });

  assert.match(result.split('\n')[0], /Zoé/);
  assert.match(result, /trusts the persona with plans/);
  assert.match(result, /astronomy/);
  assert.match(result, /owns a telescope/);
  assert.match(result, /studies at night/);
  assert.match(result, /shared a café story/);
  assert.match(result, /private affinity: 12\b/);
  assert.match(result, /kind in private/);
  assert.match(result, /effective affinity: 62\b/);
  assert.ok(!result.includes('SECRET-BUFFERED-TEXT'), 'the buffer contents are never shown');
  assert.ok(!result.includes('another buffered line'), 'the buffer contents are never shown');
  assert.ok(!result.includes('public reason'), 'the public affinity reason is not part of the private view');
});

test('run: private.show clamps the effective score for an owner', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('42', { id: '42', names: ['Owner'], affinity: { score: 90, reason: '', history: [] } });
  store.privates.set('42', samplePrivate({ affinity: { score: 30, reason: '', history: [] } }));

  const result = await admin.run('memory.private.read', { action: 'show', accountId: '42' }, { placeId: 'g1' });

  assert.match(result, /effective affinity: 100\b/);
});

test('run: private.show needs a user', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  await assert.rejects(
    () => admin.run('memory.private.read', { action: 'show' }, { placeId: 'g1' }),
    /a user is required/
  );
  // The half that wanted a resolved guild is gone with the guild: a private layer is read by person.
});

test('run: memory.show never shows the private layer', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('123', {
    id: '123',
    names: ['Zoé'],
    relationship: 'public text',
    affinity: { score: 50, reason: '', history: [] },
  });
  store.privates.set('123', samplePrivate());

  const summary = await admin.run('memory.profile.read', { accountId: '123' }, { placeId: 'g1' });
  const raw = await admin.run('memory.profile.read', { accountId: '123', section: 'raw' }, { placeId: 'g1' });
  for (const text of [summary, raw]) {
    assert.ok(!text.includes('trusts the persona with plans'));
    assert.ok(!text.includes('astronomy'));
  }
});

// The following memory.show tests exercise `section: 'raw'` (see
// src/admin.js#rawMemoryShowView). The other sections are covered further
// below.

test('run: memory.show section:raw also prints the stored episodes (date, weight, what, quote)', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('123', {
    id: '123',
    episodes: [
      { date: '2026-01-01', what: 'promised to help', quote: 'I got you', feeling: 'touched', weight: 4, addedAt: 'x' },
    ],
  });

  const result = await admin.run('memory.profile.read', { accountId: '123', section: 'raw' }, { placeId: 'g1' });

  assert.ok(result.includes('episodes:'));
  assert.ok(result.includes('2026-01-01'));
  assert.ok(result.includes('weight 4'));
  assert.ok(result.includes('promised to help'));
  assert.ok(result.includes('I got you'));
});

// PR 7d: `memory.maxInterests` is the constant MEMORY_LIMITS.maxInterests, so that many fresh interests fill the shown part.
test('run: memory.show section:raw lists every stored interest in rank order and marks the divider between shown and hidden', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  const fresh = Array.from({ length: MEMORY_LIMITS.maxInterests }, (_, n) => ({
    topic: `Fresh interest ${n}`,
    note: '',
    weight: 1,
    firstSeen: 'a',
    lastSeen: '2026-09-20T00:00:00.000Z',
  }));
  store.profiles.set('123', {
    id: '123',
    interests: [
      { topic: 'Ancient favorite', note: '', weight: 10, firstSeen: 'a', lastSeen: '2021-01-01T00:00:00.000Z' },
      ...fresh,
    ],
  });

  const result = await admin.run('memory.profile.read', { accountId: '123', section: 'raw' }, { placeId: 'g1' });
  assert.ok(result.includes('Fresh interest'), 'both stored interests are listed');
  assert.ok(result.includes('Ancient favorite'));
  const lines = result.split('\n');
  const freshLine = lines.findIndex((l: string) => /^Fresh interest \d+ \[weight/.test(l.trim()));
  const dividerLine = lines.findIndex((l: string) => l.includes('not shown'));
  const ancientLine = lines.findIndex((l: string) => l.trim().startsWith('Ancient favorite [weight'));
  assert.ok(
    freshLine >= 0 && dividerLine > freshLine && ancientLine > dividerLine,
    'the freshest ranks first, above the divider; the ancient heavy one sits below it'
  );
});

// ---------------------------------------------------------------------------
// memory.show -- sectioned view: summary (default), character/style/
// relationship, affinity, aliases/interests/details/episodes with order/limit
// ---------------------------------------------------------------------------

test('run: memory.show order:recent sorts a list section newest lastSeen first, no divider', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('123', {
    id: '123',
    interests: [
      { topic: 'Old', note: '', weight: 5, firstSeen: 'a', lastSeen: '2020-01-01T00:00:00.000Z' },
      { topic: 'New', note: '', weight: 1, firstSeen: 'a', lastSeen: '2026-09-01T00:00:00.000Z' },
    ],
  });

  const result = await admin.run(
    'memory.profile.read',
    { accountId: '123', section: 'interests', order: 'recent' },
    { placeId: 'g1' }
  );
  const lines = result.split('\n');
  assert.ok(lines[0].startsWith('New'), 'the newer lastSeen sorts first under order:recent');
  assert.ok(lines[1].startsWith('Old'));
  assert.ok(!result.includes('not shown'), 'order:recent never shows the shown/stored divider');
});

test('run: memory.show respects a custom limit, capping a list section', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('123', {
    id: '123',
    interests: Array.from({ length: 5 }, (_, i) => ({
      topic: `T${i}`,
      note: '',
      weight: 1,
      firstSeen: 'a',
      lastSeen: 'a',
    })),
  });

  const result = await admin.run(
    'memory.profile.read',
    { accountId: '123', section: 'interests', limit: 2 },
    { placeId: 'g1' }
  );
  assert.equal(result.split('\n').length, 2);
});

// ---------------------------------------------------------------------------
// memory.recent
// ---------------------------------------------------------------------------

const RECENT_NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

const HOUR = 3600 * 1000;

function recentLine(id: number, hoursAgo: number, text: string, extra: Record<string, unknown> = {}) {
  return { id, at: RECENT_NOW - hoursAgo * HOUR, addedAt: null, placeId: 'c1', text, who: [], weight: 2, ...extra };
}

function makeRecentAdmin(t: TestContext, lines: Array<Untyped>, config: Record<string, unknown> = {}) {
  t.mock.method(Date, 'now', () => RECENT_NOW);
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  Object.assign(hot.config, config);
  const store = makeStore();
  store.recent.set('g1', { nextId: 100, lines });
  return { ...makeAdmin(rootDir, { hot, store }), store, hot };
}

test('run: memory.recent lists the live lines newest first and leaves out the expired ones', async (t) => {
  const { admin } = makeRecentAdmin(t, [
    recentLine(1, 10, 'older line'),
    recentLine(2, 1, 'newest line'),
    recentLine(3, 100, 'expired line'),
    recentLine(4, 5, 'middle line'),
  ]);

  const rows = (await admin.run('memory.recent.read', {}, { placeId: 'g1' })).split('\n');

  assert.equal(rows.length, 4, 'the header and three live lines');
  assert.match(rows[0], /3/);
  assert.ok(rows[1].includes('newest line'));
  assert.ok(rows[2].includes('middle line'));
  assert.ok(rows[3].includes('older line'));
  assert.ok(!rows.join('\n').includes('expired line'));
});

test('run: memory.recent resolves <@id> tokens, names the channel from its note and shows the weight', async (t) => {
  const otherId = '999999999999999999';
  const { admin, store } = makeRecentAdmin(t, [recentLine(1, 1, `joked with <@${otherId}>`, { weight: 3 })]);
  store.profiles.set(`${otherId}`, { id: otherId, names: ['Zoe'] });
  store.channels.set('g1:c1', { id: 'c1', name: 'general' });

  const text = await admin.run('memory.recent.read', {}, { placeId: 'g1' });

  assert.ok(text.includes(`joked with Zoe (id:${otherId})`));
  assert.ok(!text.includes('<@'));
  assert.ok(text.includes('#general'));
  assert.ok(text.includes('w3'));
});

test('run: memory.recent shows the time in the configured time zone', async (t) => {
  const { admin, hot } = makeRecentAdmin(t, [
    { ...recentLine(1, 0, 'late line'), at: Date.UTC(2026, 9, 5, 22, 30, 0) },
  ]);
  hot.config.bot.timezone = 'Europe/Athens';

  const text = await admin.run('memory.recent.read', {}, { placeId: 'g1' });

  assert.ok(text.includes('2026-10-06 01:30'), text);
});

test('run: memory.recent answers one short line with no live line', async (t) => {
  const none = makeRecentAdmin(t, [recentLine(1, 100, 'expired line')]);
  const noneText = await none.admin.run('memory.recent.read', {}, { placeId: 'g1' });
  assert.ok(!noneText.includes('\n'));
  assert.ok(!noneText.includes('expired line'));
});

// The grants are cut to a role, and with them this test's check of one.
test('run: memory.recent works while paused and writes nothing', async (t) => {
  const { admin, store } = makeRecentAdmin(t, [recentLine(1, 1, 'a line')]);
  const storeData = store.state.data;
  storeData.paused = true;

  const text = await admin.run('memory.recent.read', {}, { placeId: 'g1' });

  assert.ok(text.includes('a line'));
  assert.equal(store.flushCalls, 0);
});

// ---------------------------------------------------------------------------
// memory.archive / memory.restore
// ---------------------------------------------------------------------------

// The real store hands its records back as plain objects; these read their fields through Untyped.
const userOf = (store: { getUser: (accountId: string) => object | null }, accountId: string): Untyped =>
  store.getUser(accountOf(store, accountId));

test('admin: memory restore re-inserts an episode and writes a restored event, idempotent', async () => {
  const rootDir = makeRoot();
  const mem = await openTestMemory();
  const dataDir = mem.dataDir;
  const log = { info() {}, warn() {}, error() {} };
  const appendStore = createAppendStore({ fsyncMs: 0, log });
  const archive = createArchive({
    appendStore,
    dataDir,
    log,
    memoryDb: mem.memoryDb,
  });
  const store = createStore({ dataDir, archive, memoryDb: mem.memoryDb });
  const { admin } = makeAdmin(rootDir, { store, archive });
  try {
    const now = Date.UTC(2026, 9, 12);
    store.touchUser(accountOf(store, 'u1'), 'Zoé', now);
    // The engine has no episode writer, so the evicted episode is filed in the archive the way the store files one:
    // a member's public item under the persona, scoped to the member.
    const old = {
      itemId: 'ep-old-chess',
      date: '2026-10-01',
      what: 'Έχασε στο σκάκι',
      quote: 'ξανά',
      weight: 1,
      addedAt: '2026-10-01T10:00:00.000Z',
    };
    await archive.append(null, [
      archiveEntry(old, {
        itemKind: 'episode',
        event: 'evicted',
        scope: { user: accountOf(store, 'u1') },
        now: () => now,
      }),
    ]);

    const listed = await admin.run('memory.archive.read', { accountId: 'u1' }, { placeId: 'g1' });
    assert.match(listed, new RegExp(`evicted\\s+episode\\s+${old.itemId}`));
    assert.match(listed, /Έχασε στο σκάκι/);
    assert.equal(
      await admin.run('memory.archive.read', { kind: 'episode' }, { placeId: 'g1' }),
      '(none)',
      'nothing at the server level'
    );

    const reply = await admin.run('memory.restore', { itemId: old.itemId }, { placeId: 'g1' });
    assert.match(reply, /restored/);
    const episodes = userOf(store, 'u1').episodes;
    const back = episodes.find((ep: Untyped) => ep.itemId === old.itemId);
    assert.ok(back, 'the episode is hot again under its own id');
    assert.deepEqual(
      [back.date, back.what, back.quote, back.weight, back.addedAt],
      [old.date, old.what, old.quote, old.weight, old.addedAt]
    );
    assert.equal(episodes.length, 1, 'the restore adds the one archived episode');
    let lines = await archive.find(old.itemId);
    assert.deepEqual(
      lines.map((entry: Untyped) => [entry.event, entry.by]),
      [
        ['evicted', 'store'],
        ['restored', 'owner'],
      ]
    );

    // Again: the item is hot already, nothing is written.
    const again = await admin.run('memory.restore', { itemId: old.itemId }, { placeId: 'g1' });
    assert.match(again, /already/);
    assert.equal(userOf(store, 'u1').episodes.length, 1);
    lines = await archive.find(old.itemId);
    assert.equal(lines.length, 2);

    await assert.rejects(admin.run('memory.restore', { itemId: 'ep-none' }, { placeId: 'g1' }), /no archived item/);
  } finally {
    await appendStore.close();
    await mem.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// the journal: system records, /nep journal
// ---------------------------------------------------------------------------

/** A journal fake: records every write and call; `read` serves `days[day]` filtered like the real one. */
function fakeJournal(days: Record<string, Array<Untyped>> = {}) {
  const calls: Array<Untyped> = [];
  return {
    calls,
    system: async (record: Untyped) => {
      calls.push(['system', record]);
    },
    read: async (placeId: string, { day, kind = null, n = 50 }: { day: string; kind?: string | null; n?: number }) => {
      calls.push(['read', placeId, { day, kind, n }]);
      return (days[day] ?? []).filter((record: Untyped) => !kind || record.kind === kind).slice(-n);
    },
    forgetUser: async (placeId: string, accountId: string) => {
      calls.push(['forgetUser', placeId, accountId]);
      return { files: 2, dropped: 5 };
    },
    removeGuild: async (placeId: string) => {
      calls.push(['removeGuild', placeId]);
      return { files: 3 };
    },
  };
}

test('admin: journal lists the last n records of a day as short lines', async () => {
  const rootDir = makeRoot();
  const day = '2026-10-12';
  const journal = fakeJournal({
    [day]: [
      { kind: 'turn.start', occurredAt: `${day}T10:00:00.000Z`, mode: 'reply', trigger: { kind: 'mention' } },
      { kind: 'action', occurredAt: `${day}T10:00:05.000Z`, name: 'post', phase: 'started' },
      { kind: 'action', occurredAt: `${day}T10:00:06.000Z`, name: 'post', phase: 'succeeded' },
      {
        kind: 'turn',
        occurredAt: `${day}T10:00:07.000Z`,
        mode: 'reply',
        outcome: 'spoke',
        seen: { messageIds: ['m1', 'm2'] },
        think: 'Η Ελένη ρωτά.',
      },
      {
        kind: 'memory',
        occurredAt: `${day}T10:05:00.000Z`,
        batch: { messageIds: ['m1'], consumed: 6 },
        changed: { users: ['u1'] },
        episodes: [],
      },
      { kind: 'system', occurredAt: `${day}T11:00:00.000Z`, event: 'pause', by: 'owner' },
    ],
  });
  const { admin } = makeAdmin(rootDir, { journal });

  const all = await admin.run('memory.journal.read', { day, n: 3 }, { placeId: 'g1' });
  const lines = all.split('\n');
  assert.deepEqual(lines.slice(1), [
    '10:00:07 turn reply spoke 2 msgs, think: Η Ελένη ρωτά.',
    '10:05:00 memory batch 6 lines, users 1, episodes 0',
    '11:00:00 system pause owner',
  ]);
  assert.match(lines[0], /2026-10-12/);
  assert.deepEqual(journal.calls.at(-1), ['read', 'g1', { day, kind: null, n: 3 }]);

  const actions = await admin.run('memory.journal.read', { day, kind: 'action' }, { placeId: 'g1' });
  assert.deepEqual(actions.split('\n').slice(1), ['10:00:05 action post started', '10:00:06 action post succeeded']);
  assert.deepEqual(journal.calls.at(-1)[2], { day, kind: 'action', n: 20 });

  // Today (UTC) by default; nothing there is said plainly.
  const today = await admin.run('memory.journal.read', {}, { placeId: 'g1' });
  assert.equal(journal.calls.at(-1)[2].day, new Date(Date.now()).toISOString().slice(0, 10));
  assert.match(today, /no journal records/);

  await assert.rejects(admin.run('memory.journal.read', { day: '12.10.2026' }, { placeId: 'g1' }), /YYYY-MM-DD/);
  await assert.rejects(admin.run('memory.journal.read', { day, n: 51 }, { placeId: 'g1' }), /1\.\.50/);
  await assert.rejects(admin.run('memory.journal.read', { day, kind: 'lore' }, { placeId: 'g1' }), /kind/);
});

// ---------------------------------------------------------------------------
// the journal and the archive read in a turn with no place (a heartbeat)
// ---------------------------------------------------------------------------

const NO_PLACE_DAY = '2026-11-14';

const NO_PLACE_AT = Date.parse(`${NO_PLACE_DAY}T09:00:00.000Z`);

/**
 * An admin over a real memory database, journal and archive, with one community the store knows as a top place
 * (noted the way an interface's hello notes its roots). `place` is that community's id.
 */
async function memoryWithCommunity({ openPrivate = false } = {}) {
  const mem = await openTestMemory();
  const log = { info() {}, warn() {}, error() {} };
  const appendStore = createAppendStore({ fsyncMs: 0, log });
  const archive = createArchive({ appendStore, dataDir: mem.dataDir, log, memoryDb: mem.memoryDb });
  const journal = createJournal({ dataDir: mem.dataDir, memoryDb: mem.memoryDb, now: () => NO_PLACE_AT });
  const store = createStore({ dataDir: mem.dataDir, archive, memoryDb: mem.memoryDb });
  store.noteRoots('discord', [{ id: '900000000000000001', name: 'Λιμάνι' }]);
  await new Promise((resolve) => setImmediate(resolve));
  const place = placeOfRoot(store, '900000000000000001', 'discord');
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.context = { ...(hot.config.context as object), memory: { openPrivate } };
  const { admin } = makeAdmin(rootDir, { hot, store, archive, journal, memoryDb: mem.memoryDb });
  const close = async () => {
    await appendStore.close();
    await mem.close();
    fs.rmSync(mem.dataDir, { recursive: true, force: true });
  };
  return { admin, store, archive, journal, place, close, db: mem.memoryDb.database() };
}

/** One archived detail whose text carries `marker`, filed with `scope`. */
const archivedFact = (marker: string, scope: Record<string, unknown>) =>
  archiveEntry(
    { itemId: `detail-${marker}`, text: `${marker} το είπε στο λιμάνι`, weight: 1 },
    { itemKind: 'detail', event: 'evicted', scope, now: () => NO_PLACE_AT }
  );

test('memory.journal.read in a turn with no place reads the persona journal and no place of the persona', async () => {
  // Catches: the read refused with no place resolved yet, or a no-place read that falls into some community's journal.
  const { admin, journal, place, close } = await memoryWithCommunity();
  try {
    await journal.inner(PERSONA_ID, { event: 'wake', reason: 'marker-persona-ilios' });
    await journal.action(place, { name: 'marker-place-thalassa', phase: 'succeeded' });

    const text = await admin.run('memory.journal.read', { day: NO_PLACE_DAY }, { placeId: null });

    assert.deepEqual(
      [text.includes('marker-persona-ilios'), text.includes('marker-place-thalassa')],
      [true, false],
      text
    );
  } finally {
    await close();
  }
});

test('memory.archive.read in a turn with no place lists the persona and community archives, never a private entry', async () => {
  // Catches: the read refused with no place, a community archive left unread, or a private entry of a direct chat shown.
  const { admin, archive, place, close } = await memoryWithCommunity();
  const dm = 'discord:dm:900000000000000077';
  try {
    await archive.append(null, [archivedFact('marker-persona-asteri', {})]);
    await archive.append(place, [archivedFact('marker-community-kyma', {})]);
    await archive.append(dm, [archivedFact('marker-private-mystiko', { place: dm, private: true })]);

    const text = await admin.run('memory.archive.read', {}, { placeId: null });

    assert.deepEqual(
      ['marker-persona-asteri', 'marker-community-kyma', 'marker-private-mystiko'].map((marker) =>
        text.includes(marker)
      ),
      [true, true, false],
      text
    );
  } finally {
    await close();
  }
});

test('memory.archive.read in a turn with no place lists a private entry of a direct chat with openPrivate', async () => {
  // Catches: the heartbeat's archive read keeps hiding a direct chat's archive when the switch opens the persona's memory.
  const { admin, archive, db, close } = await memoryWithCommunity({ openPrivate: true });
  const dm = 'discord:dm:900000000000000077';
  try {
    addDmPlace(present(db), {
      id: dm,
      iface: 'discord',
      authority: 'discord/global',
      account: 'discord:77',
      person: null,
    });
    await archive.append(dm, [archivedFact('marker-private-mystiko', { place: dm, private: true })]);

    const text = await admin.run('memory.archive.read', {}, { placeId: null });

    assert.equal(text.includes('marker-private-mystiko'), true, text);
  } finally {
    await close();
  }
});

test('memory.archive.read in a turn with no place lists the community entry about the person user names', async () => {
  // Catches: a no-place read that drops the person filter, or skips the community archive when a person is asked for.
  const { admin, archive, store, place, close } = await memoryWithCommunity();
  try {
    const asked = accountOf(store, '900000000000000011');
    const other = accountOf(store, '900000000000000012');
    await archive.append(place, [
      archivedFact('marker-asked-pyrgos', { user: asked }),
      archivedFact('marker-other-vrachos', { user: other }),
    ]);

    const text = await admin.run('memory.archive.read', { accountId: '900000000000000011' }, { placeId: null });

    assert.deepEqual(
      [text.includes('marker-asked-pyrgos'), text.includes('marker-other-vrachos')],
      [true, false],
      text
    );
  } finally {
    await close();
  }
});

test('memory.journal.read in a turn of a place reads that place journal and none of the persona journal', async () => {
  // Catches: a fix that reads the persona journal, alone or beside the place, in a turn that has a place.
  const { admin, journal, place, close } = await memoryWithCommunity();
  try {
    await journal.inner(PERSONA_ID, { event: 'wake', reason: 'marker-persona-ilios' });
    await journal.action(place, { name: 'marker-place-thalassa', phase: 'succeeded' });

    const text = await admin.run('memory.journal.read', { day: NO_PLACE_DAY }, { placeId: place });

    assert.deepEqual(
      [text.includes('marker-persona-ilios'), text.includes('marker-place-thalassa')],
      [false, true],
      text
    );
  } finally {
    await close();
  }
});

const quiet = { info() {}, debug() {}, warn() {}, error() {} };

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

const SECRET = 'xylophonewhisper';

// A first-generation DM on the home authority: the place and the person are spelled from the native id.
const PARTNER = 'n1';

const PARTNER_ACCOUNT = 'discord:n1';

const PARTNER_PERSON = 'person:discord:n1';

const DM = 'discord:dm:n1';

// Another partner on the same interface.
const OTHER = 'n2';

const OTHER_PERSON = 'person:discord:n2';

const OTHER_DM = 'discord:dm:n2';

const GROUP = 'discord:channel:room-1';

const SERVER = 'discord:server:g1';

// A partner with the same native id under another authority of the interface: the place's id spells nothing.
const STRANGER_ACCOUNT = 'account:other-authority';

const STRANGER_PERSON = 'person:elsewhere';

const STRANGER_DM = 'place:dm-other-authority';

const opened: Array<MemoryDbService> = [];

after(async () => {
  for (const service of opened) await service.close();
});

function seedWorld(db: Db): void {
  addAccount(db, {
    id: PARTNER_ACCOUNT,
    iface: 'discord',
    authority: 'discord/global',
    native: PARTNER,
    person: PARTNER_PERSON,
  });
  addAccount(db, {
    id: 'discord:n2',
    iface: 'discord',
    authority: 'discord/global',
    native: OTHER,
    person: OTHER_PERSON,
  });
  addAccount(db, {
    id: STRANGER_ACCOUNT,
    iface: 'discord',
    authority: 'discord/other',
    native: PARTNER,
    person: STRANGER_PERSON,
  });
  addDmPlace(db, {
    id: DM,
    iface: 'discord',
    authority: 'discord/global',
    account: PARTNER_ACCOUNT,
    person: PARTNER_PERSON,
  });
  addDmPlace(db, {
    id: OTHER_DM,
    iface: 'discord',
    authority: 'discord/global',
    account: 'discord:n2',
    person: OTHER_PERSON,
  });
  addDmPlace(db, {
    id: STRANGER_DM,
    iface: 'discord',
    authority: 'discord/other',
    account: STRANGER_ACCOUNT,
    person: STRANGER_PERSON,
  });
  addGroupPlace(db, GROUP, 'discord', 'discord/global');
  db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, chat, scope_kind)
     VALUES (?, 'discord', 'server', 'g1', 'server:g1', 'discord/global', 1, 'group', 'group')`
  ).run(SERVER);
}

function world() {
  const dataDir = tempDir('nep-dm-privacy-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  seedWorld(dbOf(seed));
  seed.close();
  const hot = { config: { memoryDb: { session: { mode: 'off' } }, context: { memory: { openPrivate: false } } } };
  const memoryDb = createMemoryDb({
    hot,
    dataDir,
    log: quiet,
    worker: false,
    iface: () => 'discord',
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const read = (): Db => dbOf(wrongly<Parameters<typeof dbOf>[0]>(memoryDb.readHandle()));
  const journal = createJournal({ dataDir, memoryDb, now: () => NOW, log: quiet });
  const record = createRecord({ dataDir, memoryDb, now: () => NOW, log: quiet });
  const appendStore = createAppendStore({ fsyncMs: 0, log: quiet });
  const archive = createArchive({ appendStore, dataDir, memoryDb, now: () => NOW, log: quiet });
  const vectors = createVectors({ dataDir, memoryDb, now: () => NOW, log: quiet });
  const store = createStore({ dataDir, archive, memoryDb });
  const contexts = {
    group: memoryDb.issueContext({ kind: 'group', iface: 'discord', destination: GROUP }),
    other: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: OTHER_PERSON, place: OTHER_DM }),
    partner: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: PARTNER_PERSON, place: DM }),
    stranger: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: STRANGER_PERSON, place: STRANGER_DM }),
  };
  return { dataDir, hot, memoryDb, read, journal, record, archive, vectors, store, contexts };
}

type World = ReturnType<typeof world>;

// ---- the archive ----------------------------------------------------------------------------------------------------

/**
 * One private episode in the archive, filed the way the store files an evicted private item: under the partner's DM
 * place as `{ place, private }`, or under the persona as `{ user, private }` for a member with no DM place. The engine
 * has no episode writer, so the entry is appended to the archive directly, beside a private layer written into the
 * database for the restore to write into. Answers its item id.
 */
async function evictedPrivate(w: World, account = PARTNER_ACCOUNT) {
  const at = new Date(NOW).toISOString();
  await writeUnitUpdate(w.memoryDb, {
    op: 'value',
    key: accountCollection('private', account),
    value: {
      relationship: '',
      interests: [],
      details: [{ id: 1, text: 'a later detail', weight: 1, firstSeen: at, lastSeen: at }],
      detailsSeq: 2,
      episodes: [],
      affinity: { score: 0, reason: '', history: [] },
      firstSeen: '',
      lastSeen: '',
      buffer: [],
    },
  });
  const home = account === PARTNER_ACCOUNT ? DM : null;
  const entry = wrongly<{ itemId: string }>(
    archiveEntry(
      { itemId: `ep-${account}`, date: '2026-10-01', what: `the ${SECRET} episode`, weight: 1 },
      {
        itemKind: 'episode',
        event: 'evicted',
        scope: home === null ? { user: account, private: true } : { place: home, private: true },
        now: () => NOW,
      }
    )
  );
  await w.archive.append(home, [entry]);
  return entry.itemId;
}

function admin(w: World) {
  const hot = {
    config: { bot: { owners: ['42'] }, llm: { maxRequestsPerDay: 300 } },
    prompts: { labels: { locale: 'en-US' } },
    reloadConfig: () => true,
    reloadPrompts: () => true,
  };
  return createAdmin(wrongly({ hot, store: w.store, archive: w.archive, journal: w.journal, dataDir: w.dataDir }));
}

test('a restored private item leaves its archive line under its DM, away from the persona', async () => {
  // Bug: `archiveHolderOf` reads `scope.user`, and a DM's item names `{ place, private }`, so its holder is the persona.
  const w = world();
  const itemId = await evictedPrivate(w);
  await admin(w).run('memory.restore', { itemId }, { placeId: DM });
  const seen: Array<unknown> = [];
  for await (const entry of w.archive.iterate(null)) seen.push(entry);
  assert.equal(JSON.stringify(seen).includes(SECRET), false);
});

test('the archive list of a group does not show a restored item of a DM', async () => {
  // Bug: a line filed under the persona with no `scope.user` passes `cmdMemoryArchive`'s member check in every place.
  const w = world();
  const itemId = await evictedPrivate(w);
  await admin(w).run('memory.restore', { itemId }, { placeId: DM });
  const listed: unknown = await admin(w).run('memory.archive.read', {}, { placeId: GROUP });
  assert.equal(JSON.stringify(listed).includes(SECRET), false);
});

test('the archive list of a group names no private item of a member who has no DM place yet', async () => {
  // Bug: the private item goes to the persona's archive as `{ user, private }`, and the list filters by `user` alone.
  const w = world();
  w.store.touchUser('discord:n9', 'Late', NOW);
  await evictedPrivate(w, 'discord:n9');
  const listed: unknown = await admin(w).run('memory.archive.read', { accountId: 'n9' }, { placeId: GROUP });
  assert.equal(JSON.stringify(listed).includes(SECRET), false);
});

const OWNER = '42';

const SELF = 'self-1';

const DATA = path.join('fake-root', 'data');

/** The id of a message sent at `ms` on a platform whose ids carry their time (the first possible id of that millisecond), `n` keeping ids of the same millisecond apart. */
const ID_EPOCH_MS = 1_420_070_400_000n;

const idAt = (ms: number, n = 1) => (((BigInt(ms) - ID_EPOCH_MS) << 22n) + BigInt(n)).toString();

function fakeAppendStore() {
  const lines: Array<Untyped> = [];
  return {
    lines,
    append: async (file: Untyped, line: Untyped) => {
      lines.push({ file, line });
    },
    async *iterate(file: Untyped) {
      for (const entry of lines) if (entry.file === file) yield { offset: 0, line: entry.line };
    },
  };
}

/** The test databases opened here; closed when the file is done. */
const OPENED: Array<Untyped> = [];

after(async () => {
  for (const mem of OPENED) await mem.close();
});

/** A test memory database whose unit writes also record each line in `lines` as `{ file, line }`. */
function recordingMemory(lines: Record<string, Untyped>) {
  const mem = openTestMemorySync();
  OPENED.push(mem);
  return {
    ...mem.memoryDb,
    writeJournalLines: (write: JournalLinesWrite) => {
      for (const line of write.lines)
        lines.push({ file: journalLineLabel(DATA, write.placeId, line), line: JSON.stringify(line) });
      return mem.memoryDb.writeJournalLines(write);
    },
  };
}

type Clock = { ms: number };

function journalAt(clock: Clock) {
  let n = 0;
  const appendStore = fakeAppendStore();
  const journal = createJournal({
    appendStore,
    memoryDb: recordingMemory(appendStore.lines),
    dataDir: DATA,
    config: () => ({ thinkChars: 4000 }),
    now: () => clock.ms,
    uuid: () => `u-${(n += 1)}`,
  });
  return { journal, appendStore };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A long think in Greek: far past the 80 characters a day line shows. */
const THINK = `Η Ελένη ρωτά για το ταξίδι. ${'Σκέφτομαι τι να πω, και πώς. '.repeat(90)}Τέλος.`;

/**
 * One turn written as a live turn writes it: `turn.start` at `startMs`, a post operation closed
 * `succeeded` with `postedId` at `postMs`, the `turn` record at `endMs`.
 */
async function writeTurn(
  journal: ReturnType<typeof journalAt>['journal'],
  clock: Clock,
  {
    startMs,
    postMs,
    endMs,
    triggerId,
    postedId,
    placeId = 'c1',
    journalPlace = 'g1',
  }: {
    startMs: number;
    postMs: number;
    endMs: number;
    triggerId: string;
    postedId: string;
    placeId?: string;
    journalPlace?: string;
  }
) {
  clock.ms = startMs;
  const started = journal.start(journalPlace, {
    placeId,
    mode: 'reply',
    trigger: { kind: 'mention', messageId: triggerId, authorId: '7' },
    participants: ['7'],
    sourceMessageIds: [triggerId],
  });
  await tick();
  clock.ms = postMs;
  const op = journal.op(journalPlace, {
    turnId: started.turnId,
    name: 'post',
    by: 'persona',
    placeId,
    intent: { replyTo: triggerId, text: 'γεια' },
  });
  await op.started();
  await op.succeeded({ messageId: postedId });
  const actions = [op.opId];
  clock.ms = endMs;
  await journal.turn(journalPlace, {
    turnId: started.turnId,
    attemptId: started.attemptId,
    startedAt: started.startedAt,
    placeId,
    mode: 'reply',
    outcome: 'spoke',
    reason: null,
    seen: { messageIds: [triggerId] },
    think: THINK,
    posted: [{ opId: op.opId, messageId: postedId, replyTo: triggerId }],
    actions,
  });
  return started;
}

/** An admin over the journal, the persona's own id `SELF`, the owner `OWNER`. */
function journalTurnMakeAdmin(journal: Record<string, Untyped>, { openPrivate = false } = {}) {
  const hot = {
    config: {
      context: { memory: { openPrivate } },
      features: { tools: true, journal: true },
      tools: { safeMode: false },
      bot: { ownerPerson: OWNER_PERSON, access: {} },
    },
    prompts: { labels: {} },
  };
  const store = {
    state: { data: {}, markDirty() {} },
    getUser: () => null,
    getPlace: () => ({}),
  };
  // The interface says when a message was written (`fetchMessages`); the ids of these tests carry their time.
  const reads = {
    parseLinks: (texts: Record<string, Untyped>) =>
      Promise.resolve({
        refs: texts.map((text: string) => {
          const found = /^https:\/\/discord\.com\/channels\/\d+\/(\d+)\/(\d+)$/.exec(text);
          return found ? { iface: 'fake', chatId: found[1], messageId: found[2] } : null;
        }),
      }),
    fetchMessages: (ref: Record<string, Untyped>, ids: Record<string, Untyped>) =>
      Promise.resolve({
        messages: ids.map((id: Untyped) => ({
          messageId: id,
          event: { message: { id, at: Number((BigInt(id) >> 22n) + ID_EPOCH_MS) } },
        })),
      }),
  };
  return createAdmin({
    hot,
    store,
    reads: wrongly(reads),
    port: { iface: 'fake' },
    selfId: () => SELF,
    isServedRoot: (id: unknown) => id === 'g1',
    journal,
  });
}

const D = Date.UTC(2026, 9, 13, 12, 0, 0);

const journalTurnAdmin = (journal: Record<string, Untyped>, openPrivate: boolean) =>
  journalTurnMakeAdmin(journal, { openPrivate });

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy([OWNER]);

describe('journal turns', () => {
  // A bare id is dated by reading the message in the chat the command runs in (`placeId`), a link names its own.
  // PR 7b: admin.run takes the operation's name, the command key map is gone; the expectations are as they were.
  test('memory.journal.read: by message id or link, the turn record whole; not by the persona or no record is not-found', async () => {
    const clock = { ms: D };
    const { journal } = journalAt(clock);
    const postedId = idAt(D + 3000);
    const triggerId = idAt(D - 60_000);
    const started = await writeTurn(journal, clock, {
      startMs: D,
      postMs: D + 3000,
      endMs: D + 5000,
      triggerId,
      postedId,
    });
    const admin = journalTurnMakeAdmin(journal);

    const byId = String(
      await admin.run('memory.journal.read', { messageId: postedId }, { placeId: 'g1', accountId: OWNER })
    );
    assert.ok(byId.includes(THINK), 'the think whole, not its first 80 characters');
    assert.ok(byId.includes(started.turnId));
    const byLink = await admin.run(
      'memory.journal.read',
      { messageId: `https://discord.com/channels/111/222/${postedId}` },
      { placeId: 'g1', accountId: OWNER }
    );
    assert.equal(byLink, byId);

    // Someone else's message (it started the turn), an unknown one, and junk.
    await assert.rejects(
      admin.run('memory.journal.read', { messageId: triggerId }, { placeId: 'g1', accountId: OWNER }),
      {
        code: 'not-found',
      }
    );
    await assert.rejects(
      admin.run('memory.journal.read', { messageId: idAt(D + 4000, 9) }, { placeId: 'g1', accountId: OWNER }),
      { code: 'not-found' }
    );
    await assert.rejects(
      admin.run('memory.journal.read', { messageId: 'not an id' }, { placeId: 'g1', accountId: OWNER }),
      {
        code: 'unknown-message',
      }
    );
  });

  for (const openPrivate of [true, false])
    test(`memory.journal.read: a link to a direct chat's message from a group ${openPrivate ? 'finds' : 'misses'} its turn with openPrivate ${openPrivate}`, async () => {
      const clock = { ms: D };
      const { journal } = journalAt(clock);
      const postedId = idAt(D + 3000);
      // The turn ran in the direct chat 333, whose journal is its own place's.
      await writeTurn(journal, clock, {
        startMs: D,
        postMs: D + 3000,
        endMs: D + 5000,
        triggerId: idAt(D - 60_000),
        postedId,
        placeId: '333',
        journalPlace: '333',
      });
      const read = journalTurnAdmin(journal, openPrivate).run(
        'memory.journal.read',
        { messageId: `https://discord.com/channels/111/333/${postedId}` },
        { placeId: 'g1', accountId: OWNER }
      );
      if (openPrivate) assert.ok(String(await read).includes(THINK));
      else await assert.rejects(read, { code: 'not-found' });
    });

  test('memory.journal.read: the persona names their line #N; it resolves to the message id as message.edit does', async () => {
    const clock = { ms: D };
    const { journal } = journalAt(clock);
    const postedId = idAt(D + 3000);
    await writeTurn(journal, clock, { startMs: D, postMs: D + 3000, endMs: D + 5000, triggerId: 'm-t', postedId });
    const admin = journalTurnMakeAdmin(journal);
    const lines = new Map([[2, { id: postedId, chatId: 'c1', authorId: SELF, self: true }]]);

    const resolved = resolveCall(wrongly({ skill: 'memory.journal.read', args: { message: '#2' }, body: '' }), {
      skills: skillRegistry(),
      messageAt: (n) => lines.get(n) ?? null,
      selfId: SELF,
    });
    assert.equal(resolved.ok, true);
    assert.deepEqual(resolved.args, { message: postedId });
    const result: Record<string, Untyped> = await executeCall(
      resolved,
      wrongly({
        envelope: Object.freeze({
          actor: 'persona',
          requester: { id: OWNER, roleIds: [] },
          mixed: false,
          invocationId: 'inv-1',
          originChannelId: 'c1',
        }),
        runOp: admin.runSkillOp,
        runOwnOp: admin.runOwnSkillOp,
        opContext: { placeId: 'g1' },
      })
    );
    assert.equal(result.status, 'ok');
    assert.ok(present(result.data).text.includes(THINK));
    assert.equal(
      wrongly<Untyped>(
        resolveCall(wrongly({ skill: 'memory.journal.read', args: { message: '#9' }, body: '' }), {
          skills: skillRegistry(),
          messageAt: (n) => lines.get(n) ?? null,
        })
      ).code,
      'unknown-message'
    );
  });
});

const opsAffinityChangesOpened: Array<MemoryDbService> = [];

after(async () => {
  for (const service of opsAffinityChangesOpened) await service.close();
});

type Seed = {
  id: string;
  person: string;
  at: string;
  applied: number;
  score: number;
  reason: string;
  retired?: boolean;
};

const EVENTS: Array<Seed> = [
  { id: 'ev:1', person: ANNA, at: '2026-11-01T10:00:00.000Z', applied: 2, score: 12, reason: 'helped with the garden' },
  { id: 'ev:2', person: BORIS, at: '2026-11-03T10:00:00.000Z', applied: -1, score: 4, reason: 'snapped at a friend' },
  { id: 'ev:3', person: ANNA, at: '2026-11-05T10:00:00.000Z', applied: 1, score: 13, reason: 'thanked her twice' },
  {
    id: 'ev:4',
    person: ANNA,
    at: '2026-11-04T10:00:00.000Z',
    applied: 5,
    score: 99,
    reason: 'a retired move',
    retired: true,
  },
];

function rig() {
  const dataDir = tempDir('nep-ops-affinity-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  const db = dbOf(seed);
  seedOpaqueWorld(db);
  for (const e of EVENTS)
    db.prepare(
      `INSERT INTO affinity_events (id, person_id, at, delta, applied, score, reason, audience_id, scope_kind, writer, retired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'aud:group:discord', 'group', 'session', ?)`
    ).run(e.id, e.person, e.at, e.applied, e.applied, e.score, e.reason, e.retired ? '2026-11-06T00:00:00.000Z' : null);
  seed.close();
  const memoryDb = createMemoryDb({
    iface: () => 'discord',
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
  });
  memoryDb.tick();
  opsAffinityChangesOpened.push(memoryDb);
  const hot = {
    config: { bot: { owners: [], access: {} }, llm: { model: 'x/y', maxRequestsPerDay: 10 } },
    prompts: { labels: {} },
    rootDir: dataDir,
    reloadConfig: () => true,
    reloadPrompts: () => true,
  };
  const env = createOpsEnv({
    hot,
    store: createStore({ dataDir, memoryDb }),
    memoryDb,
    dataDir,
  });
  return { env };
}

const read = async (args: Record<string, unknown>) => {
  const { env } = rig();
  const result = await runOp('memory.profile.read', { section: 'changes', ...args }, { env, asOwner: true });
  return { result, text: JSON.stringify(result) };
};

test('a date that is not a date is refused', async () => {
  const { result } = await read({ since: 'last tuesday' });
  assert.equal(result.status, 'invalid');
});

test('the changes of one person alone', async () => {
  // Catches: the person filter is ignored and Boris's moves come with Anna's.
  const { env } = rig();
  const result = await runOp('memory.profile.read', { section: 'changes', accountId: 'n1' }, { env, asOwner: true });
  const text = JSON.stringify(result);
  assert.ok(text.includes('thanked her twice') && text.includes('helped with the garden'));
  assert.equal(text.includes('snapped at a friend'), false);
});

const opsPrivateReadOpened: Array<MemoryDbService> = [];

after(async () => {
  for (const service of opsPrivateReadOpened) await service.close();
});

function opsPrivateReadRig(): { env: ReturnType<typeof createOpsEnv>; memoryDb: MemoryDbService } {
  const dataDir = tempDir('nep-ops-private-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  seedOpaqueWorld(dbOf(seed));
  seed.close();
  const memoryDb = createMemoryDb({
    iface: () => 'discord',
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
  });
  memoryDb.tick();
  opsPrivateReadOpened.push(memoryDb);
  const rootDir = tempDir('nep-ops-private-root-');
  fs.mkdirSync(path.join(rootDir, 'prompts'));
  const hot = {
    config: { bot: { owners: [], access: {} }, llm: { model: 'x/y', maxRequestsPerDay: 10 } },
    prompts: { labels: {} },
    promptSources: {},
    promptsDir: path.join(rootDir, 'prompts'),
    localPromptsDir: path.join(rootDir, 'prompts.local'),
    rootDir,
    reloadConfig: () => true,
    reloadPrompts: () => true,
  };
  const env = createOpsEnv({
    hot,
    store: createStore({ dataDir, memoryDb }),
    memoryDb,
    dataDir,
  });
  return { env, memoryDb };
}

const textOf = (result: { data?: unknown; message?: unknown; text?: unknown }): string => JSON.stringify(result);

test('the owner reads a person across all their DMs, with no root anywhere', async () => {
  // Bug: `requireRootId` refuses first, then one root's unit of one account is all that is read.
  const { env } = opsPrivateReadRig();
  const result = await runOp('memory.private.read', { person: ANNA }, { env, asOwner: true });
  assert.equal(result.status, 'ok');
  const text = textOf(result);
  assert.ok(text.includes('the words of claim:a11'));
  assert.ok(text.includes('the event of episode:a21'));
  assert.equal(text.includes('the words of claim:b21'), false);
});

test('the owner reads one DM place and only that chat', async () => {
  // Bug: the operation has only a user argument, so one chat of a person cannot be inspected.
  const { env } = opsPrivateReadRig();
  const result = await runOp('memory.private.read', { place: 'place:dm-a21' }, { env, asOwner: true });
  assert.equal(result.status, 'ok');
  const text = textOf(result);
  assert.ok(text.includes('the event of episode:a21'));
  assert.equal(text.includes('the words of claim:a11'), false);
});

test('an unknown person and an unknown place answer their named codes', async () => {
  // Bug: a typo reads as an empty private memory.
  const { env } = opsPrivateReadRig();
  assert.equal(
    (await runOp('memory.private.read', { person: 'person:nobody' }, { env, asOwner: true })).code,
    'PERSON_NOT_FOUND'
  );
  assert.equal(
    (await runOp('memory.private.read', { place: 'place:nowhere' }, { env, asOwner: true })).code,
    'PLACE_NOT_FOUND'
  );
});
