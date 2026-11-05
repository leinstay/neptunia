// A closed memory database of a stopped core for `scripts/memory-audit.ts`, clean under every check: lines, places and a
// month of vectors from the real writers, then one row of each other kind the audit reads, with the audience its writer
// would give it. `auditWorld(edit)` copies the one built world and lets a test seed one kind of damage. Synthetic only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { OBSERVATION_VERSION } from '../../src/memory/db/observe.ts';
import { createRecord } from '../../src/memory/record.ts';
import { createVectors } from '../../src/memory/vectors.ts';
import { openTestMemory } from './memory-db/service.ts';
import { tempDir } from './tmp.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const AUDIT_SCRIPT = path.join(ROOT, 'scripts', 'memory-audit.ts');
export const GROUP = 'discord:channel:room';
export const DM = 'discord:dm:owner';
/** Words of the rows, none of which may reach the audit's output. */
export const WORDS = 'a-synthetic-word-of-the-rows';

const AT = Date.parse('2026-11-03T10:00:00.000Z');

const observed = (key: string, kind: 'dm' | 'channel', native: string) => ({
  v: OBSERVATION_VERSION,
  iface: 'discord',
  authority: 'discord/global',
  native: { kind: 'message', key: native, revision: 1 },
  place: { authority: 'discord/global', key, kind, conversation: kind === 'dm' ? 'dm' : 'group' },
  author: { kind: 'account', key: 'owner' },
  occurredAt: '2026-11-03T09:00:00.000Z',
  observedAt: '2026-11-03T09:00:01.000Z',
  text: WORDS,
  mentions: [],
  direct: kind === 'dm',
  relations: [],
});

const vectorRow = (id: string, minute: number) => ({
  meta: {
    kind: 'record',
    id,
    revision: 1,
    occurredAt: new Date(AT + minute * 60_000).toISOString(),
    placeId: null,
    by: 'owner',
    participants: ['owner'],
    sourceIds: [id],
  },
  vector: Float32Array.from([0.5, 0.5, minute + 1, 0.25]),
});

const GROUP_SCOPE = "'group', 'discord', NULL, 'aud:group:discord'";

/** The rows the real writers did not make here, each with the audience its own writer gives it. */
function addRows(db: DatabaseSync): void {
  const line = db.prepare('SELECT id FROM sources WHERE place_id = ? ORDER BY rowid LIMIT 1').get(GROUP);
  const lineId = String(line?.id);
  // A line with a described item, linked; the store holds a line's media as links.
  db.prepare("INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('source', ?, 0, 'media:held:att-kept')").run(lineId);
  db.exec(`
    INSERT INTO media (id, kind, native_ref, description, scope_kind, scope_iface, scope_dm, audience_id)
      VALUES ('media:held:att-kept', 'image', 'att-kept', '${WORDS}', ${GROUP_SCOPE});
    INSERT INTO selfreflection (id, at_ms, kind, gist, text, status, scope_kind, scope_iface, scope_dm, audience_id)
      VALUES ('selfreflection:1', ${AT}, 'entry', '${WORDS}', '${WORDS}', 'written', ${GROUP_SCOPE});
    INSERT INTO media (id, kind, owner, description, scope_kind, scope_iface, scope_dm, audience_id)
      VALUES ('media:diary:1:0', 'image', 'selfreflection:1', '${WORDS}', ${GROUP_SCOPE});
    INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('selfreflection', 'selfreflection:1', 0, 'media:diary:1:0');
    INSERT INTO claims (id, subject_kind, subject_id, kind, text, scope_kind, scope_iface, scope_dm, audience_id)
      VALUES ('claim:good', 'person', 'person:someone', 'fact', '${WORDS}', ${GROUP_SCOPE});
    INSERT INTO claim_versions (id, claim_id, text) VALUES ('claim:good:v1', 'claim:good', '${WORDS}');
    INSERT INTO descriptions (id, subject_kind, subject_id, field, current_version, scope_kind, scope_iface, scope_dm, audience_id)
      VALUES ('desc:good', 'place', '${GROUP}', 'tone', 'desc:good:v1', ${GROUP_SCOPE});
    INSERT INTO description_versions (id, description_id, text) VALUES ('desc:good:v1', 'desc:good', '${WORDS}');
    INSERT INTO episodes (id, kind, place_id, what, scope_kind, scope_iface, scope_dm, audience_id)
      VALUES ('episode:good', 'episode', '${GROUP}', '${WORDS}', ${GROUP_SCOPE});
    INSERT INTO day (id, at, what, place_id, scope_kind, scope_iface, scope_dm, audience_id)
      VALUES ('day:good', '2026-11-03T09:00:00.000Z', 'turn', '${GROUP}', ${GROUP_SCOPE});
    INSERT INTO claims (id, subject_kind, subject_id, kind, text, scope_kind, scope_iface, scope_dm, audience_id)
      VALUES ('claim:none-with-reason', 'self', 'person:self', 'self_fact', '${WORDS}', 'none', NULL, NULL, 'aud:none');
    INSERT INTO decisions (id, at, by, target_kind, target_id, action, reason)
      VALUES ('decision:1', '2026-11-03T09:00:00.000Z', 'owner', 'claims', 'claim:none-with-reason', 'audience-none-kept', 'source free on purpose');
  `);
  db.prepare("INSERT INTO claim_sources (claim_id, source_id, position) VALUES ('claim:good', ?, 0)").run(lineId);
  db.prepare("INSERT INTO episode_sources (episode_id, source_id, position) VALUES ('episode:good', ?, 0)").run(lineId);
}

async function buildWorld(file: string): Promise<void> {
  const env = await openTestMemory({ dataDir: path.dirname(file) });
  const { dataDir, memoryDb } = env;
  await memoryDb.observe(observed('channel:room', 'channel', 'room-first'), null);
  await memoryDb.observe(observed('dm:owner', 'dm', 'dm-first'), null);
  const record = createRecord({ dataDir, memoryDb });
  await record.append(GROUP, [
    {
      v: 1,
      kind: 'seen',
      messageId: 'room-second',
      revision: 1,
      occurredAt: new Date(AT).toISOString(),
      scope: {},
      by: 'owner',
      text: WORDS,
      participants: ['owner'],
    },
  ]);
  await createVectors({ dataDir, memoryDb }).append(GROUP, [vectorRow('room-second', 0), vectorRow('room-third', 1)], {
    model: 'test/embedder',
  });
  await env.close();
  const db = new DatabaseSync(file);
  addRows(db);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

let built: Promise<string> | null = null;
const theWorld = (): Promise<string> => {
  built ??= (async () => {
    const file = path.join(tempDir('nep-audit-world-'), 'memory.db');
    await buildWorld(file);
    return file;
  })();
  return built;
};

/** A copy of the clean world, with `edit` run on it with foreign keys off, closed the way a stopped core leaves it. */
export async function auditWorld(edit?: (db: DatabaseSync) => void): Promise<string> {
  const file = path.join(tempDir('nep-audit-copy-'), 'memory.db');
  fs.copyFileSync(await theWorld(), file);
  if (edit) {
    const db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys = OFF');
    edit(db);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  }
  return file;
}

/** The storage owner of the world's one month of vectors. */
export function monthOwner(db: DatabaseSync): string {
  return String(db.prepare("SELECT owner_key FROM operational WHERE kind = 'vectors' LIMIT 1").get()?.owner_key);
}

export type AuditRun = { status: number | null; stdout: string; stderr: string };

/** The script as a process with an empty environment, so nothing of a deployment can reach it. */
export function runAudit(args: ReadonlyArray<string>): AuditRun {
  const done = spawnSync(process.execPath, [AUDIT_SCRIPT, ...args], { encoding: 'utf8', env: {} });
  return { status: done.status, stdout: done.stdout, stderr: done.stderr };
}
