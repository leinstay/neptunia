// A memory database as production holds it before the diary is renamed: schema 33, the last shipped version, with the
// diary's tables, its mirror, its publications and every other row that names the diary. Written through the shipped
// migrations and plain SQL, because the current code no longer knows the old names. Synthetic data only.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb } from '../../src/memory/db/open.ts';
import { tempDir } from './tmp.ts';

/** The number of migrations shipped before the rename; the rename is the one that follows them. */
export const SHIPPED = 33;

export const PLACE = 'fake:channel:d1';
const AT = '2026-10-01T00:00:00.000Z';
const DAY2 = Date.parse('2026-10-02T00:00:00.000Z');

/** The id of the persona's storage unit of `kind`, as the catalog derives it from the canonical key. */
export const unitIdOf = (kind: string): string =>
  `unit:${createHash('sha256')
    .update(JSON.stringify({ kind, subject: { type: 'persona', id: 'persona:local' } }))
    .digest('hex')
    .slice(0, 32)}`;

export const keyJsonOf = (kind: string): string =>
  JSON.stringify({ kind, subject: { type: 'persona', id: 'persona:local' } });

type Sql = { exec(sql: string): void; prepare(sql: string): { run(...args: Array<unknown>): unknown } };

/**
 * Five entries: `dy-e1` published to the mirror place, `dy-e2` open and unpublished, `dy-e3` kept for another
 * interface, `dy-e4` with an audience that cannot be read, `dy-e5` retired. Their audience lives in `extra`.
 */
export const ENTRIES = [
  { id: 'dy-e1', at: DAY2 + 1 * 3_600_000, extra: '{}', retired: null },
  { id: 'dy-e2', at: DAY2 + 2 * 3_600_000, extra: '{}', retired: null },
  { id: 'dy-e3', at: DAY2 + 3 * 3_600_000, extra: '{"publicationAudience":{"kind":"interface","iface":"other"}}', retired: null },
  { id: 'dy-e4', at: DAY2 + 4 * 3_600_000, extra: '{"publicationAudience":{"kind":"nope"}}', retired: null },
  { id: 'dy-e5', at: DAY2 + 5 * 3_600_000, extra: '{}', retired: AT },
] as const;

/** Creates the database file at schema 33 with the rows above and returns its path. */
export function seedDiaryDatabase(): string {
  const file = path.join(tempDir('nep-diary-db-'), 'memory.db');
  const old = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, SHIPPED) });
  try {
    const db = old.db as Sql;
    const diaryUnit = unitIdOf('diary');
    const stateUnit = unitIdOf('state');
    db.exec(`
      INSERT INTO interfaces (id) VALUES ('fake'), ('other');
      INSERT INTO audiences (id, kind, iface) VALUES ('aud:group:fake', 'group', 'fake');
      INSERT INTO places (id, iface, kind, native_id, parent_id, scope_kind, name) VALUES
        ('fake:server:g1', 'fake', 'server', 'g1', NULL, 'group', NULL),
        ('${PLACE}', 'fake', 'channel', 'd1', 'fake:server:g1', 'group', 'journal');
    `);
    for (const kind of ['diary', 'state'])
      db.prepare(
        'INSERT INTO storage_units (id, kind, subject_type, subject_id, key_json) VALUES (?, ?, ?, ?, ?)'
      ).run(unitIdOf(kind), kind, 'persona', 'persona:local', keyJsonOf(kind));
    db.prepare('INSERT INTO legacy_unit_aliases (path, unit_id) VALUES (?, ?)').run('guilds/g1/diary.json', diaryUnit);
    db.prepare("INSERT INTO files (path, kind) VALUES ('guilds/g1/diary.json', 'diary')").run();
    ENTRIES.forEach((entry, position) => {
      db.prepare(
        `INSERT INTO diary (id, at_ms, kind, gist, text, scope_kind, scope_iface, extra, owner_file, position, retired_at, audience_id, owner_key)
         VALUES (?, ?, 'status', ?, ?, 'group', 'fake', ?, 'guilds/g1/diary.json', ?, ?, 'aud:group:fake', ?)`
      ).run(entry.id, entry.at, `gist ${entry.id}`, `text ${entry.id}`, entry.extra, position, entry.retired, diaryUnit);
    });
    db.prepare(
      `INSERT INTO diary_mirrors (diary_id, iface, place_id, native_ids, posted_at, owner_file, id, owner_key)
       VALUES ('dy-e1', 'fake', ?, '["m1"]', ?, 'guilds/g1/diary.json', 'mirror:dy-e1:fake:${PLACE}', ?)`
    ).run(PLACE, AT, diaryUnit);
    db.prepare(
      `INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by)
       VALUES ('mirror:diary:${PLACE}', 'diary', ?, 1, ?, 'owner')`
    ).run(PLACE, AT);
    db.prepare(
      `INSERT INTO publications (id, row_kind, row_id, content_hash, rendered, destination_place_id, status, idempotency_key, receipts, created_at, sent_at, owner_key)
       VALUES ('pub:one', 'diary', 'dy-e1', 'hash', 'text dy-e1', ?, 'sent', ?, '[]', ?, ?, ?)`
    ).run(PLACE, `diary:dy-e1:${PLACE}`, AT, AT, diaryUnit);
    db.prepare(
      `INSERT INTO publication_grants (id, row_kind, row_id, content_hash, destinations, approved_by, approved_at)
       VALUES ('grant:one', 'diary', 'dy-e2', 'hash', ?, 'owner', ?)`
    ).run(JSON.stringify([PLACE]), AT);
    db.prepare(
      `INSERT INTO turn_reads (turn_id, step, context_id, row_kind, row_id, block, ord, reader_kind)
       VALUES ('t1', 's1', '', 'diary', 'dy-e1', 'diary', 0, 'turn')`
    ).run();
    db.prepare("INSERT INTO graph_nodes (id, kind, row_id, created_at) VALUES ('diary:dy-e1', 'diary', 'dy-e1', ?)").run(AT);
    db.prepare("INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('diary', 'dy-e1', 0, 'media:diary:dy-e1-1')").run();
    db.prepare("INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('source', 'src1', 0, 'media-x')").run();
    db.prepare(
      "INSERT INTO operational (kind, owner, value, owner_file, owner_key) VALUES ('diary', 'guilds/g1/diary.json', '{}', 'guilds/g1/diary.json', ?)"
    ).run(diaryUnit);
    db.prepare("INSERT INTO operational (kind, owner, value, owner_key) VALUES ('state', 'state.json', '{}', ?)").run(stateUnit);
    db.exec(`INSERT INTO meta (key, value) VALUES ('diary_mirror_pending', '1'), ('diary_destination_pending', '1');`);
  } finally {
    old.close();
  }
  return file;
}
