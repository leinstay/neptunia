// health: allow file-length until 2027-02-01 -- the place rename widened lines the formatter wraps; split in the slice after the cutover
// Tests for the memory store's database collections and standalone file backend.
import { accountOf, placeOfRoot, placeOfChat } from '../src/memory/addresses.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore, writeJsonAtomic } from '../src/memory/store.ts';
import { accountCollection, personaKey } from '../src/memory/db/storage-keys.ts';
import type { AccountProfileWrite } from '../src/memory/db/account-profile.ts';
import { legacyStorageKey } from './fixtures/memory-db/legacy-paths.ts';

import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { PARTICIPATION_DEFAULTS, emptyParticipation, recordOwnLine } from '../src/memory/participation.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { asRecord } from './fixtures/records.ts';
import type { Untyped } from '../src/tools/types.ts';
import {
  AGORA_FACTS,
  WRITERS_DAY_MS,
  WRITERS_T0,
  existsRaw,
  fakeArchive,
  memDataDir,
  readRaw,
  settle,
  tmpDataDir,
  whats,
  writeLines,
  writeOldChannelFile,
  underTop,
  writeRaw,
  memoryAt,
} from './fixtures/store-kit.ts';
import { writeUnitUpdate } from './fixtures/memory-db/unit-writes.ts';

// The casts through `Parameters<typeof f>` hand a function a fake that carries only the fields the test reads.

test('touchUser: puts the current name first, keeps previous names after, deduplicated', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  store.touchUser(accountOf(store, 'u1'), 'Bob', 2000); // renamed
  const profile = store.touchUser(accountOf(store, 'u1'), 'Alice', 3000); // renamed back
  assert.deepEqual(asRecord(profile).names, ['Alice', 'Bob']); // no duplicate 'Alice'
});

test('touchUser: names list is capped at 5 entries', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  const names = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'];
  let profile;
  for (const [i, name] of names.entries()) profile = store.touchUser(accountOf(store, 'u1'), name, i);
  assert.equal(asRecord(profile).names.length, 5);
  assert.equal(asRecord(profile).names[0], 'n6'); // most recent first
});

test('touchUser: an empty/falsy name does not touch the names list', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  const profile = store.touchUser(accountOf(store, 'u1'), '', 2000);
  assert.deepEqual(asRecord(profile).names, ['Alice']);
});

// ---- out-of-order touches (old history fed after a live touch today) ----

test('touchUser: firstSeen is min(existing, at) and lastSeen is max(existing, at), regardless of arrival order', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  // Live touch today...
  store.touchUser(accountOf(store, 'u1'), 'Alice', 5_000_000);
  // ...then four years of older history arrive.
  const profile = store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  assert.equal(asRecord(profile).firstSeen, new Date(1000).toISOString(), 'firstSeen widens to the older message');
  assert.equal(
    asRecord(profile).lastSeen,
    new Date(5_000_000).toISOString(),
    'lastSeen does NOT regress to the older message'
  );
  assert.equal(asRecord(profile).messageCount, 2);
});

test('touchUser: an older/backdated touch never moves a name to the front', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 5_000_000); // live, current display name
  const profile = store.touchUser(accountOf(store, 'u1'), 'OldNick', 1000); // backdated history, an older name
  assert.deepEqual(
    asRecord(profile).names,
    ['Alice', 'OldNick'],
    'the current name stays first; the old one is appended'
  );
});

test('touchUser: a backdated touch of an already-known name leaves the names order untouched', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 5_000_000);
  store.touchUser(accountOf(store, 'u1'), 'Bob', 6_000_000); // renamed, now current
  const profile = store.touchUser(accountOf(store, 'u1'), 'Alice', 1000); // backdated history mentioning the old name
  assert.deepEqual(asRecord(profile).names, ['Bob', 'Alice'], 'Alice is not moved back to the front by an older touch');
});

test('touchUser: a touch at exactly the stored lastSeen still counts as newest (moves the name to the front)', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  const profile = store.touchUser(accountOf(store, 'u1'), 'Bob', 1000);
  assert.deepEqual(asRecord(profile).names, ['Bob', 'Alice']);
});

test('updateUser: cannot set interests or details via raw LLM fields', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  store.applyProfileOps(
    accountOf(store, 'u1'),
    { interests: { add: [{ topic: 'chess', note: '' }] }, details: { add: ['likes tea'] } },
    {
      maxInterests: 12,
      topicChars: 40,
      noteChars: 120,
      maxDetails: 15,
      now: 1000,
    }
  );

  store.updateUser(accountOf(store, 'u1'), {
    character: 'chatty',
    interests: [{ topic: 'sneaky', note: '', weight: 99, firstSeen: 'x', lastSeen: 'x' }],
    details: ['sneaky overwrite'],
  });

  const profile = store.getUser(accountOf(store, 'u1'));
  assert.equal(asRecord(profile).character, 'chatty');
  assert.equal(asRecord(profile).interests.length, 1);
  assert.equal(asRecord(profile).interests[0].topic, 'chess');
  assert.equal(asRecord(profile).details.length, 1);
  assert.equal(asRecord(profile).details[0].text, 'likes tea');
});

// ---- guild.learned: things people taught the persona --------------------------

const LEARNED_CFG = {
  maxLearned: 20,
  maxLearnedStored: 60,
  learnedChars: 160,
  learnedHalfLifeDays: 720,
  confirmGapHours: 12,
};
const TEACH_AT = Date.UTC(2026, 8, 21, 12, 0, 0);

test('getPlace: a hand-edited learned list is validated, ids assigned off learnedNextId', async () => {
  const { dir, memoryDb } = memDataDir();
  const file = path.join(dir, 'guilds', 'g1', 'guild.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeRaw(file, {
    patterns: '',
    learned: [
      { id: 4, text: 'Café closes at nine', weight: 2, from: '<@322222222222222222>' },
      { text: 'Friday is τυρόπιτα day' },
      'garbage',
      { text: '' },
    ],
    learnedNextId: 3,
  });
  const guild = createStore({ dataDir: dir, memoryDb }).getPlace('discord:server:g1');
  assert.deepEqual(
    asRecord(guild).learned.map((i: Untyped) => [i.id, i.text, i.from]),
    [
      [4, 'Café closes at nine', '<@322222222222222222>'],
      [5, 'Friday is τυρόπιτα day', undefined],
    ]
  );
  assert.equal(asRecord(guild).learnedNextId, 6);
});

test('getPlace: learned that is not an array or a garbage learnedNextId never throws', async () => {
  const { dir, memoryDb } = memDataDir();
  const file = path.join(dir, 'guilds', 'g1', 'guild.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeRaw(file, { patterns: 'x', learned: 'nope', learnedNextId: -3 });
  const guild = createStore({ dataDir: dir, memoryDb }).getPlace('discord:server:g1');
  assert.deepEqual(asRecord(guild).learned, []);
  assert.equal(asRecord(guild).learnedNextId, 1);
  assert.equal(asRecord(guild).patterns, 'x');
});

// The members' ping states (getPings, setPings, after the owner's word of 2026-11-06) are tested in
// tests/store-pings-state.test.ts. This one reads a hand-broken field.
test('pings: a hand-broken field reads as {}, junk entries dropped, a junk pingsOff list adds only its string ids', async () => {
  for (const [stored, expected] of [
    [{ pings: 'u1' }, {}],
    [{ pings: ['u1'] }, {}],
    [{ pings: { u1: 'on', u2: 'maybe', u3: true, u4: 'off' } }, { u1: 'on', u4: 'off' }],
    [{ pingsOff: ['u1', 7, null, '', 'u1', { id: 'u2' }, 'u3'] }, { u1: 'off', u3: 'off' }],
    [
      { pings: { u1: 'on' }, pingsOff: ['u1', 'u2'] },
      { u1: 'on', u2: 'off' },
    ],
  ]) {
    const { dir, memoryDb } = memDataDir();
    const file = path.join(dir, 'guilds', 'g1', 'guild.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeRaw(file, { patterns: '', ...stored });
    const guild = asRecord(createStore({ dataDir: dir, memoryDb }).getPlace('discord:server:g1'));
    assert.deepEqual(guild.pings, expected, JSON.stringify(stored));
    assert.equal('pingsOff' in guild, false, JSON.stringify(stored));
  }
});

test('applyLearnedOps: adds items with per-guild ids, from kept, returns the new list, persists across a restart', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb, newId: counterIds() });
  const learned = store.applyLearnedOps(
    placeOfRoot(store, 'g1'),
    { add: [{ text: 'Café closes at nine', from: '<@322222222222222222>' }, 'Friday is τυρόπιτα day'] },
    { ...LEARNED_CFG, seenAt: TEACH_AT }
  );
  assert.deepEqual(learned, [
    {
      id: 1,
      text: 'Café closes at nine',
      weight: 1,
      firstSeen: new Date(TEACH_AT).toISOString(),
      lastSeen: new Date(TEACH_AT).toISOString(),
      from: '<@322222222222222222>',
      itemId: 'ln-u1',
    },
    {
      id: 2,
      text: 'Friday is τυρόπιτα day',
      weight: 1,
      firstSeen: new Date(TEACH_AT).toISOString(),
      lastSeen: new Date(TEACH_AT).toISOString(),
      itemId: 'ln-u2',
    },
  ]);
  assert.equal(asRecord(store.getPlace(placeOfRoot(store, 'g1'))).learnedNextId, 3);
  store.flush();
  await store.flushSettled({});

  const again = createStore({ dataDir: dir, memoryDb }).getPlace('discord:server:g1');
  assert.deepEqual(asRecord(again).learned, learned);
  assert.equal(asRecord(again).learnedNextId, 3);
});

test('applyLearnedOps: ids are never reused after a remove; seen bumps past the gap; sure:false starts at 0', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  store.applyLearnedOps(placeOfRoot(store, 'g1'), { add: ['a fact', 'b fact'] }, { ...LEARNED_CFG, seenAt: TEACH_AT });
  store.applyLearnedOps(
    placeOfRoot(store, 'g1'),
    { remove: [2], seen: [1] },
    { ...LEARNED_CFG, seenAt: TEACH_AT + 24 * 3_600_000 }
  );
  const learned = store.applyLearnedOps(
    placeOfRoot(store, 'g1'),
    { add: [{ text: 'c fact', sure: false }] },
    { ...LEARNED_CFG, seenAt: TEACH_AT }
  );
  assert.deepEqual(
    learned.map((i) => [asRecord(i).id, asRecord(i).text, asRecord(i).weight]),
    [
      [1, 'a fact', 2],
      [3, 'c fact', 0],
    ]
  );
});

test('applyLearnedOps: text is clamped to learnedChars, storage capped at max(maxLearnedStored, maxLearned)', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  const long = 'ω'.repeat(400);
  const cfg = { ...LEARNED_CFG, learnedChars: 10, clampTolerance: 1, maxLearned: 2, maxLearnedStored: 3 };
  const learned = store.applyLearnedOps(
    placeOfRoot(store, 'g1'),
    { add: [long, 'f1', 'f2', 'f3', 'f4'] },
    { ...cfg, seenAt: TEACH_AT }
  );
  assert.equal(learned.length, 3);
  assert.ok(learned.every((i) => Array.from(asRecord(i).text).length <= 10));
});

test('applyLearnedOps: garbage ops never throw and change nothing', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  store.applyLearnedOps(placeOfRoot(store, 'g1'), { add: ['kept fact'] }, { ...LEARNED_CFG, seenAt: TEACH_AT });
  for (const garbage of [
    null,
    undefined,
    'nope',
    42,
    [1],
    { add: 'x' },
    { add: [null, 42, {}] },
    { seen: [{}] },
    { remove: [{}] },
  ]) {
    const learned = store.applyLearnedOps(
      placeOfRoot(store, 'g1'),
      garbage as unknown as Parameters<typeof store.applyLearnedOps>[1],
      {
        ...LEARNED_CFG,
        seenAt: TEACH_AT,
      }
    );
    assert.deepEqual(
      learned.map((i) => asRecord(i).text),
      ['kept fact'],
      `garbage ${JSON.stringify(garbage)}`
    );
  }
});

test('applyLearnedOps: leaves every other guild field alone', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  store.updatePlace(placeOfRoot(store, 'g1'), { patterns: 'μιμίδια', injokes: ['ο βράχος'] });
  store.applyLearnedOps(placeOfRoot(store, 'g1'), { add: ['a fact'] }, { ...LEARNED_CFG, seenAt: TEACH_AT });
  const guild = store.getPlace(placeOfRoot(store, 'g1'));
  assert.equal(asRecord(guild).patterns, 'μιμίδια');
  assert.deepEqual(asRecord(guild).injokes, ['ο βράχος']);
});

test('updatePlace: can never overwrite learned or learnedNextId wholesale', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  store.applyLearnedOps(placeOfRoot(store, 'g1'), { add: ['a fact'] }, { ...LEARNED_CFG, seenAt: TEACH_AT });
  store.updatePlace(placeOfRoot(store, 'g1'), { patterns: 'p', learned: [], learnedNextId: 99 });
  const guild = store.getPlace(placeOfRoot(store, 'g1'));
  assert.deepEqual(
    asRecord(guild).learned.map((i: Untyped) => i.text),
    ['a fact']
  );
  assert.equal(asRecord(guild).learnedNextId, 2);
  assert.equal(asRecord(guild).patterns, 'p');
});

test('updatePlace: a re-send identical to what is stored leaves updatedAt alone; a change is stamped', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  const earlier = '2000-01-01T00:00:00.000Z';
  asRecord(
    store.updatePlace(placeOfRoot(store, 'g1'), { patterns: 'μιμίδια', injokes: ['ο βράχος', 'café'] })
  ).updatedAt = earlier;

  assert.equal(
    asRecord(store.updatePlace(placeOfRoot(store, 'g1'), { patterns: 'μιμίδια', injokes: ['ο βράχος', 'café'] }))
      .updatedAt,
    earlier
  );
  assert.equal(
    asRecord(store.updatePlace(placeOfRoot(store, 'g1'), { learned: [], learnedNextId: 99 })).updatedAt,
    earlier,
    'stripped fields alone are no change'
  );

  const guild = store.updatePlace(placeOfRoot(store, 'g1'), {
    patterns: 'μιμίδια',
    injokes: ['café', 'ο βράχος'],
  });
  assert.notEqual(asRecord(guild).updatedAt, earlier, 'a reordered list is a change');
  assert.deepEqual(asRecord(guild).injokes, ['café', 'ο βράχος']);
});

// ---- the notes stamps: when the server and channel notes last changed, and were last re-checked ----

const NOTES_EARLIER = '2000-01-01T00:00:00.000Z';

test('updatePlace: notesUpdatedAt moves for patterns, starters or injokes only', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  const rewind = () =>
    Object.assign(store.getPlace(placeOfRoot(store, 'g1')), {
      updatedAt: NOTES_EARLIER,
      notesUpdatedAt: NOTES_EARLIER,
    });
  store.updatePlace(placeOfRoot(store, 'g1'), {
    patterns: 'μιμίδια',
    starters: 'καλημέρα',
    injokes: ['ο βράχος'],
    self: ['πίνω τσάι'],
  });
  assert.equal(
    asRecord(store.getPlace(placeOfRoot(store, 'g1'))).notesUpdatedAt,
    asRecord(store.getPlace(placeOfRoot(store, 'g1'))).updatedAt,
    'the first notes are stamped with the write'
  );

  for (const fields of [
    { patterns: 'γάτες' },
    { starters: 'καληνύχτα' },
    { injokes: ['ο βράχος', 'café'] },
    { self: ['παίζω κιθάρα'], patterns: 'σκύλοι' },
  ]) {
    rewind();
    const guild = store.updatePlace(placeOfRoot(store, 'g1'), fields);
    assert.notEqual(asRecord(guild).notesUpdatedAt, NOTES_EARLIER, `${Object.keys(fields)} moves the notes stamp`);
    assert.equal(asRecord(guild).notesUpdatedAt, asRecord(guild).updatedAt, 'one instant for both stamps');
  }

  rewind();
  const selfOnly = store.updatePlace(placeOfRoot(store, 'g1'), { self: ['φοβάμαι τις αράχνες'] });
  assert.notEqual(asRecord(selfOnly).updatedAt, NOTES_EARLIER, 'a self fact is a change of the guild');
  assert.equal(asRecord(selfOnly).notesUpdatedAt, NOTES_EARLIER, 'self alone never moves the notes stamp');

  rewind();
  const sameNotes = store.updatePlace(placeOfRoot(store, 'g1'), {
    self: ['μισώ τη βροχή'],
    patterns: 'σκύλοι',
    starters: 'καληνύχτα',
    injokes: ['ο βράχος', 'café'],
  });
  assert.notEqual(asRecord(sameNotes).updatedAt, NOTES_EARLIER);
  assert.equal(
    asRecord(sameNotes).notesUpdatedAt,
    NOTES_EARLIER,
    'notes re-sent as stored beside a new self fact are no change of the notes'
  );

  rewind();
  const resent = store.updatePlace(placeOfRoot(store, 'g1'), {
    patterns: 'σκύλοι',
    starters: 'καληνύχτα',
    injokes: ['ο βράχος', 'café'],
  });
  assert.deepEqual(
    [asRecord(resent).updatedAt, asRecord(resent).notesUpdatedAt],
    [NOTES_EARLIER, NOTES_EARLIER],
    'an identical re-send stamps nothing'
  );
});

test('updatePlace: the notes stamps can never be set through the fields', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  store.updatePlace(placeOfRoot(store, 'g1'), { patterns: 'μιμίδια' });
  Object.assign(store.getPlace(placeOfRoot(store, 'g1')), {
    updatedAt: NOTES_EARLIER,
    notesUpdatedAt: NOTES_EARLIER,
  });

  const guild = store.updatePlace(placeOfRoot(store, 'g1'), {
    notesUpdatedAt: '2030-01-01T00:00:00.000Z',
    notesCheckedAt: '2030-01-01T00:00:00.000Z',
  });
  assert.deepEqual(
    [asRecord(guild).updatedAt, asRecord(guild).notesUpdatedAt, asRecord(guild).notesCheckedAt],
    [NOTES_EARLIER, NOTES_EARLIER, null]
  );
});

test('applyLearnedOps: a lesson never moves notesUpdatedAt', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  store.updatePlace(placeOfRoot(store, 'g1'), { patterns: 'μιμίδια' });
  Object.assign(store.getPlace(placeOfRoot(store, 'g1')), {
    updatedAt: NOTES_EARLIER,
    notesUpdatedAt: NOTES_EARLIER,
  });

  store.applyLearnedOps(
    placeOfRoot(store, 'g1'),
    { add: ['Café closes at nine'] },
    { ...LEARNED_CFG, seenAt: TEACH_AT }
  );
  const guild = store.getPlace(placeOfRoot(store, 'g1'));
  assert.notEqual(asRecord(guild).updatedAt, NOTES_EARLIER);
  assert.equal(asRecord(guild).notesUpdatedAt, NOTES_EARLIER);
});

test('markNotesFlagged: stamps notesFlaggedAt on existing channels and the guild only', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  store.updateChannel(placeOfChat(store, { id: 'c1' }), { purpose: 'alpha' });
  const r = store.markNotesFlagged(
    placeOfRoot(store, 'g1'),
    { channels: [placeOfChat(store, { id: 'c1' }), 'ghost'], place: true },
    Date.UTC(2026, 9, 7)
  );
  assert.deepEqual(r, { channels: 1, place: true });
  assert.equal(store.getChannel(placeOfChat(store, { id: 'c1' }))?.notesFlaggedAt, '2026-10-07T00:00:00.000Z');
  assert.equal(store.getChannel(placeOfChat(store, { id: 'ghost' })), null);
  assert.equal(asRecord(store.getPlace(placeOfRoot(store, 'g1'))).notesFlaggedAt, '2026-10-07T00:00:00.000Z');
});

test('markNotesSampled: reviewed clears the attempt, attempt leaves the review stamp alone', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  store.updateChannel(placeOfChat(store, { id: 'c1' }), { purpose: 'alpha' });
  assert.equal(
    store.markNotesSampled(placeOfRoot(store, 'g1'), placeOfChat(store, { id: 'c1' }), Date.UTC(2026, 9, 7), {
      outcome: 'attempt',
    }),
    true
  );
  assert.equal(store.getChannel(placeOfChat(store, { id: 'c1' }))?.notesAttemptAt, '2026-10-07T00:00:00.000Z');
  assert.equal(store.getChannel(placeOfChat(store, { id: 'c1' }))?.notesSampleReviewedAt, null);
  assert.equal(
    store.markNotesSampled(placeOfRoot(store, 'g1'), placeOfChat(store, { id: 'c1' }), Date.UTC(2026, 9, 8), {
      outcome: 'reviewed',
    }),
    true
  );
  assert.equal(store.getChannel(placeOfChat(store, { id: 'c1' }))?.notesSampleReviewedAt, '2026-10-08T00:00:00.000Z');
  assert.equal(store.getChannel(placeOfChat(store, { id: 'c1' }))?.notesAttemptAt, null);
  assert.equal(
    store.markNotesSampled(placeOfRoot(store, 'g1'), 'place', Date.UTC(2026, 9, 8), { outcome: 'reviewed' }),
    true
  );
  assert.equal(asRecord(store.getPlace(placeOfRoot(store, 'g1'))).notesSampleReviewedAt, '2026-10-08T00:00:00.000Z');
  assert.equal(
    store.markNotesSampled(placeOfRoot(store, 'g1'), 'ghost', Date.UTC(2026, 9, 8), { outcome: 'attempt' }),
    false,
    'an unknown channel writes nothing'
  );
});

test('getPlace: notes stamps a hand edit broke read as never stamped', async () => {
  const { dir, memoryDb } = memDataDir();
  const file = path.join(dir, 'guilds', 'g1', 'guild.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeRaw(file, { patterns: 'μιμίδια', notesUpdatedAt: 'χθες', notesCheckedAt: 1759654800000 });

  const guild = createStore({ dataDir: dir, memoryDb }).getPlace('discord:server:g1');
  assert.deepEqual([asRecord(guild).notesUpdatedAt, asRecord(guild).notesCheckedAt], [null, null]);
  assert.equal(asRecord(guild).patterns, 'μιμίδια');
});

test('writeJsonAtomic: a refused rename falls back to an in-place write, and says so in the log', async () => {
  const dir = tmpDataDir();
  const file = path.join(dir, 'guilds', 'g1', 'guild.json');
  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error('EPERM: operation not permitted');
    Object.assign(err, { code: 'EPERM' });
    throw err;
  };
  let logs;
  try {
    ({ logs } = await withCapturedLogs(() => writeJsonAtomic(file, { patterns: 'μιμίδια' })));
  } finally {
    fs.renameSync = originalRename;
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { patterns: 'μιμίδια' });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['guild.json'], 'no temp file left behind');
  const warning = logs.find((entry) => entry.msg === 'store: rename failed, writing in place');
  assert.ok(warning);
  assert.equal(warning.file, file);
  assert.equal(warning.error.code, 'EPERM');
});

test('flush + a new store instance over the same database: profiles and guild memory survive a "restart"; no memory file is written', async () => {
  const mem = await openTestMemory();
  try {
    const storeA = createStore({ dataDir: mem.dataDir, memoryDb: mem.memoryDb });
    storeA.touchUser(accountOf(storeA, 'u1'), 'Alice', 1000);
    storeA.updateUser(accountOf(storeA, 'u1'), { character: 'τολμηρή' });
    storeA.updatePlace(placeOfRoot(storeA, 'g1'), { patterns: 'μιμίδια' });
    storeA.flush();
    await storeA.flushSettled({});

    const storeB = createStore({ dataDir: mem.dataDir, memoryDb: mem.memoryDb });
    const profile = storeB.getUser(accountOf(storeB, 'u1'));
    assert.equal(asRecord(profile).character, 'τολμηρή');
    assert.deepEqual(asRecord(profile).names, ['Alice']);
    assert.equal(asRecord(storeB.getPlace(placeOfRoot(storeB, 'g1'))).patterns, 'μιμίδια');
    assert.equal(
      fs.existsSync(path.join(mem.dataDir, 'guilds', 'g1', 'users', 'u1.json')),
      false,
      'the profile is a database unit'
    );
    assert.equal(fs.existsSync(path.join(mem.dataDir, 'guilds', 'g1', 'guild.json')), false, 'the guild memory too');
  } finally {
    await mem.close();
    fs.rmSync(mem.dataDir, { recursive: true, force: true });
  }
});

test('flush: only writes the units that are dirty', async () => {
  const { dir, memoryDb } = memDataDir();
  const writes: Array<Untyped> = [];
  // A profile has its own write kind (account-profile.ts): its write is counted under the key of its unit.
  const counted = {
    ...memoryDb,
    writeAccountProfile: (write: AccountProfileWrite) => {
      writes.push(accountCollection('user', write.accountId));
      return memoryDb.writeAccountProfile(write);
    },
  };
  const store = createStore({ dataDir: dir, memoryDb: counted });
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  store.flush();
  await store.flushSettled({});
  assert.deepEqual(writes, [legacyStorageKey('guilds/g1/users/u1.json')]);
  store.flush();
  await store.flushSettled({}); // nothing changed since -> should be a no-op
  assert.deepEqual(writes, [legacyStorageKey('guilds/g1/users/u1.json')]);
});

test('state: data persists across restarts via flush + markDirty', async () => {
  const dir = tmpDataDir();
  const storeA = createStore(memoryAt(dir));
  storeA.state.data.llmDay = '2026-09-20';
  storeA.state.data.llmCount = 5;
  storeA.state.markDirty();
  storeA.flush();
  await storeA.flushSettled({});

  const storeB = createStore(memoryAt(dir));
  assert.equal(storeB.state.data.llmDay, '2026-09-20');
  assert.equal(storeB.state.data.llmCount, 5);
});

test('countUsers: counts a profile not flushed yet, like every other lister', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  store.flush();
  store.touchUser(accountOf(store, 'u2'), 'Zoé', 1000); // only cached
  assert.equal(store.countUsers(), 2);
  assert.equal(store.countUsers(), store.listUserProfiles().length);
});

test('updateUser: cannot overwrite affinity via LLM-extracted fields', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  store.adjustAffinity(accountOf(store, 'u1'), 20, 'liked', { maxDelta: 30, historySize: 10, now: 1000 });

  store.updateUser(accountOf(store, 'u1'), {
    character: 'chatty',
    affinity: { score: -100, reason: 'hostile takeover attempt' },
  });

  const profile = store.getUser(accountOf(store, 'u1'));
  assert.equal(asRecord(profile).character, 'chatty');
  assert.equal(asRecord(profile).affinity.score, 20, 'affinity must survive an updateUser call untouched');
  assert.equal(asRecord(profile).affinity.reason, 'liked');
});

// --- channels (the server map) ----------------------------------------------

test('touchChannel: repeated calls the same UTC day increment the same bucket', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  const facts = { name: 'general', topic: null };
  store.touchChannel(placeOfChat(store, { id: 'c1' }), facts, Date.UTC(2026, 8, 20, 1, 0, 0));
  const channel = store.touchChannel(placeOfChat(store, { id: 'c1' }), facts, Date.UTC(2026, 8, 20, 23, 0, 0));
  assert.equal(asRecord(channel).messageCount, 2);
  assert.deepEqual(asRecord(channel).days, { '2026-09-20': 2 });
});

test('touchChannel: lastMessageAt keeps the maximum timestamp seen, even out of order', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  const facts = { name: 'general', topic: null };
  store.touchChannel(placeOfChat(store, { id: 'c1' }), facts, 5000);
  const channel = store.touchChannel(placeOfChat(store, { id: 'c1' }), facts, 1000); // arrives "late", out of order
  assert.equal(asRecord(channel).lastMessageAt, 5000);
});

test('touchChannel: trims the day histogram to the newest 30 dates', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  const facts = { name: 'general', topic: null };
  let channel;
  for (let day = 0; day < 35; day += 1) {
    channel = store.touchChannel(placeOfChat(store, { id: 'c1' }), facts, Date.UTC(2026, 0, 1 + day, 12, 0, 0));
  }
  const keys = Object.keys(asRecord(channel).days).sort();
  assert.equal(keys.length, 30);
  assert.equal(keys[0], '2026-01-06'); // the oldest 5 days were trimmed
  assert.equal(keys.at(-1), '2026-02-04');
});

test('touchChannel: bumps the author into topWriters and adds up repeated visits', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  const facts = { name: 'general', topic: null };
  store.touchChannel(placeOfChat(store, { id: 'c1' }), facts, 1000, 'alice');
  store.touchChannel(placeOfChat(store, { id: 'c1' }), facts, 2000, 'alice');
  const channel = store.touchChannel(placeOfChat(store, { id: 'c1' }), facts, 3000, 'bob');
  assert.deepEqual(asRecord(channel).topWriters, [
    { id: 'alice', count: 2 },
    { id: 'bob', count: 1 },
  ]);
});

test('updateChannel: the analyzer cannot overwrite counters or Discord facts', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchChannel(placeOfChat(store, { id: 'c1' }), { name: 'general', topic: 'chat' }, 1000);
  store.updateChannel(placeOfChat(store, { id: 'c1' }), {
    purpose: 'chatter',
    name: 'hacked-name',
    messageCount: 999,
    lastMessageAt: 1,
    days: { '2000-01-01': 999 },
  });
  const channel = store.getChannel(placeOfChat(store, { id: 'c1' }));
  assert.equal(channel?.purpose, 'chatter');
  assert.equal(channel?.name, 'general', 'name must survive an updateChannel call untouched');
  assert.equal(channel?.messageCount, 1, 'messageCount must survive an updateChannel call untouched');
  assert.equal(channel?.lastMessageAt, 1000, 'lastMessageAt must survive an updateChannel call untouched');
  assert.deepEqual(channel?.days, { '1970-01-01': 1 }, 'days must survive an updateChannel call untouched');
});

const EARLIER_STAMP = '2000-01-01T00:00:00.000Z';

test('updateChannel: a re-send identical to what is stored leaves updatedAt alone', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  store.touchChannel(placeOfChat(store, { id: 'c1' }), { name: 'general', topic: null }, 1000);
  asRecord(
    store.updateChannel(placeOfChat(store, { id: 'c1' }), {
      purpose: 'chatter',
      topics: 'games',
      tone: 'casual',
    })
  ).updatedAt = EARLIER_STAMP;

  const channel = store.updateChannel(placeOfChat(store, { id: 'c1' }), { purpose: 'chatter', tone: 'casual' });
  assert.equal(asRecord(channel).updatedAt, EARLIER_STAMP);
  assert.equal(
    asRecord(store.updateChannel(placeOfChat(store, { id: 'c1' }), {})).updatedAt,
    EARLIER_STAMP,
    'no field at all is no change either'
  );
});

test('flush + a new store instance: channels survive a "restart"', async () => {
  const { dir, memoryDb } = memDataDir();
  const storeA = createStore({ dataDir: dir, memoryDb });
  storeA.touchChannel(placeOfChat(storeA, { id: 'c1' }), { name: 'general', topic: 'chat' }, 1000);
  storeA.updateChannel(placeOfChat(storeA, { id: 'c1' }), { purpose: 'chatter' });
  storeA.flush();
  await storeA.flushSettled({});

  const storeB = createStore({ dataDir: dir, memoryDb });
  const channel = storeB.getChannel(placeOfChat(storeB, { id: 'c1' }));
  assert.equal(channel?.name, 'general');
  assert.equal(channel?.purpose, 'chatter');
  assert.deepEqual(channel?.days, { '1970-01-01': 1 });
});

// ---- the writers tally behind a channel's topWriters ------------------------

test('touchChannel: a newcomer who keeps writing enters topWriters past five stored writers', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  for (const [i, id] of ['άλφα', 'βήτα', 'γάμα', 'δέλτα', 'έψιλον'].entries())
    writeLines(store, 'c1', id, 1, WRITERS_T0 + i);

  const channel = writeLines(store, 'c1', 'ζήτα', 50, WRITERS_T0 + 1000);

  assert.deepEqual(channel.topWriters[0], { id: 'ζήτα', count: 50 });
  assert.deepEqual(
    channel.topWriters.map((writer: Untyped) => writer.id),
    ['ζήτα', 'έψιλον', 'δέλτα', 'γάμα', 'βήτα'],
    'the five shown, the latest of equals first'
  );
  assert.deepEqual(
    channel.writers['άλφα'],
    { count: 1, last: WRITERS_T0 },
    'the writer who left the five shown keeps a tally'
  );
});

test('touchChannel: a writer silent for 90 days falls below a steady newcomer', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  const pair = (placeId: string, daysLater: number, opts?: Parameters<typeof writeLines>[5]) => {
    writeLines(store, placeId, 'παλιός', 8, WRITERS_T0, opts);
    return writeLines(store, placeId, 'νέος', 3, WRITERS_T0 + daysLater * WRITERS_DAY_MS, opts).topWriters;
  };

  assert.deepEqual(
    pair('c1', 1),
    [
      { id: 'παλιός', count: 8 },
      { id: 'νέος', count: 3 },
    ],
    'a day apart the count decides'
  );
  assert.deepEqual(
    pair('c2', 90),
    [
      { id: 'νέος', count: 3 },
      { id: 'παλιός', count: 8 },
    ],
    'three half-lives of silence outweigh the count'
  );
  assert.deepEqual(
    store.getChannel(placeOfChat(store, { id: 'c2' }))?.writers['παλιός'],
    { count: 8, last: WRITERS_T0 + 7 },
    'ranked lower, not forgotten'
  );
});

test('touchChannel: channelWritersHalfLifeDays is read from the call; 0 ranks by count alone', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  const order = (placeId: string, opts: Parameters<typeof writeLines>[5]) => {
    writeLines(store, placeId, 'παλιός', 8, WRITERS_T0, opts);
    return writeLines(store, placeId, 'νέος', 3, WRITERS_T0 + 90 * WRITERS_DAY_MS, opts).topWriters.map(
      (writer: Untyped) => writer.id
    );
  };

  assert.deepEqual(order('c1', { channelWritersHalfLifeDays: 0 }), ['παλιός', 'νέος']);
  assert.deepEqual(
    order('c2', { channelWritersHalfLifeDays: 365 }),
    ['παλιός', 'νέος'],
    'a quarter of a half-life is not enough'
  );
  assert.deepEqual(order('c3', { channelWritersHalfLifeDays: 30 }), ['νέος', 'παλιός']);
  assert.deepEqual(
    // @ts-expect-error: the test hands a text where a count belongs, as a hand-edited config may
    order('c4', { channelWritersHalfLifeDays: 'μήνας' }),
    ['νέος', 'παλιός'],
    'not a number: the 30 days of config.json'
  );
});

test('touchChannel: the tally keeps channelWritersStored writers, 20 unless told, never fewer than the five shown', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  const stored = (placeId: string, opts?: Parameters<typeof writeLines>[5]) => {
    for (let n = 0; n < 25; n += 1)
      writeLines(store, placeId, `γράφων-${String(n).padStart(2, '0')}`, 1, WRITERS_T0 + n, opts);
    return Object.keys(asRecord(store.getChannel(placeOfChat(store, { id: placeId }))).writers as object).sort();
  };
  const newest = (count: number) =>
    Array.from({ length: count }, (_, i) => `γράφων-${String(25 - count + i).padStart(2, '0')}`);

  assert.deepEqual(stored('c1'), newest(20), 'the lowest-ranked leave: here the ones who wrote longest ago');
  assert.deepEqual(stored('c2', { channelWritersStored: 7 }), newest(7));
  assert.deepEqual(stored('c3', { channelWritersStored: 0 }), newest(5));
  // @ts-expect-error: the test hands a text where a count belongs, as a hand-edited config may
  assert.deepEqual(stored('c4', { channelWritersStored: 'πολλοί' }), newest(20), 'not a number: the 20 of config.json');
  assert.equal(store.getChannel(placeOfChat(store, { id: 'c2' }))?.topWriters.length, 5);
});

test('touchChannel: a writer below the five shown comes back with the count they gathered', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  for (const id of ['άλφα', 'βήτα', 'γάμα', 'δέλτα', 'έψιλον']) writeLines(store, 'c1', id, 3, WRITERS_T0);
  const below = writeLines(store, 'c1', 'ζήτα', 2, WRITERS_T0);
  assert.ok(
    !below.topWriters.some((writer: Untyped) => writer.id === 'ζήτα'),
    'two lines against five writers with three'
  );

  const channel = writeLines(store, 'c1', 'ζήτα', 2, WRITERS_T0 + 10);
  assert.deepEqual(channel.topWriters[0], { id: 'ζήτα', count: 4 });
});

test("touchChannel: a line that arrives late is counted and never moves the writer's last backwards", () => {
  const store = createStore(memoryAt(tmpDataDir()));
  writeLines(store, 'c1', 'άλφα', 1, WRITERS_T0 + 5000);
  const channel = writeLines(store, 'c1', 'άλφα', 1, WRITERS_T0);
  assert.deepEqual(channel.writers, { άλφα: { count: 2, last: WRITERS_T0 + 5000 } });
});

test('touchChannel: a message without an author leaves the tally and topWriters as they are', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  writeLines(store, 'c1', 'άλφα', 2, WRITERS_T0);
  const before = structuredClone(store.getChannel(placeOfChat(store, { id: 'c1' })));

  const channel = store.touchChannel(placeOfChat(store, { id: 'c1' }), AGORA_FACTS, WRITERS_T0 + 10);
  assert.deepEqual([asRecord(channel).writers, asRecord(channel).topWriters], [before?.writers, before?.topWriters]);
  assert.equal(asRecord(channel).messageCount, asRecord(before).messageCount + 1);
});

test('touchChannel: counters never stamp updatedAt, only a change of the notes does', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  writeLines(store, 'c1', 'άλφα', 3, WRITERS_T0);
  assert.equal(store.getChannel(placeOfChat(store, { id: 'c1' }))?.updatedAt, null);
  assert.equal(store.getChannel(placeOfChat(store, { id: 'c1' }))?.notesCheckedAt, null);

  assert.ok(asRecord(store.updateChannel(placeOfChat(store, { id: 'c1' }), { tone: 'ήρεμος' })).updatedAt);
});

test('getChannel: a tally or a check stamp a hand edit broke is made safe to read', async () => {
  const { dir, memoryDb } = memDataDir();
  writeOldChannelFile(dir, 'c1', {
    notesCheckedAt: 7,
    writers: {
      άλφα: { count: 3, last: WRITERS_T0 },
      βήτα: { count: 0, last: WRITERS_T0 },
      γάμα: 'πολύ',
      δέλτα: { count: 2.9, last: 'χθες' },
      έψιλον: { count: 4, last: 1e300 },
    },
  });
  writeOldChannelFile(dir, 'c2', {
    writers: ['άλφα'],
    topWriters: [{ id: 'άλφα', count: 2 }, { id: 'βήτα' }, null, { count: 4 }],
  });
  const store = createStore({ dataDir: dir, memoryDb });

  const channel = store.getChannel(placeOfChat(store, { id: 'c1' }));
  assert.equal(channel?.notesCheckedAt, null);
  assert.deepEqual(channel?.writers, {
    άλφα: { count: 3, last: WRITERS_T0 },
    δέλτα: { count: 2, last: 0 },
    έψιλον: { count: 4, last: 0 },
  });
  assert.deepEqual(
    store.getChannel(placeOfChat(store, { id: 'c2' }))?.writers,
    { άλφα: { count: 2, last: WRITERS_T0 + 5000 } },
    'not a tally: seeded from the usable part of topWriters'
  );
  assert.deepEqual(writeLines(store, 'c1', 'έψιλον', 1, WRITERS_T0 + 6000).topWriters[0], { id: 'έψιλον', count: 5 });
});

test('adjustAffinity: persists across store instances', async () => {
  const { dir, memoryDb } = memDataDir();
  const storeA = createStore({ dataDir: dir, memoryDb });
  storeA.touchUser(accountOf(storeA, 'u1'), 'Alice', 1000);
  storeA.flush();
  await storeA.flushSettled({}); // the profile is on disk and clean: only the adjustment itself can mark it dirty again
  storeA.adjustAffinity(accountOf(storeA, 'u1'), 12, 'nice chat', { maxDelta: 15, historySize: 10, now: 1000 });
  storeA.flush();
  await storeA.flushSettled({});

  const storeB = createStore({ dataDir: dir, memoryDb });
  const affinity = asRecord(storeB.getUser(accountOf(storeB, 'u1'))).affinity;
  assert.equal(affinity.score, 12);
  assert.equal(affinity.reason, 'nice chat');
  assert.equal(affinity.history.length, 1);
});

test('addEpisodes: persists across store instances', async () => {
  const { dir, memoryDb } = memDataDir();
  const storeA = createStore({ dataDir: dir, memoryDb });
  storeA.touchUser(accountOf(storeA, 'u1'), 'Alice', 1000);
  storeA.flush();
  await storeA.flushSettled({}); // the profile is on disk and clean: only the new episode itself can mark it dirty again
  storeA.addEpisodes(accountOf(storeA, 'u1'), [{ what: 'shared a secret', quote: 'do not tell anyone' }], {
    maxEpisodes: 20,
    maxNew: 3,
    now: 1000,
  });
  storeA.flush();
  await storeA.flushSettled({});

  const storeB = createStore({ dataDir: dir, memoryDb });
  const episodes = asRecord(storeB.getUser(accountOf(storeB, 'u1'))).episodes;
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].quote, 'do not tell anyone');
});

test('updateUser: never overwrites episodes even if the field is present in fields', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  store.addEpisodes(accountOf(store, 'u1'), [{ what: 'a real episode' }], { maxEpisodes: 20, maxNew: 3, now: 1000 });

  store.updateUser(accountOf(store, 'u1'), { character: 'nice', episodes: [{ what: 'sneaky overwrite attempt' }] });

  const profile = store.getUser(accountOf(store, 'u1'));
  assert.equal(asRecord(profile).character, 'nice');
  assert.equal(asRecord(profile).episodes.length, 1);
  assert.equal(asRecord(profile).episodes[0].what, 'a real episode');
});

// --- interests / details (applyProfileOps) ----------------------------------

test('getUser: a hand-edited details array missing valid ids gets fresh ones assigned, advancing detailsSeq', async () => {
  const { dir, memoryDb } = memDataDir();
  const guildDir = path.join(dir, 'guilds', 'g1', 'users');
  fs.mkdirSync(guildDir, { recursive: true });
  writeRaw(path.join(guildDir, 'u1.json'), {
    id: 'u1',
    names: ['Alice'],
    details: [{ text: 'Owns a cat' }, { text: 'Plays guitar' }],
  });

  const store = createStore({ dataDir: dir, memoryDb });
  const profile = store.getUser(accountOf(store, 'u1'));
  assert.deepEqual(asRecord(profile).details, [
    { id: 1, text: 'Owns a cat', weight: 1, firstSeen: null, lastSeen: null },
    { id: 2, text: 'Plays guitar', weight: 1, firstSeen: null, lastSeen: null },
  ]);
  assert.equal(asRecord(profile).detailsSeq, 3);
});

test('applyProfileOps: a detail id is never reused after a remove', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  store.applyProfileOps(accountOf(store, 'u1'), { details: { add: ['a', 'b'] } }, { maxDetails: 15, now: 1000 });
  store.applyProfileOps(accountOf(store, 'u1'), { details: { remove: [1] } }, { maxDetails: 15, now: 2000 });
  const profile = store.applyProfileOps(
    accountOf(store, 'u1'),
    { details: { add: ['c'] } },
    { maxDetails: 15, now: 3000 }
  );
  assert.deepEqual(
    asRecord(profile).details.map((d: Untyped) => d.id),
    [2, 3]
  );
});

test('applyProfileOps: opts.seenAt (not opts.now) dates interests/details, and drives the confirmGapHours bump', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  const seenAt1 = Date.UTC(2020, 0, 1);
  store.applyProfileOps(
    accountOf(store, 'u1'),
    { interests: { add: [{ topic: 'Chess', note: '' }] } },
    {
      maxInterests: 12,
      topicChars: 40,
      noteChars: 120,
      confirmGapHours: 12,
      now: 999_999_999_999, // a very different wall-clock "now"
      seenAt: seenAt1,
    }
  );
  let profile = store.getUser(accountOf(store, 'u1'));
  assert.equal(asRecord(profile).interests[0].firstSeen, new Date(seenAt1).toISOString(), 'dated by seenAt, not now');

  const seenAt2 = seenAt1 + 13 * 3_600_000; // past the 12h gap
  profile = store.applyProfileOps(
    accountOf(store, 'u1'),
    { interests: { seen: ['Chess'] } },
    {
      maxInterests: 12,
      topicChars: 40,
      noteChars: 120,
      confirmGapHours: 12,
      now: 1,
      seenAt: seenAt2,
    }
  );
  assert.equal(asRecord(profile).interests[0].weight, 2);
  assert.equal(asRecord(profile).interests[0].lastSeen, new Date(seenAt2).toISOString());
});

test('applyProfileOps: sets character/style/relationship only when given as non-empty strings', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  store.applyProfileOps(
    accountOf(store, 'u1'),
    { character: 'chatty', style: 'blunt' },
    { fieldChars: 400, now: 1000 }
  );

  const profile = store.applyProfileOps(
    accountOf(store, 'u1'),
    { style: '', relationship: 'trusts you' },
    { fieldChars: 400, now: 2000 }
  );
  assert.equal(asRecord(profile).character, 'chatty', 'untouched: absent from this call');
  assert.equal(asRecord(profile).style, 'blunt', 'untouched: empty string never blanks it');
  assert.equal(asRecord(profile).relationship, 'trusts you');
});

test('applyProfileOps: a first write of a prose field is clamped tolerantly to opts.fieldChars; a rewrite is never cut', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  const profile = store.applyProfileOps(
    accountOf(store, 'u1'),
    { character: '0123456789' },
    { fieldChars: 5, now: 1000 }
  );
  assert.equal(asRecord(profile).character, '012345', '5 * the default tolerance 1.25, floored');
  // A rewrite over the limit is the caller's to refuse (src/memory/prose.ts#acceptProse): the store
  // stores what it is given and never cuts it.
  const rewritten = store.applyProfileOps(
    accountOf(store, 'u1'),
    { character: '0123456789abcdef' },
    { fieldChars: 5, now: 2000 }
  );
  assert.equal(asRecord(rewritten).character, '0123456789abcdef');
});

test('applyProfileOps: normalizes a hand-edited interests array before applying ops', async () => {
  const { dir, memoryDb } = memDataDir();
  const guildDir = path.join(dir, 'guilds', 'g1', 'users');
  fs.mkdirSync(guildDir, { recursive: true });
  writeRaw(path.join(guildDir, 'u1.json'), {
    id: 'u1',
    names: ['Alice'],
    interests: [{ topic: 'Chess' }, { topic: 'Anime' }],
  });

  const store = createStore({ dataDir: dir, memoryDb });
  const profile = store.applyProfileOps(
    accountOf(store, 'u1'),
    { interests: { add: [{ topic: 'Cooking', note: '' }] } },
    {
      maxInterests: 12,
      topicChars: 40,
      noteChars: 120,
      now: 1000,
    }
  );
  assert.deepEqual(
    asRecord(profile).interests.map((i: Untyped) => i.topic),
    ['Chess', 'Anime', 'Cooking']
  );
});

test('applyProfileOps: details add is de-duplicated case-insensitively (a sighting on the existing item), remove is exact-text', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  store.applyProfileOps(
    accountOf(store, 'u1'),
    { details: { add: ['Owns a cat', 'Plays guitar'] } },
    { maxDetails: 15, now: 1000 }
  );
  const profile = store.applyProfileOps(
    accountOf(store, 'u1'),
    { details: { add: ['owns a cat', 'Reads sci-fi'], remove: ['Plays guitar'] } },
    {
      maxDetails: 15,
      now: 2000,
    }
  );
  assert.deepEqual(
    asRecord(profile).details.map((d: Untyped) => d.text),
    ['Owns a cat', 'Reads sci-fi']
  );
  assert.equal(asRecord(profile).details[0].weight, 1, 'the re-add landed inside the default confirmGapHours, no bump');
});

test('applyProfileOps: details are capped at maxDetails, evicting the lowest weight (then oldest) first', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  const profile = store.applyProfileOps(
    accountOf(store, 'u1'),
    { details: { add: ['a', 'b', 'c'] } },
    { maxDetails: 2, now: 1000 }
  );
  assert.deepEqual(
    asRecord(profile).details.map((d: Untyped) => d.text),
    ['b', 'c']
  );
});

test('applyProfileOps: threads interestHalfLifeDays into applyInterestOps -- decay lets a recent light interest survive eviction over an ancient heavier one', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  const ancientMs = Date.parse('2021-01-01T00:00:00.000Z');
  store.applyProfileOps(
    accountOf(store, 'u1'),
    { interests: { add: [{ topic: 'Ancient favorite' }] } },
    {
      maxInterests: 5,
      maxInterestsStored: 5,
      topicChars: 40,
      noteChars: 120,
      seenAt: ancientMs,
      now: ancientMs,
    }
  );
  store.applyProfileOps(
    accountOf(store, 'u1'),
    { interests: { seen: ['Ancient favorite'] } },
    {
      maxInterests: 5,
      maxInterestsStored: 5,
      topicChars: 40,
      noteChars: 120,
      seenAt: ancientMs + 13 * 3_600_000,
      now: ancientMs,
    }
  );

  const recentMs = Date.parse('2026-09-20T00:00:00.000Z');
  const profile = store.applyProfileOps(
    accountOf(store, 'u1'),
    { interests: { add: [{ topic: 'Fresh interest' }] } },
    {
      maxInterests: 1,
      maxInterestsStored: 1, // force an eviction down to a single stored interest
      topicChars: 40,
      noteChars: 120,
      interestHalfLifeDays: 30,
      seenAt: recentMs,
      now: recentMs,
    }
  );
  assert.deepEqual(
    asRecord(profile).interests.map((i: Untyped) => i.topic),
    ['Fresh interest'],
    'years of silence outrank the ancient item, higher weight or not'
  );
});

test('applyProfileOps: threads detailHalfLifeDays into applyDetailOps -- decay lets a recent light detail survive eviction over an ancient heavier one', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  const ancientMs = Date.parse('2021-01-01T00:00:00.000Z');
  store.applyProfileOps(
    accountOf(store, 'u1'),
    { details: { add: [{ text: 'Ancient favorite fact' }] } },
    { maxDetails: 5, maxDetailsStored: 5, seenAt: ancientMs, now: ancientMs }
  );
  // Bump the ancient detail's weight a bit, well past confirmGapHours, so it
  // starts heavier than the newcomer added below.
  store.applyProfileOps(
    accountOf(store, 'u1'),
    { details: { seen: ['Ancient favorite fact'] } },
    { maxDetails: 5, maxDetailsStored: 5, seenAt: ancientMs + 13 * 3_600_000, now: ancientMs }
  );

  const recentMs = Date.parse('2026-09-20T00:00:00.000Z');
  const profile = store.applyProfileOps(
    accountOf(store, 'u1'),
    { details: { add: [{ text: 'Fresh detail' }] } },
    {
      maxDetails: 1,
      maxDetailsStored: 1, // force an eviction down to a single stored detail
      detailHalfLifeDays: 30,
      seenAt: recentMs,
      now: recentMs,
    }
  );
  assert.deepEqual(
    asRecord(profile).details.map((d: Untyped) => d.text),
    ['Fresh detail'],
    'years of silence outrank the ancient item, higher weight or not'
  );
});

test('applyProfileOps: tolerates garbage ops without throwing, leaves the profile unchanged', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  for (const garbage of [null, undefined, 'not an object', 42, { interests: 'nope', details: 5 }]) {
    assert.doesNotThrow(() =>
      store.applyProfileOps(accountOf(store, 'u1'), garbage as unknown as Parameters<typeof store.applyProfileOps>[1], {
        now: 1000,
      })
    );
  }
  const profile = store.getUser(accountOf(store, 'u1'));
  assert.deepEqual(asRecord(profile).interests, []);
  assert.deepEqual(asRecord(profile).details, []);
});

test('applyProfileOps: persists across store instances', async () => {
  const { dir, memoryDb } = memDataDir();
  const guildDir = path.join(dir, 'guilds', 'g1', 'users');
  fs.mkdirSync(guildDir, { recursive: true });
  writeRaw(path.join(guildDir, 'u1.json'), {
    id: 'u1',
    names: ['Alice'],
    interests: [{ topic: 'Chess', note: 'weekly club', weight: 1, firstSeen: null, lastSeen: null }],
  });

  const storeA = createStore({ dataDir: dir, memoryDb });
  storeA.applyProfileOps(
    accountOf(storeA, 'u1'),
    { interests: { add: [{ topic: 'Anime', note: '' }] }, details: { add: ['owns a cat'] } },
    {
      maxInterests: 12,
      topicChars: 40,
      noteChars: 120,
      maxDetails: 15,
      now: 1000,
    }
  );
  storeA.flush();
  await storeA.flushSettled({});

  const storeB = createStore({ dataDir: dir, memoryDb });
  const profile = storeB.getUser(accountOf(storeB, 'u1'));
  assert.deepEqual(
    asRecord(profile).interests.map((i: Untyped) => i.topic),
    ['Chess', 'Anime']
  );
  assert.deepEqual(
    asRecord(profile).details.map((d: Untyped) => d.text),
    ['owns a cat']
  );
});

// --- lore -----------------------------------------------------------------

test('setLore: an owner entry is never overwritten by a later analyzer update', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.setLore(
    placeOfRoot(store, 'g1'),
    [{ title: 'Founders Day', keys: ['founders'], text: 'owner text', always: true }],
    {
      source: 'owner',
      now: 1000,
    }
  );

  store.setLore(
    placeOfRoot(store, 'g1'),
    [{ title: 'Founders Day', keys: ['founders'], text: 'analyzer tries to change this' }],
    {
      source: 'analyzer',
      now: 2000,
    }
  );

  const entries = store.getLore(placeOfRoot(store, 'g1'));
  assert.equal(entries.length, 1);
  assert.equal(asRecord(entries[0]).text, 'owner text');
  assert.equal(asRecord(entries[0]).source, 'owner');
});

test('setLore: an identical analyzer re-send returns 0 and keeps updatedAt; a changed text returns 1', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  const flood = { title: 'The Flood', keys: ['flood'], text: 'It flooded once.' };
  store.setLore(placeOfRoot(store, 'g1'), [flood], { source: 'analyzer', now: 1000 });

  assert.equal(store.setLore(placeOfRoot(store, 'g1'), [flood], { source: 'analyzer', now: 2000 }), 0);
  assert.equal(asRecord(store.getLore(placeOfRoot(store, 'g1'))[0]).updatedAt, new Date(1000).toISOString());

  assert.equal(
    store.setLore(placeOfRoot(store, 'g1'), [{ ...flood, text: 'It flooded twice.' }], {
      source: 'analyzer',
      now: 3000,
    }),
    1
  );
  assert.equal(asRecord(store.getLore(placeOfRoot(store, 'g1'))[0]).updatedAt, new Date(3000).toISOString());
});

test('lore: persists across store instances', async () => {
  const { dir, memoryDb } = memDataDir();
  const storeA = createStore({ dataDir: dir, memoryDb });
  storeA.setLore(placeOfRoot(storeA, 'g1'), [{ title: 'The Flood', keys: ['flood'], text: 'It flooded once.' }], {
    source: 'analyzer',
    now: 1000,
  });
  storeA.flush();
  await storeA.flushSettled({});

  const storeB = createStore({ dataDir: dir, memoryDb });
  const entries = storeB.getLore(placeOfRoot(storeB, 'g1'));
  assert.equal(entries.length, 1);
  assert.equal(asRecord(entries[0]).title, 'The Flood');
});

test('applyProfileOps: routes users.aliases ops through applyAliasOps, threading maxAliases/maxAliasesStored/aliasHalfLifeDays', () => {
  const freshStore = () => {
    const store = createStore(memoryAt(tmpDataDir()));
    store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
    return store;
  };
  const addAliases = (store: Untyped, names: unknown, opts: unknown) =>
    store.applyProfileOps(accountOf(store, 'u1'), { aliases: { add: names } }, opts);

  const profile = addAliases(freshStore(), ['Ali'], {
    maxAliases: 5,
    maxAliasesStored: 15,
    aliasHalfLifeDays: 365,
    now: 1000,
  });
  assert.equal(profile.aliases.length, 1);
  assert.equal(profile.aliases[0].name, 'Ali');
  assert.equal(profile.aliases[0].weight, 1);

  // maxAliasesStored: a stored cap above the shown cap is the one enforced.
  const stored = addAliases(freshStore(), ['Ali', 'Λίζα', 'Zoé', 'Élise'], {
    maxAliases: 1,
    maxAliasesStored: 3,
    now: 1000,
  });
  assert.equal(stored.aliases.length, 3, 'maxAliasesStored (3) reached the eviction, not only maxAliases (1)');

  // maxAliases: a stored cap below the shown cap is floored at the shown cap.
  const shown = addAliases(freshStore(), ['Ali', 'Λίζα', 'Zoé'], { maxAliases: 3, maxAliasesStored: 1, now: 1000 });
  assert.equal(shown.aliases.length, 3, 'maxAliases (3) reached the eviction and floors the stored cap (1)');

  // aliasHalfLifeDays: decay lets a recent light alias outlive an ancient heavier one.
  const decaying = freshStore();
  const ancientMs = Date.parse('2021-01-01T00:00:00.000Z');
  addAliases(decaying, ['Λίζα'], { confirmGapHours: 12, seenAt: ancientMs, now: ancientMs });
  const before = addAliases(decaying, ['Λίζα'], {
    confirmGapHours: 12,
    seenAt: ancientMs + 13 * 3_600_000,
    now: ancientMs,
  });
  assert.equal(before.aliases[0].weight, 2, 'the ancient alias starts heavier than the newcomer');
  const recentMs = Date.parse('2026-09-20T00:00:00.000Z');
  const decayed = addAliases(decaying, ['Zoé'], {
    maxAliases: 1,
    maxAliasesStored: 1,
    aliasHalfLifeDays: 30,
    seenAt: recentMs,
    now: recentMs,
  });
  assert.deepEqual(
    decayed.aliases.map((a: Untyped) => a.name),
    ['Zoé'],
    'years of silence outrank the ancient alias, higher weight or not'
  );
});

test("applyProfileOps: an alias equal (case-insensitively) to the member's OWN stored display name is never added", () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);

  const profile = store.applyProfileOps(accountOf(store, 'u1'), { aliases: { add: ['alice'] } }, { now: 1000 });
  assert.deepEqual(asRecord(profile).aliases, []);
});

// --- listUserProfiles -----------------------------------------------------------

test('listUserProfiles: every stored profile of a guild, cached or on disk', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  store.touchUser(accountOf(store, 'u2'), 'Bob', 1000);
  store.flush();
  await store.flushSettled({});

  const storeB = createStore({ dataDir: dir, memoryDb });
  storeB.touchUser(accountOf(storeB, 'u3'), 'Carl', 1000); // cached only, not yet flushed

  const profiles = storeB.listUserProfiles();
  assert.deepEqual(profiles.map((p) => asRecord(p).id).sort(), ['u1', 'u2', 'u3']);
});

// --- dropCaches / reloadState / validate (/nep pause, /nep resume) ------------

test('dropCaches: forgets every cached unit except state.json, so the next read is a fresh database read', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  store.updatePlace(placeOfRoot(store, 'g1'), { patterns: 'x' });
  store.state.data.llmCount = 3;
  store.state.markDirty();
  store.flush();
  await store.flushSettled({});

  // The expectation on the drop's count went: the store keeps no unit once its write landed, so the drop has nothing
  // to count. The read below is what the pause needs.
  store.dropCaches();

  // A hand-edit made right after the drop is picked up on the very next read.
  writeRaw(path.join(dir, 'guilds', 'g1', 'users', 'u1.json'), {
    id: 'u1',
    names: ['Edited'],
    firstSeen: null,
    lastSeen: null,
    messageCount: 0,
  });
  const profile = store.getUser(accountOf(store, 'u1'));
  assert.equal(asRecord(profile).names[0], 'Edited');

  // state.json itself was NOT dropped -- still the in-memory value.
  assert.equal(store.state.data.llmCount, 3);
});

test('reloadState: re-reads the stored state, discarding the cached in-memory value', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  store.state.data.llmCount = 1;
  store.state.markDirty();
  store.flush();
  await store.flushSettled({});

  // A hand edit of the stored state, made while paused.
  await writeUnitUpdate(memoryDb, {
    op: 'value',
    key: personaKey('state'),
    value: { llmCount: 99, job: { done: false } },
  });

  assert.equal(store.state.data.llmCount, 1, 'still the stale cached value before reloadState');
  store.reloadState();
  assert.equal(store.state.data.llmCount, 99);
  assert.deepEqual(store.state.data.job, { done: false });
});

test('validate: names every unparsable operational *.json file, path relative to dataDir and forward-slash separated', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  store.flush();
  await store.flushSettled({});
  fs.mkdirSync(path.join(dir, 'places', 'g1', 'users'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'places', 'g1', 'users', 'u1.json'), '{ not json');
  fs.writeFileSync(path.join(dir, 'places', 'g1', 'inner.json'), '{ not json either');
  fs.writeFileSync(path.join(dir, 'state.json'), '{ also not json');
  // Database-backed state files are retired. Operational guild aliases still require file validation.
  fs.writeFileSync(path.join(dir, 'places', 'g1', 'usage.json'), '{ malformed operational usage');
  fs.writeFileSync(path.join(dir, 'places', 'g1', 'metrics.json'), '{ malformed operational metrics');
  assert.deepEqual(
    store.validate().sort(),
    ['places/g1/metrics.json', 'places/g1/usage.json'],
    'database-authoritative paths are ignored while malformed operational files remain visible'
  );
});

// --- private memory layer (data/guilds/<id>/private/<accountId>.json) -----------

const EMPTY_PRIVATE = {
  relationship: '',
  interests: [],
  details: [],
  detailsSeq: 1,
  episodes: [],
  affinity: { score: 0, reason: '', history: [] },
  firstSeen: '',
  lastSeen: '',
  buffer: [],
};

function privateFile(dir: string, placeId: string, accountId: string) {
  return path.join(dir, 'guilds', placeId, 'private', `${accountId}.json`);
}

test('getPrivate: null when no private file exists, and nothing is created', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  assert.equal(store.getPrivate(accountOf(store, 'u1')), null);
  store.flush();
  assert.equal(fs.existsSync(privateFile(dir, 'g1', 'u1')), false);
  assert.deepEqual(store.listPrivate(), []);
});

test('applyPrivateOps: a first private write creates the empty shape, persists it on flush and survives a restart', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  assert.deepEqual(store.applyPrivateOps(accountOf(store, 'u1'), {}), EMPTY_PRIVATE);
  store.flush();
  await store.flushSettled({});
  assert.equal(existsRaw(privateFile(dir, 'g1', 'u1')), true);

  const storeB = createStore({ dataDir: dir, memoryDb });
  assert.deepEqual(storeB.getPrivate(accountOf(storeB, 'u1')), EMPTY_PRIVATE);
  assert.deepEqual(storeB.listPrivate(), ['discord:u1']);
});

test('getPrivate: a hand-edited file is normalised on read: defaults filled, detail ids assigned', async () => {
  const { dir, memoryDb } = memDataDir();
  const file = privateFile(dir, 'g1', 'u1');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeRaw(file, {
    relationship: 'Κάτι μυστικό',
    interests: 'not a list',
    details: [{ text: 'Owns a cat' }, { text: 'Plays guitar' }],
    affinity: { score: 12 },
    replies: { day: '2026-09-29' },
    buffer: 'garbage',
    episodes: null,
  });

  const store = createStore({ dataDir: dir, memoryDb });
  const priv = store.getPrivate(accountOf(store, 'u1'));
  assert.equal(asRecord(priv).relationship, 'Κάτι μυστικό');
  assert.deepEqual(asRecord(priv).interests, []);
  assert.deepEqual(asRecord(priv).details, [
    { id: 1, text: 'Owns a cat', weight: 1, firstSeen: null, lastSeen: null },
    { id: 2, text: 'Plays guitar', weight: 1, firstSeen: null, lastSeen: null },
  ]);
  assert.equal(asRecord(priv).detailsSeq, 3);
  assert.deepEqual(asRecord(priv).affinity, { score: 12, reason: '', history: [] });
  assert.equal(asRecord(priv).replies, undefined, 'a stored replies field nothing reads is dropped');
  assert.deepEqual(asRecord(priv).buffer, []);
  assert.deepEqual(asRecord(priv).episodes, []);
  assert.equal(asRecord(priv).firstSeen, '');
  assert.equal(asRecord(priv).lastSeen, '');
});

test('applyPrivateOps: relationship, interests and details land in the private file; character/style/aliases/portrait are ignored', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  const priv = store.applyPrivateOps(
    accountOf(store, 'u1'),
    {
      relationship: 'Confides in the persona',
      character: 'should not land',
      style: 'should not land',
      aliases: { add: ['Ally'] },
      portrait: 'should not land',
      interests: { add: [{ topic: 'Chess', note: 'plays weekly' }] },
      details: { add: ['Owns a cat', 'Plays guitar'] },
    } as unknown as Parameters<typeof store.applyPrivateOps>[1],
    { fieldChars: 300, maxInterests: 12, topicChars: 40, noteChars: 120, maxDetails: 15, now: 1000 }
  );

  assert.equal(asRecord(priv).relationship, 'Confides in the persona');
  assert.equal(asRecord(priv).interests.length, 1);
  assert.equal(asRecord(priv).interests[0].topic, 'Chess');
  assert.deepEqual(
    asRecord(priv).details.map((d: Untyped) => d.id),
    [1, 2]
  );
  assert.equal(asRecord(priv).detailsSeq, 3);
  for (const key of ['character', 'style', 'aliases', 'portrait']) assert.equal(key in priv, false, key);

  // the public profile is never touched by private ops
  const pub = store.getUser(accountOf(store, 'u1'));
  assert.equal(asRecord(pub).relationship, '');
  assert.deepEqual(asRecord(pub).interests, []);
  assert.deepEqual(asRecord(pub).details, []);
  assert.deepEqual(asRecord(pub).aliases, []);

  store.flush();
  await store.flushSettled({});
  const storeB = createStore({ dataDir: dir, memoryDb });
  assert.equal(asRecord(storeB.getPrivate(accountOf(storeB, 'u1'))).relationship, 'Confides in the persona');
});

test('applyPrivateOps: an empty relationship never blanks the stored one; garbage ops never throw', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.applyPrivateOps(accountOf(store, 'u1'), { relationship: 'Old friend' }, { fieldChars: 300 });
  store.applyPrivateOps(accountOf(store, 'u1'), { relationship: '   ' }, { fieldChars: 300 });
  assert.doesNotThrow(() =>
    store.applyPrivateOps(accountOf(store, 'u1'), null as unknown as Parameters<typeof store.applyPrivateOps>[1], {})
  );
  assert.doesNotThrow(() =>
    store.applyPrivateOps(accountOf(store, 'u1'), { interests: [], details: 'x' } as unknown as Parameters<
      typeof store.applyPrivateOps
    >[1])
  );
  assert.equal(asRecord(store.getPrivate(accountOf(store, 'u1'))).relationship, 'Old friend');
});

test('adjustPrivateAffinity: starts at 0, clamps the delta and the score, never touches the public affinity', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  store.adjustAffinity(accountOf(store, 'u1'), 4, 'public reason', { maxDelta: 5, historySize: 5, now: 1000 });

  const first = store.adjustPrivateAffinity(accountOf(store, 'u1'), 50, 'shared a secret', {
    maxDelta: 5,
    historySize: 5,
    now: 2000,
  });
  assert.equal(first.score, 5);
  assert.equal(first.reason, 'shared a secret');
  assert.equal(first.history.length, 1);

  let last;
  for (let i = 0; i < 30; i += 1) {
    last = store.adjustPrivateAffinity(accountOf(store, 'u1'), 5, 'again', {
      maxDelta: 5,
      historySize: 5,
      now: 3000 + i,
    });
  }
  assert.equal(last?.score, 100);
  assert.equal(last?.history.length, 5);
  assert.deepEqual(asRecord(store.getPrivate(accountOf(store, 'u1'))).affinity, last);

  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).affinity.score, 4);
});

test('addPrivateEpisodes: appends via mergeEpisodes to the private file only', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Alice', 1000);
  const added = store.addPrivateEpisodes(accountOf(store, 'u1'), [{ what: 'told the persona a secret' }], {
    maxEpisodes: 20,
    maxNew: 3,
    now: 1000,
  });
  assert.equal(added, 1);
  assert.equal(asRecord(store.getPrivate(accountOf(store, 'u1'))).episodes[0].what, 'told the persona a secret');
  assert.deepEqual(asRecord(store.getUser(accountOf(store, 'u1'))).episodes, []);
  assert.equal(store.addPrivateEpisodes(accountOf(store, 'u1'), [], { maxEpisodes: 20, now: 2000 }), 0);
});

test('touchPrivateSeen: stamps lastSeen every time, firstSeen only while empty; never touches the public profile', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  store.touchUser(accountOf(store, 'u1'), 'Zoé', 500);
  store.touchPrivateSeen(accountOf(store, 'u1'), Date.UTC(2026, 0, 1));
  store.touchPrivateSeen(accountOf(store, 'u1'), Date.UTC(2026, 0, 5));
  store.flush();
  await store.flushSettled({});
  const priv = createStore({ dataDir: dir, memoryDb }).getPrivate(accountOf(store, 'u1'));
  assert.equal(asRecord(priv).firstSeen, new Date(Date.UTC(2026, 0, 1)).toISOString());
  assert.equal(asRecord(priv).lastSeen, new Date(Date.UTC(2026, 0, 5)).toISOString());
  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).lastSeen, new Date(500).toISOString());
});

// --- affinity decay sweep and relationshipScore -------------------------------

const DECAY_DAY_MS = 24 * 60 * 60 * 1000;
const DECAY_NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const DECAY_CFG = { decayPerDay: 0.04, decayPower: 1 };

function userFileOf(dir: string, placeId: string, accountId: string) {
  return path.join(dir, 'guilds', placeId, 'users', `${accountId}.json`);
}

test('decayAffinities: decays public and private profiles, marks only the changed ones dirty', async () => {
  const { dir, memoryDb } = memDataDir();
  const dayAgo = new Date(DECAY_NOW - DECAY_DAY_MS).toISOString();
  const hourAgo = new Date(DECAY_NOW - 3600_000).toISOString();
  writeRaw(userFileOf(dir, 'g1', 'u1'), {
    id: 'u1',
    names: ['Zoé'],
    affinity: { score: 100, reason: 'r', history: [], decayedAt: dayAgo },
  });
  writeRaw(userFileOf(dir, 'g1', 'u2'), {
    id: 'u2',
    names: ['Ἄννα'],
    affinity: { score: 50, reason: '', history: [], decayedAt: hourAgo },
  });
  writeRaw(privateFile(dir, 'g1', 'u1'), {
    relationship: '',
    affinity: { score: -64, reason: '', history: [], decayedAt: dayAgo },
  });
  const untouchedRaw = readRaw(userFileOf(dir, 'g1', 'u2'));

  const store = createStore({ dataDir: dir, memoryDb });
  const counts = store.decayAffinities(DECAY_NOW, DECAY_CFG);
  assert.deepEqual(counts, { profiles: 3, decayed: 2 });
  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).affinity.score, 96);
  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).affinity.decayedAt, new Date(DECAY_NOW).toISOString());
  assert.equal(asRecord(store.getPrivate(accountOf(store, 'u1'))).affinity.score, -62.36);
  assert.equal(asRecord(store.getUser(accountOf(store, 'u2'))).affinity.score, 50);

  store.flush();
  await store.flushSettled({});
  assert.equal(readRaw(userFileOf(dir, 'g1', 'u2')), untouchedRaw, 'an unchanged profile is not rewritten');
  const storeB = createStore({ dataDir: dir, memoryDb });
  assert.equal(
    asRecord(storeB.getUser(accountOf(storeB, 'u1'))).affinity.score,
    96,
    'the decayed public score was flushed'
  );
  assert.equal(
    asRecord(storeB.getPrivate(accountOf(storeB, 'u1'))).affinity.score,
    -62.36,
    'the decayed private score was flushed'
  );
});

test('decayAffinities: the first sweep only stamps the baseline -- persisted, but nothing counts as decayed', async () => {
  const { dir, memoryDb } = memDataDir();
  writeRaw(userFileOf(dir, 'g1', 'u1'), { id: 'u1', names: ['Zoé'], affinity: { score: 80, reason: '', history: [] } });
  writeRaw(privateFile(dir, 'g1', 'u1'), { relationship: '', affinity: { score: 20, reason: '', history: [] } });

  const store = createStore({ dataDir: dir, memoryDb });
  assert.deepEqual(store.decayAffinities(DECAY_NOW, DECAY_CFG), { profiles: 2, decayed: 0 });
  store.flush();
  await store.flushSettled({});

  const storeB = createStore({ dataDir: dir, memoryDb });
  assert.equal(asRecord(storeB.getUser(accountOf(storeB, 'u1'))).affinity.score, 80);
  assert.equal(asRecord(storeB.getUser(accountOf(storeB, 'u1'))).affinity.decayedAt, new Date(DECAY_NOW).toISOString());
  assert.equal(
    asRecord(storeB.getPrivate(accountOf(storeB, 'u1'))).affinity.decayedAt,
    new Date(DECAY_NOW).toISOString()
  );
  assert.deepEqual(storeB.decayAffinities(DECAY_NOW + DECAY_DAY_MS, DECAY_CFG), { profiles: 2, decayed: 2 });
});

test('decayAffinities: decay off writes nothing; no profiles -> zero counts', async () => {
  const { dir, memoryDb } = memDataDir();
  writeRaw(userFileOf(dir, 'g1', 'u1'), { id: 'u1', affinity: { score: 80, reason: '', history: [] } });
  const raw = readRaw(userFileOf(dir, 'g1', 'u1'));
  const store = createStore({ dataDir: dir, memoryDb });
  assert.deepEqual(store.decayAffinities(DECAY_NOW, { decayPerDay: 0 }), { profiles: 1, decayed: 0 });
  store.flush();
  await store.flushSettled({});
  assert.equal(readRaw(userFileOf(dir, 'g1', 'u1')), raw);
  // Profiles are the persona's now: a store with none is another database.
  assert.deepEqual(createStore(memoryAt(tmpDataDir())).decayAffinities(DECAY_NOW, DECAY_CFG), {
    profiles: 0,
    decayed: 0,
  });
});

test('adjustAffinity / adjustPrivateAffinity: keep decayedAt when they fold a delta', async () => {
  const { dir, memoryDb } = memDataDir();
  const stamp = new Date(DECAY_NOW).toISOString();
  writeRaw(userFileOf(dir, 'g1', 'u1'), {
    id: 'u1',
    affinity: { score: 10, reason: '', history: [], decayedAt: stamp },
  });
  writeRaw(privateFile(dir, 'g1', 'u1'), { affinity: { score: 10, reason: '', history: [], decayedAt: stamp } });
  const store = createStore({ dataDir: dir, memoryDb });
  assert.equal(
    asRecord(store.adjustAffinity(accountOf(store, 'u1'), 5, 'x', { maxDelta: 15, historySize: 10, now: DECAY_NOW }))
      ?.decayedAt,
    stamp
  );
  assert.equal(
    asRecord(
      store.adjustPrivateAffinity(accountOf(store, 'u1'), 5, 'x', { maxDelta: 15, historySize: 10, now: DECAY_NOW })
    ).decayedAt,
    stamp
  );
  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).affinity.decayedAt, stamp);
  assert.equal(asRecord(store.getPrivate(accountOf(store, 'u1'))).affinity.decayedAt, stamp);
});

test('normalisation on read keeps decayedAt and relationshipScore, public and private', async () => {
  const { dir, memoryDb } = memDataDir();
  const stamp = new Date(DECAY_NOW).toISOString();
  writeRaw(userFileOf(dir, 'g1', 'u1'), {
    id: 'u1',
    relationship: 'x',
    relationshipScore: 42,
    affinity: { score: 10, reason: '', history: [], decayedAt: stamp },
  });
  writeRaw(privateFile(dir, 'g1', 'u1'), {
    relationship: 'y',
    relationshipScore: -9,
    affinity: { score: 10, decayedAt: stamp },
  });
  const store = createStore({ dataDir: dir, memoryDb });
  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).relationshipScore, 42);
  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).affinity.decayedAt, stamp);
  assert.equal(asRecord(store.getPrivate(accountOf(store, 'u1'))).relationshipScore, -9);
  assert.equal(asRecord(store.getPrivate(accountOf(store, 'u1'))).affinity.decayedAt, stamp);
});

test('applyProfileOps: stamps relationshipScore when the relationship text is written, not otherwise', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Zoé', 1000);
  store.adjustAffinity(accountOf(store, 'u1'), 30, 'x', { maxDelta: 30, historySize: 10, now: 1000 });

  store.applyProfileOps(accountOf(store, 'u1'), { character: 'calm', relationship: '  ' }, { fieldChars: 400 });
  assert.equal(
    asRecord(store.getUser(accountOf(store, 'u1'))).relationshipScore,
    undefined,
    'a blank relationship writes nothing'
  );

  store.applyProfileOps(accountOf(store, 'u1'), { relationship: 'Close friends' }, { fieldChars: 400 });
  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).relationshipScore, 30, 'falls back to the stored score');

  store.applyProfileOps(
    accountOf(store, 'u1'),
    { relationship: 'Closer still' },
    { fieldChars: 400, relationshipScore: 44.5 }
  );
  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).relationshipScore, 44.5, 'opts.relationshipScore wins');

  store.applyProfileOps(
    accountOf(store, 'u1'),
    { details: { add: ['owns a cat'] } },
    { fieldChars: 400, relationshipScore: 99 }
  );
  assert.equal(
    asRecord(store.getUser(accountOf(store, 'u1'))).relationshipScore,
    44.5,
    'no relationship text -> untouched'
  );
});

test('applyPrivateOps: stamps relationshipScore when the private relationship text is written, not otherwise', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.adjustPrivateAffinity(accountOf(store, 'u1'), 12, 'x', { maxDelta: 15, historySize: 10, now: 1000 });

  store.applyPrivateOps(
    accountOf(store, 'u1'),
    { details: { add: ['a secret'] } },
    { fieldChars: 400, relationshipScore: 50 }
  );
  assert.equal(asRecord(store.getPrivate(accountOf(store, 'u1'))).relationshipScore, undefined);

  store.applyPrivateOps(accountOf(store, 'u1'), { relationship: 'Trusts the persona' }, { fieldChars: 400 });
  assert.equal(
    asRecord(store.getPrivate(accountOf(store, 'u1'))).relationshipScore,
    12,
    'falls back to the private score'
  );

  store.applyPrivateOps(
    accountOf(store, 'u1'),
    { relationship: 'Trusts the persona more' },
    { fieldChars: 400, relationshipScore: 61 }
  );
  assert.equal(asRecord(store.getPrivate(accountOf(store, 'u1'))).relationshipScore, 61);
});

const WRITTEN_NOW = Date.UTC(2026, 9, 5, 9, 30, 0);
// Three sentences of about 40 characters each: a limit of 50 (x 1.25 = 62) keeps the first sentence only.
const LONG_RELATIONSHIP =
  'Μιλάμε συχνά για βιβλία και για ταξίδια. Μου λέει πάντα την αλήθεια χωρίς φόβο. Γελάμε με τα ίδια αστεία κάθε βράδυ μαζί.';

test('applyProfileOps: a written relationship is stamped relationshipWrittenAt and clamped to relationshipChars', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Zoé', 1000);

  store.applyProfileOps(
    accountOf(store, 'u1'),
    { details: { add: ['owns a cat'] } },
    { fieldChars: 400, relationshipChars: 50, now: WRITTEN_NOW - 1000 }
  );
  assert.equal(
    asRecord(store.getUser(accountOf(store, 'u1'))).relationshipWrittenAt,
    undefined,
    'no relationship text -> no stamp'
  );

  const profile = store.applyProfileOps(
    accountOf(store, 'u1'),
    { character: LONG_RELATIONSHIP, relationship: LONG_RELATIONSHIP },
    {
      fieldChars: 400,
      relationshipChars: 50,
      relationshipScore: 12.5,
      now: WRITTEN_NOW,
    }
  );
  assert.equal(
    asRecord(profile).relationship,
    'Μιλάμε συχνά για βιβλία και για ταξίδια.',
    'cut at the sentence boundary inside 50 x 1.25'
  );
  assert.equal(asRecord(profile).character, LONG_RELATIONSHIP, 'the portrait keeps fieldChars');
  assert.equal(asRecord(profile).relationshipWrittenAt, new Date(WRITTEN_NOW).toISOString());
  assert.equal(asRecord(profile).relationshipScore, 12.5);

  store.applyProfileOps(
    accountOf(store, 'u1'),
    { relationship: '   ' },
    { fieldChars: 400, relationshipChars: 50, now: WRITTEN_NOW + 5000 }
  );
  assert.equal(
    asRecord(store.getUser(accountOf(store, 'u1'))).relationshipWrittenAt,
    new Date(WRITTEN_NOW).toISOString(),
    'a blank text stamps nothing'
  );

  // Only the first write is clamped: a rewrite over the limit is the caller's to refuse, the store never cuts it.
  const rewritten = store.applyProfileOps(
    accountOf(store, 'u1'),
    { relationship: LONG_RELATIONSHIP },
    { fieldChars: 400, relationshipChars: 50, now: WRITTEN_NOW + 6000 }
  );
  assert.equal(asRecord(rewritten).relationship, LONG_RELATIONSHIP);
});

test('applyPrivateOps: a written private relationship is stamped relationshipWrittenAt and clamped to relationshipChars', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.applyPrivateOps(
    accountOf(store, 'u1'),
    { details: { add: ['a secret'] } },
    { fieldChars: 400, relationshipChars: 50, now: WRITTEN_NOW - 1000 }
  );
  assert.equal(asRecord(store.getPrivate(accountOf(store, 'u1'))).relationshipWrittenAt, undefined);

  const priv = store.applyPrivateOps(
    accountOf(store, 'u1'),
    { relationship: LONG_RELATIONSHIP },
    { fieldChars: 400, relationshipChars: 50, relationshipScore: -9, now: WRITTEN_NOW }
  );
  assert.equal(asRecord(priv).relationship, 'Μιλάμε συχνά για βιβλία και για ταξίδια.');
  assert.equal(asRecord(priv).relationshipWrittenAt, new Date(WRITTEN_NOW).toISOString());
  assert.equal(asRecord(priv).relationshipScore, -9);
  assert.equal(store.getUser(accountOf(store, 'u1')), null, 'the public profile is not created');

  // Only the first write is clamped: a rewrite over the limit is the caller's to refuse, the store never cuts it.
  const rewritten = store.applyPrivateOps(
    accountOf(store, 'u1'),
    { relationship: LONG_RELATIONSHIP },
    { fieldChars: 400, relationshipChars: 50, now: WRITTEN_NOW + 1000 }
  );
  assert.equal(asRecord(rewritten).relationship, LONG_RELATIONSHIP);
});

test('store: relationshipWrittenAt and relationshipScore survive a restart, public and private', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  store.touchUser(accountOf(store, 'u1'), 'Zoé', 1000);
  store.applyProfileOps(
    accountOf(store, 'u1'),
    { relationship: 'Παλιοί φίλοι.' },
    { fieldChars: 400, relationshipScore: 31, now: WRITTEN_NOW }
  );
  store.applyPrivateOps(
    accountOf(store, 'u1'),
    { relationship: 'Μου εμπιστεύεται μυστικά.' },
    { fieldChars: 400, relationshipScore: 44, now: WRITTEN_NOW + 60_000 }
  );
  store.flush();
  await store.flushSettled({});

  const restarted = createStore({ dataDir: dir, memoryDb });
  assert.equal(
    asRecord(restarted.getUser(accountOf(restarted, 'u1'))).relationshipWrittenAt,
    new Date(WRITTEN_NOW).toISOString()
  );
  assert.equal(asRecord(restarted.getUser(accountOf(restarted, 'u1'))).relationshipScore, 31);
  assert.equal(
    asRecord(restarted.getPrivate(accountOf(restarted, 'u1'))).relationshipWrittenAt,
    new Date(WRITTEN_NOW + 60_000).toISOString()
  );
  assert.equal(asRecord(restarted.getPrivate(accountOf(restarted, 'u1'))).relationshipScore, 44);
});

// --- self facts ----

const ELENI = '111111111111111111';

// --- the recent store (data/guilds/<id>/recent.json, src/memory/recent.ts) ------

const RECENT_NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const RECENT_HOUR = 60 * 60 * 1000;
const AGORA = '900000000000000001';

function recentFileOf(dir: string, placeId: string) {
  return path.join(dir, 'guilds', placeId, 'recent.json');
}

function recentAdd(text: string, fields = {}) {
  return { text, at: RECENT_NOW - RECENT_HOUR, placeId: AGORA, ...fields };
}

const recentTexts = (store: Untyped, placeId: string) =>
  store.getRecent(placeOfRoot(store, placeId)).lines.map((line: Untyped) => line.text);

/** applyRecentOps' counts: zero for every reason unless `fields` says otherwise; `dropped` their sum. */
function recentCounts(fields = {}) {
  const base = {
    added: 0,
    removed: 0,
    expired: 0,
    evicted: 0,
    invalid: 0,
    noChannel: 0,
    stale: 0,
    duplicate: 0,
    overCap: 0,
    ...fields,
  };
  return { ...base, dropped: base.invalid + base.noChannel + base.stale + base.duplicate + base.overCap };
}

test('store: getRecent on a fresh guild creates no file, nor does a write that changes nothing', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  assert.deepEqual(store.getRecent(placeOfRoot(store, 'g1')), { nextId: 1, lines: [] });
  assert.deepEqual(store.applyRecentOps(placeOfRoot(store, 'g1'), [], { now: RECENT_NOW }), recentCounts());
  assert.deepEqual(
    store.applyRecentOps(placeOfRoot(store, 'g1'), [{ text: 'χωρίς κανάλι' }], { now: RECENT_NOW }),
    recentCounts({ noChannel: 1 })
  );
  assert.deepEqual(
    store.applyRecentOps(placeOfRoot(store, 'g1'), [recentAdd('δεν χωρά')], { now: RECENT_NOW, maxStored: 0 }),
    recentCounts({ overCap: 1 })
  );
  store.flush();
  assert.equal(fs.existsSync(recentFileOf(dir, 'g1')), false);
});

test('store: recent lines survive a restart and read back normalised', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb, newId: counterIds() });
  const counts = store.applyRecentOps(
    placeOfRoot(store, 'g1'),
    [recentAdd(`<@${ELENI}> έφερε σύκα`, { weight: 3 }), recentAdd('βράδυ με βροχή')],
    { now: RECENT_NOW }
  );
  assert.deepEqual(counts, recentCounts({ added: 2 }));
  store.flush();
  await store.flushSettled({});

  const file = recentFileOf(dir, 'g1');
  const restarted = createStore({ dataDir: dir, memoryDb });
  assert.deepEqual(restarted.getRecent(placeOfRoot(restarted, 'g1')), {
    nextId: 3,
    lines: [
      {
        id: 1,
        at: RECENT_NOW - RECENT_HOUR,
        addedAt: new Date(RECENT_NOW).toISOString(),
        placeId: AGORA,
        text: `<@${ELENI}> έφερε σύκα`,
        who: [ELENI],
        weight: 3,
        itemId: 'rc-u1',
      },
      {
        id: 2,
        at: RECENT_NOW - RECENT_HOUR,
        addedAt: new Date(RECENT_NOW).toISOString(),
        placeId: AGORA,
        text: 'βράδυ με βροχή',
        who: [],
        weight: 2,
        itemId: 'rc-u2',
      },
    ],
  });
  assert.deepEqual(JSON.parse(readRaw(file)), restarted.getRecent(placeOfRoot(restarted, 'g1')));
});

test('store: applyRecentOps marks the file dirty only when a line was added, removed or expired', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  store.applyRecentOps(placeOfRoot(store, 'g1'), [recentAdd('μία'), recentAdd('δύο')], { now: RECENT_NOW });
  store.flush();
  await store.flushSettled({});
  const file = recentFileOf(dir, 'g1');
  const raw = readRaw(file);

  assert.deepEqual(
    store.applyRecentOps(placeOfRoot(store, 'g1'), [recentAdd('ΜΙΑ'), recentAdd('τρία', { placeId: null })], {
      now: RECENT_NOW,
      removeIds: [7],
    }),
    recentCounts({ duplicate: 1, noChannel: 1 })
  );
  store.flush();
  await store.flushSettled({});
  assert.equal(readRaw(file), raw);

  assert.equal(store.applyRecentOps(placeOfRoot(store, 'g1'), [], { now: RECENT_NOW, removeIds: [1] }).removed, 1);
  store.flush();
  await store.flushSettled({});
  assert.deepEqual(recentTexts(createStore({ dataDir: dir, memoryDb }), 'g1'), ['δύο']);

  // a lowered cap and a new line it takes at once: nothing added, yet stored lines were evicted
  store.applyRecentOps(placeOfRoot(store, 'g1'), [recentAdd('τρία'), recentAdd('τέσσερα')], { now: RECENT_NOW });
  store.flush();
  await store.flushSettled({});
  assert.deepEqual(
    store.applyRecentOps(placeOfRoot(store, 'g1'), [recentAdd('ελαφριά', { weight: 1 })], {
      now: RECENT_NOW,
      maxStored: 1,
    }),
    recentCounts({ evicted: 2, overCap: 1 })
  );
  store.flush();
  await store.flushSettled({});
  assert.deepEqual(
    recentTexts(createStore({ dataDir: dir, memoryDb }), 'g1'),
    ['τέσσερα'],
    'written: the evictions alone mark the file dirty'
  );
});

// ---- version history of prose fields ---------------------------------------

function withStore(fn: Untyped) {
  const { dir, memoryDb } = memDataDir();
  return fn(createStore({ dataDir: dir, memoryDb }), dir, memoryDb);
}

test('store: a prose rewrite records the previous text with who wrote and a sentence diff; a first write records nothing', () =>
  withStore((store: Untyped) => {
    store.updateChannel(placeOfChat(store, { id: 'c1' }), { purpose: 'Ένα. Δύο.' }, { by: 'owner' });
    assert.deepEqual(
      store.listVersions(placeOfRoot(store, 'g1'), 'channels', placeOfChat(store, { id: 'c1' })),
      {},
      'first write'
    );
    store.updateChannel(placeOfChat(store, { id: 'c1' }), { purpose: 'Δύο. Τρία.' }, { by: 'analyzer' });
    const v = store.listVersions(placeOfRoot(store, 'g1'), 'channels', placeOfChat(store, { id: 'c1' }));
    assert.equal(v.purpose.length, 1);
    assert.equal(v.purpose[0].text, 'Ένα. Δύο.');
    assert.equal(v.purpose[0].by, 'analyzer');
    assert.deepEqual([v.purpose[0].kept, v.purpose[0].removed, v.purpose[0].added], [1, 1, 1]);
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(v.purpose[0].at));
    store.updateChannel(placeOfChat(store, { id: 'c1' }), { purpose: 'Δύο. Τρία.' }, { by: 'analyzer' });
    assert.equal(
      store.listVersions(placeOfRoot(store, 'g1'), 'channels', placeOfChat(store, { id: 'c1' })).purpose.length,
      1,
      'an identical write records nothing'
    );
  }));

test('store: versions are capped per field at versions.kept, oldest dropped; a caller without by records unknown', () =>
  withStore((store: Untyped) => {
    store.updatePlace(placeOfRoot(store, 'g1'), { patterns: 'v0' });
    for (let i = 1; i <= 5; i++)
      store.updatePlace(placeOfRoot(store, 'g1'), { patterns: `v${i}` }, { versions: { enabled: true, kept: 3 } });
    const v = store.listVersions(placeOfRoot(store, 'g1'), 'place', 'place').patterns;
    assert.deepEqual(
      v.map((x: Untyped) => x.text),
      ['v2', 'v3', 'v4']
    );
    assert.equal(v[0].by, 'unknown');
  }));

test('store: applyProfileOps and setLore record user and lore versions; versions off records nothing', () =>
  withStore(async (store: Untyped, dir: Untyped, memoryDb: Untyped) => {
    store.applyProfileOps(
      accountOf(store, 'u1'),
      { character: 'Calme. Précis.', relationship: 'Amical.' },
      { fieldChars: 1000, by: 'analyzer' }
    );
    assert.deepEqual(store.listVersions(placeOfRoot(store, 'g1'), 'users', accountOf(store, 'u1')), {}, 'first write');
    store.applyProfileOps(
      accountOf(store, 'u1'),
      { character: 'Calme. Bavard.', relationship: 'Très amical.' },
      { fieldChars: 1000, by: 'voice' }
    );
    const user = store.listVersions(placeOfRoot(store, 'g1'), 'users', accountOf(store, 'u1'));
    assert.deepEqual(Object.keys(user).sort(), ['character', 'relationship']);
    assert.equal(user.character[0].text, 'Calme. Précis.');
    assert.equal(user.character[0].by, 'voice');
    assert.equal(user.character[0].chars, [...'Calme. Précis.'].length);
    assert.deepEqual(
      [
        user.character[0].before,
        user.character[0].after,
        user.character[0].kept,
        user.character[0].removed,
        user.character[0].added,
      ],
      [2, 2, 1, 1, 1]
    );
    assert.equal(user.relationship[0].text, 'Amical.');

    const lore = (text: string) => [{ title: 'Ο Κήπος', keys: ['κήπος'], text }];
    store.setLore(placeOfRoot(store, 'g1'), lore('Πρώτο.'), { source: 'analyzer', now: 1000, by: 'analyzer' });
    assert.deepEqual(store.listVersions(placeOfRoot(store, 'g1'), 'lore', 'Ο Κήπος'), {}, 'first lore write');
    store.setLore(placeOfRoot(store, 'g1'), lore('Δεύτερο.'), { source: 'owner', now: 2000, by: 'owner' });
    const loreVersions = store.listVersions(placeOfRoot(store, 'g1'), 'lore', 'Ο Κήπος');
    assert.equal(loreVersions.text.length, 1);
    assert.equal(loreVersions.text[0].text, 'Πρώτο.');
    assert.equal(loreVersions.text[0].by, 'owner');
    assert.deepEqual(
      store.listVersions(placeOfRoot(store, 'g1'), 'lore', ' ο κήπος '),
      loreVersions,
      'the title is matched as the lorebook matches it'
    );

    const off = { enabled: false, kept: 20 };
    store.applyProfileOps(accountOf(store, 'u1'), { style: 'Bref.' }, { fieldChars: 1000 });
    store.applyProfileOps(
      accountOf(store, 'u1'),
      { character: 'Autre.', style: 'Long.', relationship: 'Froid.' },
      { fieldChars: 1000, versions: off }
    );
    store.setLore(placeOfRoot(store, 'g1'), lore('Τρίτο.'), { source: 'owner', now: 3000, versions: off });
    store.updateChannel(placeOfChat(store, { id: 'c1' }), { tone: 'a' });
    store.updateChannel(placeOfChat(store, { id: 'c1' }), { tone: 'b' }, { versions: off });
    store.updatePlace(placeOfRoot(store, 'g1'), { starters: 'a' });
    store.updatePlace(placeOfRoot(store, 'g1'), { starters: 'b' }, { versions: off });
    store.updateUser(accountOf(store, 'u1'), { style: 'Court.' }, { versions: off });
    assert.equal(store.listVersions(placeOfRoot(store, 'g1'), 'users', accountOf(store, 'u1')).character.length, 1);
    assert.equal(store.listVersions(placeOfRoot(store, 'g1'), 'users', accountOf(store, 'u1')).style, undefined);
    assert.equal(store.listVersions(placeOfRoot(store, 'g1'), 'lore', 'Ο Κήπος').text.length, 1);
    assert.deepEqual(store.listVersions(placeOfRoot(store, 'g1'), 'channels', placeOfChat(store, { id: 'c1' })), {});
    assert.deepEqual(store.listVersions(placeOfRoot(store, 'g1'), 'place', 'place'), {});

    store.updateUser(accountOf(store, 'u1'), { style: 'Court et net.' }, { by: 'owner' });
    assert.equal(
      store.listVersions(placeOfRoot(store, 'g1'), 'users', accountOf(store, 'u1')).style[0].text,
      'Court.',
      'updateUser records too'
    );

    store.flush();
    await store.flushSettled({});
    const fresh = createStore({ dataDir: dir, memoryDb });
    assert.equal(
      asRecord(fresh.listVersions(placeOfRoot(fresh, 'g1'), 'users', accountOf(fresh, 'u1'))).character[0].text,
      'Calme. Précis.',
      'versions survive a restart'
    );
  }));

test('store: version files are not mistaken for channel or user ids', () =>
  withStore(async (store: Untyped, dir: Untyped, memoryDb: Untyped) => {
    for (const text of ['Un.', 'Deux.']) {
      store.applyProfileOps(accountOf(store, 'u1'), { character: text }, { fieldChars: 1000 });
      store.updateChannel(placeOfChat(store, { id: 'c1' }), { purpose: text });
      store.updatePlace(placeOfRoot(store, 'g1'), { patterns: text });
      store.setLore(placeOfRoot(store, 'g1'), [{ title: 'T', keys: ['tt'], text }], { source: 'owner' });
    }
    assert.ok(
      Object.keys(store.listVersions(placeOfRoot(store, 'g1'), 'channels', placeOfChat(store, { id: 'c1' }))).length > 0
    );
    assert.ok(Object.keys(store.listVersions(placeOfRoot(store, 'g1'), 'users', accountOf(store, 'u1'))).length > 0);
    const check = (s: Untyped) => {
      assert.deepEqual(
        s.listChannels(placeOfRoot(s, 'g1')).map((c: Untyped) => c.id),
        ['c1']
      );
      assert.deepEqual(
        s.listUserProfiles().map((p: Untyped) => p.id),
        ['u1']
      );
    };
    store.flush();
    await store.flushSettled({});
    underTop(memoryDb, placeOfRoot(store, 'g1'), placeOfChat(store, { id: 'c1' }));
    check(store);
    check(createStore({ dataDir: dir, memoryDb }));
  }));

// ---- the participation store (src/memory/participation.ts) ---------------------

const PART_AT = Date.UTC(2026, 9, 10, 12, 0, 0);
const PART_MIN = 60_000;

/** A store state with one episode in `placeId`: a line of `authorId`, then the persona's. */
function partState(state: unknown, { placeId, minute, authorId = 'u1' }: Untyped) {
  const before = [
    {
      id: `m${placeId}${minute}`,
      ts: PART_AT + (minute - 1) * PART_MIN,
      authorId,
      name: 'Zoé',
      self: false,
      text: 'καλημέρα',
      replyTo: null,
      caption: null,
    },
  ];
  const own = {
    id: `o${placeId}${minute}`,
    ts: PART_AT + minute * PART_MIN,
    authorId: 'bot',
    name: 'persona',
    self: true,
    text: 'γεια σου',
    replyTo: null,
    caption: null,
  };
  return recordOwnLine(state, { placeId, own, before }, PARTICIPATION_DEFAULTS, PART_AT + minute * PART_MIN);
}

test('store: participation round trip, a copy on read, nothing created by reading', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb, newId: counterIds() });
  const file = path.join(dir, 'guilds', 'g1', 'participation.json');
  assert.deepEqual(store.getParticipation(placeOfRoot(store, 'g1')), { episodes: [], nextId: 1 });
  store.flush();
  await store.flushSettled({});
  assert.equal(existsRaw(file), false);

  const state = partState(emptyParticipation(), { placeId: 'c1', minute: 0 });
  store.setParticipation(placeOfRoot(store, 'g1'), state, { settings: PARTICIPATION_DEFAULTS, now: PART_AT });
  const copy = store.getParticipation(placeOfRoot(store, 'g1'));
  const stored = { ...state, episodes: state.episodes.map((ep) => ({ ...ep, itemId: 'pt-u1' })) };
  assert.deepEqual(copy, stored);
  copy.episodes.length = 0;
  assert.equal(store.getParticipation(placeOfRoot(store, 'g1')).episodes.length, 1);
  store.flush();
  await store.flushSettled({});
  assert.deepEqual(createStore({ dataDir: dir, memoryDb }).getParticipation(placeOfRoot(store, 'g1')), stored);
});

test('store: participation expires on every write', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  let state = partState(emptyParticipation(), { placeId: 'c1', minute: 0 });
  state = partState(state, { placeId: 'c2', minute: 120 });
  state = partState(state, { placeId: 'c3', minute: 240 });
  store.setParticipation(placeOfRoot(store, 'g1'), state, {
    settings: { ...PARTICIPATION_DEFAULTS, hours: 3 },
    now: PART_AT + 5 * 60 * PART_MIN,
  });
  assert.deepEqual(
    store.getParticipation(placeOfRoot(store, 'g1')).episodes.map((ep) => asRecord(ep).placeId),
    ['c2', 'c3']
  );
  store.setParticipation(placeOfRoot(store, 'g1'), state, {
    settings: { ...PARTICIPATION_DEFAULTS, maxStored: 1 },
    now: PART_AT + 5 * 60 * PART_MIN,
  });
  assert.deepEqual(
    store.getParticipation(placeOfRoot(store, 'g1')).episodes.map((ep) => asRecord(ep).placeId),
    ['c3']
  );
});

test('store: a broken participation file reads as a store and is logged once', async () => {
  const { dir, memoryDb } = memDataDir();
  const guildDir = (id: string) => path.join(dir, 'guilds', id);
  const good = partState(emptyParticipation(), { placeId: 'c1', minute: 0 });
  await writeRaw(path.join(guildDir('g1'), 'participation.json'), {
    nextId: 2,
    episodes: [...good.episodes, { id: 'p9' }, 'όχι'],
  });
  await writeRaw(path.join(guildDir('g2'), 'participation.json'), { episodes: 'κανένα' });
  const store = createStore({ dataDir: dir, memoryDb });
  const { result, logs } = await withCapturedLogs(() => [
    store.getParticipation(placeOfRoot(store, 'g1')),
    store.getParticipation(placeOfRoot(store, 'g1')),
    store.getParticipation(placeOfRoot(store, 'g2')),
    store.getParticipation(placeOfRoot(store, 'g3')),
  ]);
  assert.deepEqual(result[0], good);
  assert.deepEqual(result[2], { episodes: [], nextId: 1 });
  assert.deepEqual(result[3], { episodes: [], nextId: 1 });
  assert.deepEqual(
    logs
      .filter((entry) => entry.msg.startsWith('store: participation'))
      .map((entry) => [entry.msg, entry.placeId, entry.reason ?? entry.dropped]),
    [
      ['store: participation episodes dropped', 'discord:server:g1', 2],
      ['store: participation store replaced', 'discord:server:g2', 'malformed'],
    ]
  );
});

test('markRelationshipRewrite: sets and clears the flag on a profile with a text, false without one', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  assert.equal(store.markRelationshipRewrite(accountOf(store, 'u1')), false, 'no profile');
  assert.equal(store.getUser(accountOf(store, 'u1')), null, 'no profile is created');

  store.touchUser(accountOf(store, 'u1'), 'Zoé', 1000);
  assert.equal(store.markRelationshipRewrite(accountOf(store, 'u1')), false, 'a profile without a relationship text');
  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).relationshipRewrite, undefined);

  store.applyProfileOps(
    accountOf(store, 'u1'),
    { relationship: 'Παλιοί φίλοι.' },
    { fieldChars: 400, now: WRITTEN_NOW }
  );
  assert.equal(store.markRelationshipRewrite(accountOf(store, 'u1')), true);
  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).relationshipRewrite, true);
  store.flush();
  await store.flushSettled({});
  assert.equal(
    asRecord(createStore({ dataDir: dir, memoryDb }).getUser(accountOf(store, 'u1'))).relationshipRewrite,
    true,
    'the flag survives a restart'
  );

  assert.equal(store.markRelationshipRewrite(accountOf(store, 'u1'), false), true);
  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).relationshipRewrite, undefined, 'cleared');
});

test('applyProfileOps: writing a relationship text clears the rewrite flag, any other write keeps it', () => {
  const dir = tmpDataDir();
  const store = createStore(memoryAt(dir));
  store.touchUser(accountOf(store, 'u1'), 'Zoé', 1000);
  store.applyProfileOps(
    accountOf(store, 'u1'),
    { relationship: 'Παλιοί φίλοι.' },
    { fieldChars: 400, now: WRITTEN_NOW }
  );
  store.markRelationshipRewrite(accountOf(store, 'u1'));

  store.applyProfileOps(
    accountOf(store, 'u1'),
    { details: { add: ['owns a cat'] }, relationship: '  ' },
    { fieldChars: 400, now: WRITTEN_NOW + 1000 }
  );
  assert.equal(
    asRecord(store.getUser(accountOf(store, 'u1'))).relationshipRewrite,
    true,
    'no text written -> the flag stays'
  );

  store.applyProfileOps(
    accountOf(store, 'u1'),
    { relationship: 'Φίλοι που μιλούν κάθε μέρα.' },
    { fieldChars: 400, now: WRITTEN_NOW + 2000 }
  );
  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).relationshipRewrite, undefined);
});

// ---- itemId and what every write drops ----------------------------------------------------

/** A counter standing in for randomUUID, so the ids a test sees are predictable. */
function counterIds() {
  let n = 0;
  return () => {
    n += 1;
    return `u${n}`;
  };
}

const ID_NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

test('store: eviction returns the dropped items with their itemId', () => {
  const dir = tmpDataDir();
  const store = createStore({ ...memoryAt(dir), newId: counterIds() });

  let onDropped = null;
  store.updatePlace(placeOfRoot(store, 'g1'), { injokes: ['ο café', 'η γάτα'] });
  store.updatePlace(
    placeOfRoot(store, 'g1'),
    { injokes: ['η γάτα', 'το σκάκι'] },
    { onDropped: (d) => (onDropped = d) }
  );
  assert.deepEqual(
    asRecord(onDropped)?.injokes.map((d: Untyped) => d.text),
    ['ο café']
  );
  assert.ok(asRecord(onDropped)?.injokes[0].itemId.startsWith('ij-u'));
  assert.deepEqual(asRecord(onDropped)?.self, []);

  const posts = ['ένα', 'δύο', 'τρία'].map((gist, i) => ({
    at: ID_NOW + i,
    kind: null,
    gist,
    picture: null,
    messageIds: [],
    search: '',
  }));
  store.setSelfreflectionPosts(posts.slice(0, 2), { max: 2, now: ID_NOW });
  const firstPostId = asRecord(store.getSelfreflection().posts[0]).itemId;
  const selfreflection = store.appendSelfreflectionPost(posts[2], { max: 2, now: ID_NOW });
  assert.deepEqual(
    selfreflection.dropped.map((p) => [asRecord(p).gist, asRecord(p).itemId]),
    [['ένα', firstPostId]]
  );
  assert.ok(firstPostId.startsWith('dy-u'));

  store.applyLearnedOps(placeOfRoot(store, 'g1'), { add: ['πρώτο', 'δεύτερο'] }, { seenAt: ID_NOW });
  const firstLessonId = asRecord(store.getPlace(placeOfRoot(store, 'g1'))).learned[0].itemId;
  const learned = store.applyLearnedOps(placeOfRoot(store, 'g1'), { remove: [1] }, { seenAt: ID_NOW });
  assert.deepEqual(
    asRecord(learned).dropped.map((l: Untyped) => [l.text, l.itemId]),
    [['πρώτο', firstLessonId]]
  );

  store.applyRecentOps(
    placeOfRoot(store, 'g1'),
    [{ text: 'παλιό', at: ID_NOW - 1000, placeId: '900000000000000001' }],
    {
      now: ID_NOW - 1000,
    }
  );
  const lineId = asRecord(store.getRecent(placeOfRoot(store, 'g1')).lines[0]).itemId;
  const recent = store.applyRecentOps(placeOfRoot(store, 'g1'), [], { now: ID_NOW, hours: 0 });
  assert.equal(recent.expired, 1);
  assert.deepEqual(
    asRecord(recent).droppedLines.map((l: Untyped) => l.itemId),
    [lineId]
  );
  assert.equal('droppedLines' in JSON.parse(JSON.stringify(recent)), false);

  store.touchUser(accountOf(store, 'u1'), 'Zoé', ID_NOW);
  store.adjustAffinity(accountOf(store, 'u1'), 1, 'α', { maxDelta: 5, historySize: 1, now: ID_NOW });
  const moveId = asRecord(store.getUser(accountOf(store, 'u1'))).affinity.history[0].itemId;
  const affinity = store.adjustAffinity(accountOf(store, 'u1'), 1, 'β', {
    maxDelta: 5,
    historySize: 1,
    now: ID_NOW + 1,
  });
  assert.deepEqual(
    asRecord(affinity)?.droppedMoves.map((m: Untyped) => m.itemId),
    [moveId]
  );

  const own = (id: string, ts: number) => ({ id, ts, authorId: 'bot', name: 'persona', self: true, text: 'γεια' });
  let part = recordOwnLine(
    emptyParticipation(),
    { placeId: 'c1', own: own('o1', ID_NOW) },
    PARTICIPATION_DEFAULTS,
    ID_NOW
  );
  store.setParticipation(placeOfRoot(store, 'g1'), part, { settings: PARTICIPATION_DEFAULTS, now: ID_NOW });
  const episodeId = asRecord(store.getParticipation(placeOfRoot(store, 'g1')).episodes[0]).itemId;
  part = recordOwnLine(
    store.getParticipation(placeOfRoot(store, 'g1')),
    { placeId: 'c2', own: own('o2', ID_NOW + 1000) },
    PARTICIPATION_DEFAULTS,
    ID_NOW + 1000
  );
  const { dropped } = store.setParticipation(placeOfRoot(store, 'g1'), part, {
    settings: { ...PARTICIPATION_DEFAULTS, maxStored: 1 },
    now: ID_NOW + 1000,
  });
  assert.deepEqual(
    dropped.map((ep) => asRecord(ep).itemId),
    [episodeId]
  );
});

// ---- the archive (src/memory/archive.ts): nothing leaves a hot list without a copy ----

test('store: an evicted episode is archived before the hot file on disk loses it', async () => {
  const { dir, memoryDb } = memDataDir();
  const archive = fakeArchive({ manual: true });
  const store = createStore({ dataDir: dir, memoryDb, newId: counterIds(), archive });
  const file = path.join(dir, 'guilds', 'g1', 'users', 'u1.json');
  // Every write of the member's file, in order with the archive's answer.
  const write = async () => {
    store.flush();
    await settle();
    const onDisk = whats(JSON.parse(readRaw(file)).episodes);
    archive.events.push(onDisk.includes('παλιό') ? 'write-with' : 'write-without');
  };
  const opts = { maxEpisodes: 1, maxNew: 3, now: ID_NOW };
  store.touchUser(accountOf(store, 'u1'), 'Zoé', ID_NOW);
  store.addEpisodes(accountOf(store, 'u1'), [{ date: '2026-10-01', what: 'παλιό', weight: 1 }], opts);
  await write();

  const from = store.archiveMark();
  store.addEpisodes(accountOf(store, 'u1'), [{ date: '2026-10-04', what: 'νέο', weight: 3 }], opts);
  const to = store.archiveMark();
  assert.deepEqual(
    whats(asRecord(store.getUser(accountOf(store, 'u1'))).episodes),
    ['παλιό', 'νέο'],
    'the victim stays hot, over the cap'
  );
  await write();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(archive.appended.length, 1, 'the append runs in the background');
  const [{ placeId, entries, opts: appendOpts }] = archive.appended;
  // A member's public item belongs to no place: it is archived under the persona.
  assert.equal(placeId, null);
  assert.deepEqual(appendOpts, {});
  assert.deepEqual(
    asRecord(entries).map((entry: Untyped) => [entry.itemKind, entry.event, entry.text.what, entry.scope]),
    [['episode', 'evicted', 'παλιό', { user: 'discord:u1' }]]
  );
  assert.equal(
    asRecord(entries[0]).itemId,
    asRecord(store.getUser(accountOf(store, 'u1'))).episodes[0].itemId,
    'the hot copy carries the archived id'
  );
  await write();

  archive.releases.shift()?.();
  const settled = await store.settleArchive({ from, to });
  assert.deepEqual(settled, {
    archived: [
      {
        itemId: asRecord(entries[0]).itemId,
        revisionId: asRecord(entries[0]).revisionId,
        itemKind: 'episode',
        event: 'evicted',
      },
    ],
    deferred: 0,
  });
  assert.deepEqual(whats(asRecord(store.getUser(accountOf(store, 'u1'))).episodes), ['νέο'], 'trimmed once confirmed');
  await write();

  const resolved = archive.events.indexOf('append-resolved');
  assert.ok(resolved > 0, JSON.stringify(archive.events));
  assert.ok(
    archive.events.slice(0, resolved).every((event) => event === 'write-with'),
    JSON.stringify(archive.events)
  );
  assert.equal(archive.events.at(-1), 'write-without');

  // With features.archive off (archiveOn false) a victim leaves at once and nothing is archived.
  const offArchive = fakeArchive();
  const off = createStore({
    ...memoryAt(tmpDataDir()),
    newId: counterIds(),
    archive: offArchive,
    archiveOn: () => false,
  });
  off.addEpisodes(accountOf(off, 'u1'), [{ date: '2026-10-01', what: 'παλιό', weight: 1 }], opts);
  off.addEpisodes(accountOf(off, 'u1'), [{ date: '2026-10-04', what: 'νέο', weight: 3 }], opts);
  assert.deepEqual(whats(asRecord(off.getUser(accountOf(off, 'u1'))).episodes), ['νέο']);
  assert.deepEqual(await off.settleArchive(), { archived: [], deferred: 0 });
  assert.equal(offArchive.appended.length, 0);
});

test('store: a failing archive keeps every victim hot and queues them; drainPending archives and trims', async () => {
  const { dir, memoryDb } = memDataDir();
  const archive = fakeArchive({ fail: true });
  const store = createStore({ dataDir: dir, memoryDb, newId: counterIds(), archive });
  const opts = { maxEpisodes: 3, maxNew: 3, now: ID_NOW };
  store.touchUser(accountOf(store, 'u1'), 'Zoé', ID_NOW);
  store.addEpisodes(
    accountOf(store, 'u1'),
    [1, 2, 3].map((n) => ({ date: `2026-10-0${n}`, what: `στιγμή ${n}`, weight: 1 })),
    opts
  );

  const from = store.archiveMark();
  store.addEpisodes(
    accountOf(store, 'u1'),
    [
      { date: '2026-10-04', what: 'βαριά', weight: 3 },
      { date: '2026-10-05', what: 'βαριά δύο', weight: 3 },
    ],
    opts
  );
  const to = store.archiveMark();

  const { logs, result: settled } = await withCapturedLogs(() => store.settleArchive({ from, to }));
  assert.deepEqual(settled, { archived: [], deferred: 2 }); // this count and the ones below dropped by one: the self-fact setup went with applySelfOps
  assert.ok(
    logs.some((entry) => entry.msg === 'store: archive failed' && entry.entries === 2),
    'counts only'
  );
  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).episodes.length, 5, 'every victim stays hot');
  assert.deepEqual(
    archive.pending.map((item) => `${asRecord(item).entry.itemKind} ${asRecord(item).entry.event}`).sort(),
    ['episode evicted', 'episode evicted']
  );
  store.flush();
  await store.flushSettled({});
  const file = path.join(dir, 'guilds', 'g1', 'users', 'u1.json');
  assert.equal(JSON.parse(readRaw(file)).episodes.length, 5, 'on disk too');

  // A later write drops the same victims again: nothing is queued twice.
  store.addEpisodes(accountOf(store, 'u1'), [{ date: '2026-10-06', what: 'βαριά τρία', weight: 3 }], opts);
  await store.settleArchive();
  assert.equal(archive.pending.length, 3, 'only the new victim is queued');

  const drained = await store.drainArchive();
  assert.deepEqual(drained, { archived: 3, left: 0 });
  assert.deepEqual(whats(asRecord(store.getUser(accountOf(store, 'u1'))).episodes), [
    'βαριά',
    'βαριά δύο',
    'βαριά τρία',
  ]);
  store.flush();
  await store.flushSettled({});
  assert.equal(JSON.parse(readRaw(file)).episodes.length, 3);
});

test('store: a replace op archives the previous version with event replaced', async () => {
  const archive = fakeArchive();
  const store = createStore({ ...memoryAt(tmpDataDir()), newId: counterIds(), archive });
  store.applyProfileOps(
    accountOf(store, 'u1'),
    { interests: { add: [{ topic: 'σκάκι', note: 'παίζει τα βράδια' }] } },
    { now: ID_NOW }
  );
  const [stored] = asRecord(store.getUser(accountOf(store, 'u1'))).interests;

  store.applyProfileOps(
    accountOf(store, 'u1'),
    { interests: { update: [{ topic: 'σκάκι', note: 'παίζει online' }] } },
    { now: ID_NOW + 1000 }
  );
  await store.settleArchive();
  const [entry] = archive.appended.flatMap((call) => asRecord(call).entries);
  assert.deepEqual([entry.itemKind, entry.event, entry.itemId], ['interest', 'replaced', stored.itemId]);
  assert.deepEqual(entry.text, { topic: 'σκάκι', note: 'παίζει τα βράδια' }, 'the previous version');
  assert.equal(
    asRecord(store.getUser(accountOf(store, 'u1'))).interests[0].note,
    'παίζει online',
    'the new version stays hot'
  );

  // A remove is a replace too: held until confirmed, then gone.
  store.applyProfileOps(accountOf(store, 'u1'), { interests: { remove: ['σκάκι'] } }, { now: ID_NOW + 2000 });
  const settled = await store.settleArchive();
  assert.deepEqual(
    settled.archived.map((item) => [item.itemKind, item.event, item.itemId]),
    [['interest', 'replaced', stored.itemId]]
  );
  assert.equal(asRecord(archive.appended.at(-1))?.entries[0].text.note, 'παίζει online');
  assert.deepEqual(asRecord(store.getUser(accountOf(store, 'u1'))).interests, []);
});

test('store: a replaced note is not flushed to disk before its old version is archived', async () => {
  const { dir, memoryDb } = memDataDir();
  const archive = fakeArchive({ manual: true });
  const store = createStore({ dataDir: dir, memoryDb, newId: counterIds(), archive });
  const file = path.join(dir, 'guilds', 'g1', 'users', 'u1.json');
  const noteOnDisk = () => JSON.parse(readRaw(file)).interests[0].note;
  store.applyProfileOps(
    accountOf(store, 'u1'),
    { interests: { add: [{ topic: 'σκάκι', note: 'παίζει τα βράδια' }] } },
    { now: ID_NOW }
  );
  assert.equal(store.flush().held, 0);
  await settle();
  assert.equal(noteOnDisk(), 'παίζει τα βράδια');

  store.applyProfileOps(
    accountOf(store, 'u1'),
    { interests: { update: [{ topic: 'σκάκι', note: 'παίζει online' }] } },
    { now: ID_NOW + 1000 }
  );
  assert.equal(store.flush().held, 1, 'the member file waits for the archive');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.flush().held, 1, 'still waiting while the append is in flight');
  await settle();
  assert.equal(noteOnDisk(), 'παίζει τα βράδια', 'the old note stays on disk until its copy is archived');

  archive.releases.shift()?.();
  await store.settleArchive();
  assert.equal(store.flush().held, 0);
  await settle();
  assert.equal(noteOnDisk(), 'παίζει online');

  // A hold that never clears: the shutdown flush waits holdMaxMs, then writes anyway and logs it.
  store.applyProfileOps(
    accountOf(store, 'u1'),
    { interests: { update: [{ topic: 'σκάκι', note: 'παίζει σπάνια' }] } },
    { now: ID_NOW + 2000 }
  );
  const { logs, result } = await withCapturedLogs(() => store.flushSettled({ holdMaxMs: 20 }));
  assert.equal(result.held, 0);
  await settle();
  assert.equal(noteOnDisk(), 'παίζει σπάνια');
  assert.ok(
    logs.some((entry) => entry.msg === 'store: flushed held' && entry.files === 1),
    JSON.stringify(logs)
  );
});

test('store: closed items are capped and archived as replaced', async () => {
  const archive = fakeArchive();
  const store = createStore({ ...memoryAt(tmpDataDir()), newId: counterIds(), archive });
  const opts = (n: number) => ({ now: ID_NOW + n * 1000, maxClosedStored: 2 });
  store.applyProfileOps(accountOf(store, 'u1'), { interests: { add: [{ topic: 'α', note: '' }] } }, opts(0));
  for (const [n, topic] of [
    [1, 'β'],
    [2, 'γ'],
    [3, 'δ'],
  ]) {
    const [open] = asRecord(store.getUser(accountOf(store, 'u1'))).interests;
    store.applyProfileOps(
      accountOf(store, 'u1'),
      { interests: { add: [{ topic, note: '', supersedes: open.itemId }] } },
      opts(Number(n))
    );
  }
  const profile = store.getUser(accountOf(store, 'u1'));
  assert.deepEqual(
    asRecord(profile).interests.map((item: Untyped) => item.topic),
    ['δ']
  );
  assert.deepEqual(
    asRecord(profile).closed.map((item: Untyped) => item.topic),
    ['α', 'β', 'γ'],
    'the evicted one stays until archived'
  );

  const settled = await store.settleArchive();
  assert.deepEqual(
    settled.archived.map((item) => [item.itemKind, item.event]),
    [['interest', 'replaced']]
  );
  const [entry] = archive.appended.flatMap((call) => asRecord(call).entries);
  assert.equal(entry.text.topic, 'α');
  assert.deepEqual(
    asRecord(store.getUser(accountOf(store, 'u1'))).closed.map((item: Untyped) => [item.kind, item.topic]),
    [
      ['interest', 'β'],
      ['interest', 'γ'],
    ]
  );
  assert.equal(
    asRecord(store.getUser(accountOf(store, 'u1'))).closed[1].supersededBy,
    asRecord(profile).interests[0].itemId
  );
});

// ---- the real name and the names people use (src/memory/addressed.ts) ----

test('applyProfileOps: a realName is set, an equal one is a sighting, a different string changes nothing', () => {
  const store = createStore({ ...memoryAt(tmpDataDir()), newId: counterIds() });
  store.applyProfileOps(accountOf(store, 'u1'), { realName: '  Théo  ' }, { now: ID_NOW, seenAt: ID_NOW });
  const set = asRecord(store.getUser(accountOf(store, 'u1'))).realName;
  assert.equal(set.name, 'Théo');
  assert.equal(set.from, '2026-10-05');
  assert.equal(set.to, null);
  assert.match(set.itemId, /^rn-/);

  store.applyProfileOps(accountOf(store, 'u1'), { realName: { name: 'THÉO' } }, { now: ID_NOW + 1000 });
  assert.deepEqual(asRecord(store.getUser(accountOf(store, 'u1'))).realName, set, 'an equal name is a sighting');
  store.applyProfileOps(accountOf(store, 'u1'), { realName: 'Léon' }, { now: ID_NOW + 2000 });
  assert.deepEqual(
    asRecord(store.getUser(accountOf(store, 'u1'))).realName,
    set,
    'a different name without supersedes changes nothing'
  );
  store.applyProfileOps(accountOf(store, 'u1'), { realName: '' }, { now: ID_NOW + 3000 });
  assert.deepEqual(asRecord(store.getUser(accountOf(store, 'u1'))).realName, set);
  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).closed, undefined);
});

test('applyProfileOps: a realName is clamped to 60 characters', () => {
  const store = createStore({ ...memoryAt(tmpDataDir()), newId: counterIds() });
  store.applyProfileOps(accountOf(store, 'u1'), { realName: 'α'.repeat(80) }, { now: ID_NOW });
  assert.ok([...asRecord(store.getUser(accountOf(store, 'u1'))).realName.name].length <= 60);
});

test('applyProfileOps: a realName that supersedes the stored one closes it into the closed list, archived once evicted', async () => {
  const archive = fakeArchive();
  const store = createStore({ ...memoryAt(tmpDataDir()), newId: counterIds(), archive });
  store.applyProfileOps(accountOf(store, 'u1'), { realName: 'Léon' }, {
    now: ID_NOW,
    maxClosedStored: 1,
  } as unknown as Parameters<typeof store.applyProfileOps>[2]);
  const old = asRecord(store.getUser(accountOf(store, 'u1'))).realName;
  store.applyProfileOps(
    accountOf(store, 'u1'),
    { realName: { name: 'Théo', supersedes: old.itemId, validFrom: '2026-10-06' } },
    {
      now: ID_NOW + 1000,
      maxClosedStored: 1,
    } as unknown as Parameters<typeof store.applyProfileOps>[2]
  );
  const profile = store.getUser(accountOf(store, 'u1'));
  assert.equal(asRecord(profile).realName.name, 'Théo');
  assert.equal(asRecord(profile).realName.from, '2026-10-06');
  assert.deepEqual(
    asRecord(profile).closed.map((item: Untyped) => [
      item.kind,
      item.name,
      item.validTo,
      item.supersededBy,
      item.itemId,
    ]),
    [['realName', 'Léon', '2026-10-06', asRecord(profile).realName.itemId, old.itemId]]
  );

  // By name works too; the second closing pushes the first out of a one-item closed list.
  store.applyProfileOps(accountOf(store, 'u1'), { realName: { name: 'Ilias', supersedes: 'théo' } }, {
    now: ID_NOW + 2000,
    maxClosedStored: 1,
  } as unknown as Parameters<typeof store.applyProfileOps>[2]);
  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).realName.name, 'Ilias');
  const settled = await store.settleArchive();
  assert.deepEqual(
    settled.archived.map((item) => [item.itemKind, item.event]),
    [['realName', 'replaced']]
  );
  const [entry] = archive.appended.flatMap((call) => asRecord(call).entries);
  assert.equal(entry.text.name, 'Léon');
  assert.deepEqual(
    asRecord(store.getUser(accountOf(store, 'u1'))).closed.map((item: Untyped) => [item.kind, item.name]),
    [['realName', 'Théo']]
  );
});

test('getUser: addressedAs and realName are normalised on read, absent stays absent', async () => {
  const { dir, memoryDb } = memDataDir();
  const last = new Date(ID_NOW).toISOString();
  writeRaw(path.join(dir, 'guilds', 'g1', 'users', 'u1.json'), {
    id: 'u1',
    names: ['Ana'],
    addressedAs: { Ana: { score: 2, last }, broken: { score: 'x' }, worse: 1 },
    realName: { name: 'Anaïs', from: 'never', to: '2020-01-01', itemId: 'rn-1', junk: true },
  });
  writeRaw(path.join(dir, 'guilds', 'g1', 'users', 'u2.json'), {
    id: 'u2',
    names: ['Bo'],
    realName: { name: '' },
    addressedAs: [1],
  });
  writeRaw(path.join(dir, 'guilds', 'g1', 'users', 'u3.json'), { id: 'u3', names: ['Cy'] });
  const store = createStore({ dataDir: dir, memoryDb });
  const one = store.getUser(accountOf(store, 'u1'));
  assert.deepEqual(asRecord(one).addressedAs, { Ana: { score: 2, last } });
  assert.deepEqual(asRecord(one).realName, { name: 'Anaïs', from: null, to: null, itemId: 'rn-1' });
  const two = store.getUser(accountOf(store, 'u2'));
  assert.equal('realName' in asRecord(two), false);
  assert.deepEqual(asRecord(two).addressedAs, {});
  const three = store.getUser(accountOf(store, 'u3'));
  assert.equal('realName' in asRecord(three), false);
  assert.equal('addressedAs' in asRecord(three), false);
});

test('recordAddressUses: folds uses into an existing profile only, with the half-life given', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  assert.equal(
    store.recordAddressUses(accountOf(store, 'nobody'), [{ name: 'Ana', at: ID_NOW }], { halfLifeDays: 30 }),
    null
  );
  assert.equal(store.getUser(accountOf(store, 'nobody')), null);
  store.touchUser(accountOf(store, 'u1'), 'Ana', ID_NOW);
  store.recordAddressUses(accountOf(store, 'u1'), [{ name: 'Ana', at: ID_NOW }], { halfLifeDays: 30 });
  store.recordAddressUses(accountOf(store, 'u1'), [{ name: 'ana', at: ID_NOW + 30 * 86_400_000 }], {
    halfLifeDays: 30,
  });
  assert.deepEqual(asRecord(store.getUser(accountOf(store, 'u1'))).addressedAs, {
    Ana: { score: 1.5, last: new Date(ID_NOW + 30 * 86_400_000).toISOString() },
  });
});
