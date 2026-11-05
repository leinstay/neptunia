// What a stored line's media hold after the one forward migration (src/memory/db/media-store.ts#migrateMediaStore), for what the
// old read took from elsewhere: a description the cache's cap had trimmed comes from the durable versions, and a description in
// the cache is the one kept. The rest of the old read's cases are tests/media-memory-format.test.ts. Synthetic rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineMedia, migrateMediaStore } from '../src/memory/db/media-store.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import { fixture } from './fixtures/memory-db-recall.ts';

type Env = ReturnType<typeof fixture>;
const AT = Date.parse('2026-11-01T10:00:00.000Z');

function legacy(env: Env) {
  env.db.exec(`DROP TABLE IF EXISTS media_links; DROP TABLE media;
    CREATE TABLE media (id TEXT PRIMARY KEY, kind TEXT, owner TEXT, path TEXT, native_ref TEXT, description TEXT, described_at TEXT,
      sha1 TEXT, bytes INTEGER, mime TEXT, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, audience_id TEXT, extra JSON, owner_file TEXT, retired_at TEXT, owner_key TEXT);`);
  env.db.exec('ALTER TABLE sources ADD COLUMN media TEXT');
}

function line(env: Env, native: string, ids: Array<string>) {
  const id = env.say({ native, at: AT, text: '', extra: JSON.stringify({ extra: { attachmentIds: ids } }) });
  env.db.prepare('UPDATE sources SET media = ? WHERE id = ?').run(JSON.stringify(ids.map(() => 'image')), id);
  return id;
}

function durable(env: Env, subject: string, text: string) {
  env.db
    .prepare(
      `INSERT INTO descriptions (id, subject_kind, subject_id, field, scope_kind, scope_iface, current_version)
       VALUES (?, 'media', ?, 'description', 'group', 'discord', ?)`
    )
    .run(`desc:${subject}`, subject, `${subject}:v1`);
  env.db
    .prepare(
      `INSERT INTO description_versions (id, description_id, text, origin, position) VALUES (?, ?, ?, 'media', 1)`
    )
    .run(`${subject}:v1`, `desc:${subject}`, text);
}

test('a description the cache trimmed comes from the durable versions, and the line reads it', () => {
  const env = fixture();
  try {
    legacy(env);
    const source = line(env, 'm1', ['a1']);
    durable(env, 'a1', 'from the durable row');
    env.db
      .prepare(
        "INSERT INTO media (id, kind, native_ref, scope_kind, scope_iface) VALUES ('media:attachment:a1', 'attachment', 'a1', 'group', 'discord')"
      )
      .run();
    migrateMediaStore(env.db);
    assert.equal(lineMedia(env.db, [source], internalContext()).get(source)?.[0].description, 'from the durable row');
  } finally {
    env.done();
  }
});

test('a description the cache holds is kept over the durable one', () => {
  const env = fixture();
  try {
    legacy(env);
    const source = line(env, 'm1', ['a1']);
    durable(env, 'a1', 'from the durable row');
    env.db
      .prepare(
        "INSERT INTO media (id, kind, native_ref, description, scope_kind, scope_iface) VALUES ('media:attachment:a1', 'attachment', 'a1', 'from the media row', 'group', 'discord')"
      )
      .run();
    migrateMediaStore(env.db);
    assert.equal(lineMedia(env.db, [source], internalContext()).get(source)?.[0].description, 'from the media row');
  } finally {
    env.done();
  }
});

test('a durable description with no cache row becomes the item of the reference a line names', () => {
  const env = fixture();
  try {
    legacy(env);
    const source = line(env, 'm1', ['a2']);
    durable(env, 'a2', 'from the durable row');
    migrateMediaStore(env.db);
    assert.equal(lineMedia(env.db, [source], internalContext()).get(source)?.[0].description, 'from the durable row');
  } finally {
    env.done();
  }
});
