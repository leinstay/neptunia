// Synthetic places with their notes, channel entries, lorebooks, participation and recent lines, for the tests of the
// write kinds `place-notes`, `channel-entry`, `place-lore`, `participation-episodes` and `recent-lines` and of the
// owner columns of their rows (tests/memory-db-place-notes.test.ts, tests/memory-db-channel-entry.test.ts,
// tests/memory-db-place-owner.test.ts, tests/memory-db-place-lists.test.ts). `writeBothWays` runs the same writes
// through the unit write and through the write kinds over copies of one seeded database, derives the owner columns of
// the unit way with version steps 48 and 49, and returns every table of each.
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { applyMemoryWrite } from '../../../src/memory/db/session-write.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../../../src/memory/db/types.ts';
import { tempDataDir } from './service.ts';

export const NOW = Date.parse('2026-11-09T10:00:00.000Z');
export const ROOT = 'discord:guild:300000000000000001';
export const OTHER_ROOT = 'discord:guild:300000000000000002';
export const DM = 'discord:dm:100000000000000007';
export const CHANNEL = 'discord:channel:200000000000000001';
export const THREAD = 'discord:channel:200000000000000002';
export const TEACHER = '100000000000000001';

/** One write of a test: a value of one of a place's units, or her session's review of a root's patterns. */
export type PlaceStep =
  | { kind: 'place' | 'channel' | 'participation' | 'recent'; placeId: string; value: Row }
  | { kind: 'lore'; placeId: string; value: Array<Row> | Row }
  | { kind: 'review' };

/** The write kind of each unit kind. */
const WRITE_KINDS = {
  place: 'place-notes',
  channel: 'channel-entry',
  lore: 'place-lore',
  participation: 'participation-episodes',
  recent: 'recent-lines',
} as const;

export const notes = (extra: Row = {}): Row => ({
  patterns: 'Speaks in short bursts.',
  starters: 'Τι λέμε σήμερα;',
  purpose: 'Μια παρέα για παιχνίδια.',
  injokes: ['the lamp incident', 'Πέμπτη'],
  self: ['likes rain', 'is a night owl'],
  learnedNextId: 2,
  learned: [
    { id: 1, text: 'the bridge is closed', weight: 2, firstSeen: '2026-09-01', lastSeen: '2026-09-02', from: `<@${TEACHER}>`, itemId: 'ln-1' },
    { id: 2, text: 'dinner is at eight', weight: 1, firstSeen: '2026-09-03', lastSeen: '2026-09-03', from: 'the owner' },
  ],
  emojiUsage: { '500000000000000001': { name: 'smile', count: 3, last: 1759400000000 } },
  pings: { [TEACHER]: { off: true } },
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...extra,
});

export const entry = (extra: Row = {}): Row => ({
  id: '200000000000000001',
  name: 'général',
  topic: null,
  purpose: 'Everyday talk.',
  topics: 'games, food',
  tone: 'relaxed',
  days: { '2026-10-01': 12 },
  messageCount: 12,
  firstMessageAt: 1759300000000,
  lastMessageAt: null,
  writers: { [TEACHER]: { count: 9, last: 1759400000000 } },
  updatedAt: '2026-10-02T00:00:00.000Z',
  ...extra,
});

/** Every table but the full-text indexes, each row as stored, in rowid order. */
export function tablesOf(db: Db): string {
  const out: Record<string, Array<Row>> = {};
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name")
    .all()
    .map((row) => String(row.name))
    .filter((name) => !/_(fts|tri)(_|$)/.test(name));
  for (const name of names) out[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  return JSON.stringify(out, null, 1);
}

/**
 * A database with two roots, a channel under the first, a thread no channel entry made, a direct chat and the
 * teacher's account with its person, as the interface reported them. Returns the database file.
 */
export function seededPlaces(): string {
  const file = path.join(tempDataDir('nep-places-seed-'), 'memory.db');
  const handle = openMemoryDb(file);
  const db = dbOf(handle);
  db.prepare("INSERT INTO people (id, kind) VALUES ('person:teacher', 'member')").run();
  db.prepare(
    `INSERT INTO accounts (id, iface, native_id, native_key, kind, person_id, link) VALUES (?, 'discord', ?, ?, 'user', 'person:teacher', 'verified')`
  ).run(`discord:${TEACHER}`, TEACHER, TEACHER);
  db.prepare("INSERT INTO people (id, kind) VALUES ('person:partner', 'member')").run();
  db.prepare(
    `INSERT INTO accounts (id, iface, native_id, native_key, kind, person_id, link) VALUES ('discord:100000000000000007', 'discord', '100000000000000007', '100000000000000007', 'user', 'person:partner', 'verified')`
  ).run();
  const place = db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, parent_id, scope_kind, name, chat, partner_account, partner_person) VALUES (?, 'discord', ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  place.run(ROOT, 'server', '300000000000000001', null, 'group', 'Первый', null, null, null);
  place.run(OTHER_ROOT, 'server', '300000000000000002', null, 'group', 'Second', null, null, null);
  place.run(CHANNEL, 'channel', '200000000000000001', ROOT, 'group', 'général', 'group', null, null);
  place.run(THREAD, 'thread', '200000000000000002', CHANNEL, 'group', 'a thread', 'group', null, null);
  place.run(DM, 'dm', 'dm:100000000000000007', null, 'dm', null, 'dm', 'discord:100000000000000007', 'person:partner');
  handle.close();
  return file;
}

/** Her session's review of the first root's patterns: a version of hers becomes the description's current one. */
function review(db: Db): void {
  db.prepare(
    `INSERT INTO description_versions (id, description_id, text, author, written_at, chars, origin)
     VALUES ('dv:review:1', ?, 'Reviewed by her.', 'her', '2026-11-01T00:00:00.000Z', 16, 'review')`
  ).run(`desc:${ROOT}:patterns`);
  db.prepare("UPDATE descriptions SET current_version = 'dv:review:1' WHERE id = ?").run(`desc:${ROOT}:patterns`);
}

/** Runs one step through its write kind. */
export function writeDirect(handle: MemoryHandle, step: PlaceStep): unknown {
  if (step.kind === 'review') return review(dbOf(handle));
  return applyMemoryWrite(handle, {
    kind: WRITE_KINDS[step.kind],
    placeId: step.placeId,
    value: step.value,
    iface: 'discord',
    now: NOW,
  });
}

/** A copy of the seeded database, opened. */
export function copyOf(seed: string): MemoryHandle {
  const file = path.join(tempDataDir('nep-places-copy-'), 'memory.db');
  fs.copyFileSync(seed, file);
  return openMemoryDb(file);
}


export const lore = (extra: Array<Row> = []): Array<Row> => [
  {
    id: 'harbour-1',
    title: 'The harbour',
    keys: ['harbour', 'λιμάνι'],
    text: 'Where the boats sleep.',
    weight: 2,
    source: 'owner',
    createdAt: '2026-10-01T00:00:00.000Z',
  },
  { title: 'No id', keys: [], text: 'An entry with no id.', source: 'analyzer' },
  ...extra,
];

export const episode = (itemId: string, messages: ReadonlyArray<string>): Row => ({
  itemId,
  id: `p-${itemId}`,
  placeId: '200000000000000001',
  startAt: NOW - 60_000,
  lastAt: NOW,
  messages: messages.map((id, i) => ({ id, name: 'Άννα', text: `γραμμή ${i}`, own: i === 0 })),
});

export const recent = (lines: ReadonlyArray<Row>): Row => ({ nextId: lines.length + 1, lines });
export const line = (id: number, extra: Row = {}): Row => ({
  id,
  placeId: '200000000000000001',
  text: `είπα ${id}`,
  at: NOW - id,
  who: ['Άννα'],
  weight: 1,
  addedAt: '2026-11-09T09:00:00.000Z',
  itemId: `rc-${id}`,
  ...extra,
});

/** Two roots' lorebooks sharing an entry, a participation losing an episode and a link, recent lines that change. */
export const LIST_STEPS: ReadonlyArray<PlaceStep> = [
  { kind: 'lore', placeId: ROOT, value: lore() },
  { kind: 'lore', placeId: OTHER_ROOT, value: { entries: lore().slice(0, 1) } },
  {
    kind: 'participation',
    placeId: ROOT,
    value: { nextId: 3, episodes: [episode('pt-1', ['m1', 'm2']), episode('pt-2', ['m3'])] },
  },
  { kind: 'recent', placeId: CHANNEL, value: recent([line(1), line(2, { itemId: undefined })]) },
  { kind: 'lore', placeId: ROOT, value: lore().slice(1) },
  { kind: 'participation', placeId: ROOT, value: { nextId: 4, episodes: [episode('pt-1', ['m1'])] } },
  { kind: 'recent', placeId: CHANNEL, value: recent([line(2, { itemId: undefined }), line(3)]) },
  { kind: 'lore', placeId: 'discord:guild:300000000000000009', value: [] },
];

/** Writes every step of `LIST_STEPS` through its write kind. */
export function writeListSteps(handle: MemoryHandle): void {
  for (const step of LIST_STEPS) writeDirect(handle, step);
}
