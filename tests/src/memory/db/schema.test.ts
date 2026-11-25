// The steps of src/memory/db/schema.ts on a database written at the version before each. Each section builds the old
// file with the steps above the baseline up to that version, fills it with raw SQL, and opens it with the current
// code. Temporary files, synthetic rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, inTransaction, openMemoryDb } from '../../../../src/memory/db/open.ts';
import { BASELINE_VERSION } from '../../../../src/memory/db/schema-baseline.ts';
import { chatLines } from '../../../../src/memory/db/chat-lines.ts';
import { edgeIdOf, projectionKey } from '../../../../src/memory/db/graph.ts';
import { PERSONA_ID } from '../../../../src/memory/db/ids.ts';
import { window } from '../../../../src/memory/db/recall.ts';
import { groupContext } from '../../../../src/memory/db/scope.ts';
import { collectionId, personaKey } from '../../../../src/memory/db/unit-keys.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db, Row, Statement } from '../../../../src/memory/db/types.ts';
import { filledRows, schemaShape } from '../../../fixtures/memory-db/schema-shape.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { onLog } from '../../../../src/log.ts';
import { reproject } from '../../../../src/memory/db/graph.ts';
import { openTestMemory, tempDataDir } from '../../../fixtures/memory-db/service.ts';
import { createJournal } from '../../../../src/memory/journal.ts';
import { unitValue } from '../../../../src/memory/db/readers/common.ts';
import { placeCollection } from '../../../../src/memory/db/unit-keys.ts';
import { unitsOf } from '../../../../src/memory/db/session-size.ts';
import { schemaVersion } from '../../../../src/memory/db/open.ts';
import { startRun } from '../../../../src/memory/db/wakes.ts';
import { useIface } from '../../../fixtures/turn-world.ts';
import { observationOf } from '../../../../src/memory/db/observe-event.ts';
import { topPlaceSpelled } from '../../../../src/memory/db/ids.ts';

/** Reads `read` from `file` opened raw, before the current code touched it. */
function rawRead<TResult>(file: string, read: (db: Db) => TResult): TResult {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    return read(raw);
  } finally {
    raw.close();
  }
}

/** Opens `file` with the current code, then `read` on its connection. */
function opened<TResult>(file: string, read: (db: Db) => TResult): TResult {
  const handle = openMemoryDb(file);
  try {
    return read(dbOf(handle));
  } finally {
    handle.close();
  }
}

const rows = (db: Db, sql: string): Array<Row> =>
  db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));

/** A stored JSON text as a value. */
const parsed = (text: unknown): unknown => JSON.parse(String(text));

/** The whole database: its objects and every row. */
const everything = (db: Db): unknown => ({ shape: schemaShape(db), rows: filledRows(db) });

// Schema step 60 (src/memory/db/schema.ts) on a database written at version 59: the board keeps its errands and
// their events, outbox rows and handoffs, loses every task of another lane with its rows and the seven tables only
// development used, and takes the narrow shape of board_tasks and board_results; the selfimprovement wakes still
// waiting go. Each test builds a version 59 file with the steps above the baseline up to 59, fills it with raw SQL
// the way production holds it, and opens it with the current code. Temporary files, synthetic rows.

const DROPPED = [
  'board_agent_runs',
  'board_attempts',
  'board_comments',
  'board_dependencies',
  'board_idempotency',
  'board_questions',
  'board_reviews',
];

const TASK_COLUMNS = ['id', 'title', 'role', 'status', 'close_reason', 'created_at', 'updated_at', 'metadata'];
const RESULT_COLUMNS = ['id', 'task_id', 'kind', 'body', 'created_at'];

// Three errands filed in an order their ids do not sort in, so a rebuild that loses the filing order shows.
const ERRANDS = `
INSERT INTO board_tasks (id, lane, title, requester, role, status, close_reason, subscriber, created_at, updated_at,
  metadata) VALUES
  ('E-zz', 'errand', 'find the tide table', 'persona', 'research', 'done', NULL, 'persona',
   '2026-11-01T10:00:00.000Z', '2026-11-01T10:05:00.000Z', '{"errand":{"placeId":"synthetic:chat:1","createdAt":1}}'),
  ('E-mm', 'errand', 'fetch the ferry times', 'persona', 'research', 'failed', 'the site was down', 'persona',
   '2026-11-02T10:00:00.000Z', '2026-11-02T10:01:00.000Z', '{"errand":{"placeId":"synthetic:chat:2","createdAt":2}}'),
  ('E-aa', 'errand', 'draw the harbour', 'persona', 'artist', 'in_progress', NULL, 'persona',
   '2026-11-03T10:00:00.000Z', '2026-11-03T10:00:30.000Z', '{"errand":{"placeId":"synthetic:chat:1","createdAt":3}}'),
  ('E-qq', 'errand', 'read the notice', 'persona', 'research', 'approved', NULL, 'persona',
   '2026-11-04T10:00:00.000Z', '2026-11-04T10:00:00.000Z', '{"errand":{"placeId":"synthetic:chat:3","createdAt":4}}');
INSERT INTO board_events (task_id, actor, type, old, new, created_at) VALUES
  ('E-zz', 'core', 'status', NULL, 'approved', '2026-11-01T10:00:00.000Z'),
  ('E-zz', 'core', 'status', 'approved', 'in_progress', '2026-11-01T10:01:00.000Z'),
  ('E-zz', 'core', 'status', 'in_progress', 'done', '2026-11-01T10:05:00.000Z'),
  ('E-mm', 'core', 'status', NULL, 'approved', '2026-11-02T10:00:00.000Z'),
  ('E-mm', 'core', 'status', 'approved', 'failed', '2026-11-02T10:01:00.000Z'),
  ('E-aa', 'core', 'status', NULL, 'approved', '2026-11-03T10:00:00.000Z'),
  ('E-aa', 'core', 'status', 'approved', 'in_progress', '2026-11-03T10:00:30.000Z'),
  ('E-qq', 'core', 'status', NULL, 'approved', '2026-11-04T10:00:00.000Z');
INSERT INTO board_outbox (task_id, to_whom, kind, payload, created_at, delivered_at) VALUES
  ('E-zz', 'persona', 'done', '{"task":"E-zz","title":"find the tide table","status":"done","close_reason":null}',
   '2026-11-01T10:05:00.000Z', '2026-11-01T10:06:00.000Z'),
  ('E-mm', 'persona', 'failed',
   '{"task":"E-mm","title":"fetch the ferry times","status":"failed","close_reason":"the site was down"}',
   '2026-11-02T10:01:00.000Z', NULL);
INSERT INTO board_results (id, task_id, attempt_id, kind, body, uri, created_at) VALUES
  ('R-E-zz', 'E-zz', NULL, 'handoff', '{"result":"High water at 06:10.","evidence":[],"artifacts":[],"tests":[],"open_issues":[]}',
   NULL, '2026-11-01T10:05:00.000Z');
`;

// Development tasks with a row in every board table, a task with no lane, and an event that names no task.
const DEVELOPMENT = `
INSERT INTO board_tasks (id, lane, project, title, description, requester, role, status, subscriber, created_at,
  updated_at, lease_owner, lease_expires_at, lease_generation) VALUES
  ('T-dev1', 'dev', 'engine', 'fix the wake queue', 'a finding', 'watcher', 'dev', 'needs_validation', 'owner',
   '2026-10-01T10:00:00.000Z', '2026-10-02T10:00:00.000Z', 'dev', '2026-10-02T11:00:00.000Z', 2),
  ('T-dev2', 'dev', 'engine', 'ship the fix', NULL, 'persona', 'dev', 'done', 'persona',
   '2026-10-03T10:00:00.000Z', '2026-10-04T10:00:00.000Z', NULL, NULL, 0),
  ('T-nolane', NULL, NULL, 'filed before lanes', NULL, 'owner', NULL, 'proposed', NULL,
   '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z', NULL, NULL, 0);
INSERT INTO board_events (task_id, actor, type, old, new, created_at) VALUES
  ('T-dev1', 'watcher', 'task.created', NULL, NULL, '2026-10-01T10:00:00.000Z'),
  ('T-dev1', 'thinker', 'review', NULL, 'approve', '2026-10-01T12:00:00.000Z'),
  ('T-dev2', 'dev', 'status', 'in_progress', 'done', '2026-10-04T10:00:00.000Z'),
  ('T-nolane', 'owner', 'task.created', NULL, NULL, '2026-09-01T10:00:00.000Z'),
  (NULL, 'core', 'lease.reaped', NULL, NULL, '2026-10-05T10:00:00.000Z');
INSERT INTO board_outbox (task_id, to_whom, kind, payload, created_at, delivered_at) VALUES
  ('T-dev1', 'owner', 'needs_answer', '{}', '2026-10-01T11:00:00.000Z', NULL),
  ('T-dev1', 'watcher', 'blocked', '{}', '2026-10-01T11:30:00.000Z', NULL),
  ('T-dev2', 'persona', 'done', '{}', '2026-10-04T10:00:00.000Z', NULL);
INSERT INTO board_results (id, task_id, attempt_id, kind, body, uri, created_at) VALUES
  ('R-dev2-pr', 'T-dev2', 'A-1', 'pr', NULL, 'https://example.invalid/pull/1', '2026-10-04T10:00:00.000Z'),
  ('R-dev2-h', 'T-dev2', 'A-1', 'handoff', '{"result":"merged"}', NULL, '2026-10-04T10:00:00.000Z');
INSERT INTO board_reviews (id, task_id, principal, decision, scope, note, created_at) VALUES
  ('V-1', 'T-dev1', 'thinker', 'approve', 'plan', NULL, '2026-10-01T12:00:00.000Z');
INSERT INTO board_dependencies (task_id, depends_on_id, type, created_by, created_at) VALUES
  ('T-dev2', 'T-dev1', 'blocks', 'thinker', '2026-10-03T10:00:00.000Z');
INSERT INTO board_attempts (id, task_id, n, principal, outcome) VALUES ('A-1', 'T-dev2', 1, 'dev', 'done');
INSERT INTO board_comments (id, task_id, author, text, created_at) VALUES
  ('C-1', 'T-dev1', 'owner', 'looks right', '2026-10-01T13:00:00.000Z');
INSERT INTO board_questions (id, task_id, to_whom, text, created_at) VALUES
  ('Q-1', 'T-dev1', 'owner', 'which branch?', '2026-10-01T11:00:00.000Z');
INSERT INTO board_idempotency (key, principal, response, created_at) VALUES
  ('k-1', 'thinker', '{}', '2026-10-01T10:00:00.000Z');
INSERT INTO board_agent_runs (id, agent, started_at) VALUES ('AR-1', 'dev', '2026-10-03T10:00:00.000Z');
`;

const WAKES = `
INSERT INTO wakes (id, kind, queued_at, payload, state, handled_at) VALUES
  ('w-si-queued', 'selfimprovement', 1000, '{}', 'queued', NULL),
  ('w-si-handled', 'selfimprovement', 900, '{}', 'handled', 950),
  ('w-hb-queued', 'heartbeat', 1100, '{}', 'queued', NULL);
`;

/** A database file at schema version 59 holding `sql`, written with raw SQL after the steps up to 59. */
function at59(sql: string): string {
  const file = path.join(tempDir('nep-board-60-'), 'memory.db');
  openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 59 - BASELINE_VERSION) }).close();
  const raw = new DatabaseSync(file);
  try {
    assert.equal(raw.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v, 59);
    raw.exec(sql);
  } finally {
    raw.close();
  }
  return file;
}

const columnsOf = (db: Db, table: string): Array<string> =>
  rows(db, `PRAGMA table_info("${table}")`).map((row) => String(row.name));
const tableNames = (db: Db): Array<string> =>
  rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => String(row.name));

/** The errands' rows in every column step 60 keeps, each table in the order its rows were written. */
function errandRows(db: Db): Record<string, Array<Row>> {
  const errand = "(SELECT id FROM board_tasks WHERE lane = 'errand')";
  return {
    tasks: rows(db, `SELECT ${TASK_COLUMNS.join(', ')} FROM board_tasks WHERE id IN ${errand} ORDER BY rowid`),
    events: rows(db, `SELECT * FROM board_events WHERE task_id IN ${errand} ORDER BY seq`),
    outbox: rows(db, `SELECT * FROM board_outbox WHERE task_id IN ${errand} ORDER BY seq`),
    results: rows(
      db,
      `SELECT ${RESULT_COLUMNS.join(', ')} FROM board_results WHERE task_id IN ${errand} ORDER BY rowid`
    ),
  };
}

test('step 60 keeps every errand with its events, outbox rows and handoff as they were, in filing order', () => {
  // Bug: a rebuild that copies a column into the wrong place, drops an errand's history or its undelivered end, or
  // loses the filing order, which errandsOf lists errands in.
  const file = at59(ERRANDS + DEVELOPMENT);
  const before = rawRead(file, errandRows);
  assert.deepEqual(
    before.tasks.map((row) => row.id),
    ['E-zz', 'E-mm', 'E-aa', 'E-qq']
  );
  const after = opened(file, (db) => {
    const errand = '(SELECT id FROM board_tasks)';
    return {
      tasks: rows(db, `SELECT ${TASK_COLUMNS.join(', ')} FROM board_tasks ORDER BY rowid`),
      events: rows(db, `SELECT * FROM board_events WHERE task_id IN ${errand} ORDER BY seq`),
      outbox: rows(db, `SELECT * FROM board_outbox WHERE task_id IN ${errand} ORDER BY seq`),
      results: rows(db, `SELECT ${RESULT_COLUMNS.join(', ')} FROM board_results ORDER BY rowid`),
    };
  });
  assert.deepEqual(after, before);
});

test('step 60 deletes every task outside the errand lane with its events, outbox rows and results', () => {
  // Bug: a delete that matches `lane <> 'errand'` keeps a task with no lane, or leaves the children of a deleted task
  // behind, where the outbox count of /doctor core still counts them.
  const file = at59(ERRANDS + DEVELOPMENT);
  const left = opened(file, (db) => ({
    tasks: rows(db, 'SELECT id FROM board_tasks ORDER BY id').map((row) => row.id),
    events: rows(db, 'SELECT DISTINCT task_id FROM board_events ORDER BY task_id').map((row) => row.task_id),
    outbox: rows(db, 'SELECT DISTINCT task_id FROM board_outbox ORDER BY task_id').map((row) => row.task_id),
    results: rows(db, 'SELECT id FROM board_results ORDER BY id').map((row) => row.id),
  }));
  assert.deepEqual(left, {
    tasks: ['E-aa', 'E-mm', 'E-qq', 'E-zz'],
    events: ['E-aa', 'E-mm', 'E-qq', 'E-zz'],
    outbox: ['E-mm', 'E-zz'],
    results: ['R-E-zz'],
  });
});

test('step 60 drops the seven tables only development used and keeps events, outbox and the board version', () => {
  // Bug: a step that leaves a development table behind, or drops a table the errand store or the board's version
  // check still reads.
  const file = at59(ERRANDS + DEVELOPMENT);
  const tables = opened(file, tableNames);
  for (const table of DROPPED) assert.equal(tables.includes(table), false, `${table} is still there`);
  assert.deepEqual(
    tables.filter((name) => name.startsWith('board_')),
    ['board_events', 'board_outbox', 'board_results', 'board_schema_version', 'board_tasks']
  );
});

test('step 60 leaves board_tasks and board_results with only the columns errands use', () => {
  // Bug: a rebuild that keeps a development column, or loses one the errand store writes, so the next save throws.
  const file = at59(ERRANDS);
  const shape = opened(file, (db) => ({
    tasks: columnsOf(db, 'board_tasks'),
    results: columnsOf(db, 'board_results'),
    indexes: rows(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'board_tasks' ORDER BY name")
      .map((row) => String(row.name))
      .filter((name) => !name.startsWith('sqlite_autoindex')),
  }));
  assert.deepEqual(shape, { tasks: TASK_COLUMNS, results: RESULT_COLUMNS, indexes: ['board_tasks_status'] });
});

test('after step 60 board_tasks refuses a status no errand stands in', () => {
  // Bug: a rebuild that drops the status check lets a stray write file a task errandsOf cannot read back.
  const file = at59('');
  opened(file, (db) => {
    const insert = db.prepare(
      'INSERT INTO board_tasks (id, title, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const at = '2026-11-05T10:00:00.000Z';
    for (const status of ['approved', 'in_progress', 'done', 'failed', 'cancelled']) {
      insert.run(`E-${status}`, 'an errand', 'research', status, at, at);
    }
    for (const status of ['proposed', 'needs_answer', 'blocked']) {
      assert.throws(() => insert.run(`E-${status}`, 'an errand', 'research', status, at, at), /CHECK constraint/);
    }
  });
});

test('after step 60 board_results refuses a result kind other than handoff', () => {
  // Bug: a rebuild that drops the kind check, so a result errandOf never reads can be written.
  const file = at59(ERRANDS);
  opened(file, (db) => {
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO board_results (id, task_id, kind, body, created_at) VALUES ('R-x', 'E-mm', 'pr', '{}', 'x')"
          )
          .run(),
      /CHECK constraint/
    );
  });
});

test('step 60 deletes the selfimprovement wakes still waiting and keeps the handled ones and other kinds', () => {
  // Bug: a waiting selfimprovement wake that no service claims any more stays queued for good, or the step deletes
  // the handled history or a wake of another kind.
  const file = at59(WAKES);
  const ids = opened(file, (db) => rows(db, 'SELECT id FROM wakes ORDER BY id').map((row) => row.id));
  assert.deepEqual(ids, ['w-hb-queued', 'w-si-handled']);
});

test('a database at version 59 opens at version 60', () => {
  // Bug: a step that runs but records no version, so the next open runs it again over the narrowed tables.
  const file = at59(ERRANDS + DEVELOPMENT);
  const versions = opened(file, (db) =>
    rows(db, 'SELECT version FROM schema_version ORDER BY version').map((row) => Number(row.version))
  );
  // Changed: later steps follow step 60, so the test reads step 60's own row and no highest version.
  assert.deepEqual(
    versions.filter((version) => version === 60),
    [60]
  );
});

test('a second open after step 60 changes no table, index or row', () => {
  // Bug: a step written so that it runs, or half runs, on every open.
  const file = at59(ERRANDS + DEVELOPMENT + WAKES);
  const first = opened(file, (db) => ({ shape: schemaShape(db), rows: filledRows(db) }));
  const second = opened(file, (db) => ({ shape: schemaShape(db), rows: filledRows(db) }));
  assert.deepEqual(second, first);
});

// Schema step 61 (src/memory/db/schema.ts) on a database written at version 60: the stored word `selfreflection`
// becomes `diary` wherever it stands in a value code compares against, inside ids and paths too. The two tables,
// their column, indexes and trigger take the new name; `media_links` accepts the owner kind `diary` and no other
// spelling; the discriminators, the writers, every row id that carries the word with every column that references
// it, the picture paths, the graph's nodes and edges, the operational row's owner, the codes in the journal and the
// receipts, and the archive's service and purpose follow. The vectors the first rename left under `media:diary:` with
// a live twin go first, since the twin takes their key. A renamed id, path or key that meets an existing one stops
// the step. Each test builds a version 60 file with the steps above the baseline up to 60, fills it with raw SQL the
// way production holds it, and opens it with the current code. Temporary files, synthetic rows.

/** The owner the operational row of the persona's entries was stored under: the id `collectionId` gave the old kind. */
const OLD_OWNER = `unit:${createHash('sha256')
  .update(JSON.stringify({ kind: 'selfreflection', subject: { type: 'persona', id: PERSONA_ID } }))
  .digest('hex')
  .slice(0, 32)}`;

const AT = '2026-11-10T10:00:00.000Z';

// Entry e1's mirror row and its publication share one id, as deriveMirrorPublication writes them.
const OLD_MIRROR_PUB = 'mirror:selfreflection:e1:discord:place:p1';
const NEW_MIRROR_PUB = 'mirror:diary:e1:discord:place:p1';

// The graph of entry e1: its node, the nodes of its publication and its picture, the two edges and the witnesses.
const OLD = {
  entry: 'selfreflection:selfreflection:e1',
  oldIdEntry: 'selfreflection:diary:old1',
  publication: `publication:${OLD_MIRROR_PUB}`,
  picture: 'media:media:selfreflection:selfreflection_e1-1',
};
const NEW = {
  entry: 'diary:diary:e1',
  oldIdEntry: 'diary:diary:old1',
  publication: `publication:${NEW_MIRROR_PUB}`,
  picture: 'media:media:diary:diary_e1-1',
};
const OLD_PUBLISHED = edgeIdOf('published_as', OLD.entry, OLD.publication, null);
const OLD_ILLUSTRATED = edgeIdOf('illustrated_by', OLD.entry, OLD.picture, null);
const NEW_PUBLISHED = edgeIdOf('published_as', NEW.entry, NEW.publication, null);
const NEW_ILLUSTRATED = edgeIdOf('illustrated_by', NEW.entry, NEW.picture, null);

/** Two entries, one minted under `selfreflection:` and one the first rename left under `diary:`, with every row
 * that names them. */
const DIARY_ENTRIES = `
INSERT OR IGNORE INTO audiences (id, kind) VALUES ('aud:internal', 'internal');
INSERT INTO places (id, iface, kind, native_id) VALUES ('place:p1', 'discord', 'channel', 'n-1'),
  ('place:p2', 'discord', 'channel', 'n-2');
INSERT INTO selfreflection (id, at_ms, kind, gist, text, status, scope_kind, writer, holder_id) VALUES
  ('selfreflection:e1', 2000, 'thought', 'rain on the roof', 'It rained all day.', 'done', 'group', 'selfreflection',
   '${PERSONA_ID}'),
  ('diary:old1', 1000, 'status', 'a quiet morning', 'Nothing happened.', 'done', 'group', 'selfreflection',
   '${PERSONA_ID}');
INSERT INTO selfreflection_mirrors (selfreflection_id, iface, place_id, native_ids, posted_at, id, writer, holder_id)
  VALUES ('selfreflection:e1', 'discord', 'place:p1', '["m-1"]', '${AT}', '${OLD_MIRROR_PUB}', 'selfreflection',
   '${PERSONA_ID}');
INSERT INTO operational (kind, owner, value, writer, holder_id) VALUES
  ('selfreflection', '${OLD_OWNER}', '{"$has":["posts"],"updatedAt":2000}', 'selfreflection', '${PERSONA_ID}');
INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by) VALUES
  ('mirror:diary:place:p1', 'selfreflection', 'place:p1', 1, '${AT}', 'owner'),
  ('mirror:selfreflection:place:p2', 'selfreflection', 'place:p2', 1, '${AT}', 'owner');
INSERT INTO publication_grants (id, row_kind, row_id, content_hash, destinations, approved_by, approved_at) VALUES
  ('grant:selfreflection:e1', 'selfreflection', 'selfreflection:e1', 'h-1', '["place:p1"]', 'owner', '${AT}');
INSERT INTO publications (id, row_kind, row_id, destination_place_id, grant_id, status, idempotency_key, created_at,
  writer, holder_id) VALUES
  ('${OLD_MIRROR_PUB}', 'selfreflection', 'selfreflection:e1', 'place:p1', 'grant:selfreflection:e1', 'sent',
   'selfreflection:selfreflection:e1:place:p1', '${AT}', 'selfreflection', '${PERSONA_ID}'),
  ('pub:0002', 'selfreflection', 'diary:old1', 'place:p1', NULL, 'sent', 'selfreflection:diary:old1:place:p1', '${AT}',
   'selfreflection', '${PERSONA_ID}');
`;

/** The pictures of both entries, their links and vectors, and an orphan vector the first rename left behind. */
const PICTURES = `
INSERT INTO media (id, kind, path, owner, mime, scope_kind) VALUES
  ('media:selfreflection:selfreflection_e1-1', 'image', 'media/selfreflection/selfreflection_e1-1.png',
   'selfreflection:e1', 'image/png', 'group'),
  ('media:selfreflection:diary_old1-1', 'image', 'media/selfreflection/diary_old1-1.png', 'diary:old1', 'image/png',
   'group');
INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES
  ('selfreflection', 'selfreflection:e1', 0, 'media:selfreflection:selfreflection_e1-1'),
  ('selfreflection', 'diary:old1', 0, 'media:selfreflection:diary_old1-1'),
  ('source', 'src:1', 0, 'media:other-1');
INSERT INTO vectors (item_id, chunk_key, model, dims, kind) VALUES
  ('media:selfreflection:selfreflection_e1-1', 'media:media:selfreflection:selfreflection_e1-1', 'm', 2, 'media'),
  ('media:selfreflection:diary_old1-1', 'media:media:selfreflection:diary_old1-1', 'm', 2, 'media'),
  ('media:diary:diary_old1-1', 'media:media:diary:diary_old1-1', 'orphan', 2, 'media');
`;

const GRAPH = `
INSERT INTO graph_nodes (id, kind, row_id, created_at) VALUES
  ('${OLD.entry}', 'selfreflection', 'selfreflection:e1', '${AT}'),
  ('${OLD.oldIdEntry}', 'selfreflection', 'diary:old1', '${AT}'),
  ('${OLD.publication}', 'publication', '${OLD_MIRROR_PUB}', '${AT}'),
  ('${OLD.picture}', 'media', 'media:selfreflection:selfreflection_e1-1', '${AT}');
INSERT INTO graph_edges (id, src, predicate, dst, audience_id, evidence_id, recorded_at, projection_key, owner_key)
  VALUES
  ('${OLD_PUBLISHED}', '${OLD.entry}', 'published_as', '${OLD.publication}', 'aud:internal', NULL, '${AT}',
   '${projectionKey('published_as', OLD.entry, OLD.publication)}', 'publications:${OLD_MIRROR_PUB}'),
  ('${OLD_ILLUSTRATED}', '${OLD.entry}', 'illustrated_by', '${OLD.picture}', 'aud:internal', NULL, '${AT}',
   '${projectionKey('illustrated_by', OLD.entry, OLD.picture)}', 'selfreflection:selfreflection:e1');
INSERT INTO node_access (node_id, audience_id, evidence_id) VALUES
  ('${OLD.entry}', 'aud:internal', '${OLD.entry}'),
  ('${OLD.oldIdEntry}', 'aud:internal', '${OLD.oldIdEntry}'),
  ('${OLD.picture}', 'aud:internal', '${OLD_ILLUSTRATED}'),
  ('${OLD.publication}', 'aud:internal', '${OLD_PUBLISHED}');
`;

/** The engine words the journal, a delivery receipt and the request archive keep. */
const HISTORY = `
INSERT INTO day (id, at, what, extra) VALUES
  ('day:1', '${AT}', 'turn', '{"mode":"selfreflection","result":{"code":"selfreflection-mirror"},"actions":[{"code":"selfreflection-draw-only"},{"code":"ok"}]}'),
  ('day:2', '${AT}', 'turn', '{"mode":"reply","result":{"code":"ok"}}');
INSERT INTO wakes (id, kind, queued_at, payload, state) VALUES ('w-1', 'heartbeat', 1, '{}', 'handled');
INSERT INTO deliveries (key, wake_id, payload, state, queued_at, receipt) VALUES
  ('del:1', 'w-1', '{}', 'failed', 1, '{"code":"selfreflection-mirror","ok":false}');
INSERT INTO model_requests (id, schema_version, status, started_at, messages, service, purpose) VALUES
  ('mr:1', 1, 'ok', '${AT}', '[]', 'selfreflection', 'selfreflection-planner'),
  ('mr:2', 1, 'ok', '${AT}', '[]', 'core', 'reply');
`;

const DIARY_ALL = DIARY_ENTRIES + PICTURES + GRAPH + HISTORY;

/** The step that brings a database from 60 to 61. */
const step61 = MIGRATIONS[61 - BASELINE_VERSION - 1];

/** A database file at schema version 60 holding `sql`, written with raw SQL after the steps up to 60. */
function at60(sql: string): string {
  const file = path.join(tempDir('nep-diary-61-'), 'memory.db');
  openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 60 - BASELINE_VERSION) }).close();
  const raw = new DatabaseSync(file);
  try {
    assert.equal(raw.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v, 60);
    raw.exec(sql);
  } finally {
    raw.close();
  }
  return file;
}

/** Opens `file` with the steps up to version 68, then `read` on its connection. */
function openedTo68<TResult>(file: string, read: (db: Db) => TResult): TResult {
  // Up to version 68: step 69 drops the grants these tests follow through step 61.
  const handle = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 68 - BASELINE_VERSION) });
  try {
    return read(dbOf(handle));
  } finally {
    handle.close();
  }
}

const values = (db: Db, sql: string): Array<unknown> => rows(db, sql).map((row) => Object.values(row)[0]);
const versionOf = (db: Db): number => Number(db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v);

test('a database at version 60 opens at version 61', () => {
  // Bug: a step that runs but records no version, so the next open runs it again over the renamed tables.
  const file = at60(DIARY_ALL);
  // Changed: step 62 follows step 61, so the test reads step 61's own row and no highest version.
  const versions = openedTo68(file, (db) => values(db, 'SELECT version FROM schema_version'));
  assert.deepEqual(
    versions.filter((version) => version === 61),
    [61]
  );
});

test('step 61 renames the two tables and the column and keeps every entry and mirror row', () => {
  // Bug: a rename that copies the tables and loses a row, or leaves the column under the old name, so every SQL of
  // diary-entries.ts and place-holder.ts that reads `diary_mirrors.diary_id` throws.
  const file = at60(DIARY_ALL);
  const after = openedTo68(file, (db) => ({
    entries: values(db, 'SELECT id FROM diary ORDER BY at_ms'),
    mirrors: rows(db, 'SELECT id, diary_id, iface, place_id, native_ids FROM diary_mirrors'),
  }));
  assert.deepEqual(after, {
    entries: ['diary:old1', 'diary:e1'],
    mirrors: [
      { id: NEW_MIRROR_PUB, diary_id: 'diary:e1', iface: 'discord', place_id: 'place:p1', native_ids: '["m-1"]' },
    ],
  });
});

test('after step 61 no table, index or trigger is named after selfreflection or names it in its SQL', () => {
  // Bug: SQLite keeps an index's and a trigger's name through a table rename, and the trigger's body still names the
  // old table, so the first insert into diary_mirrors fails.
  const file = at60(DIARY_ALL);
  const left = openedTo68(file, (db) =>
    rows(db, "SELECT type, name FROM sqlite_master WHERE name LIKE '%selfreflection%' OR sql LIKE '%selfreflection%'")
  );
  assert.deepEqual(left, []);
  const objects = openedTo68(file, (db) =>
    values(
      db,
      "SELECT name FROM sqlite_master WHERE tbl_name IN ('diary', 'diary_mirrors') AND type <> 'table' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name"
    )
  );
  assert.deepEqual(objects, [
    'diary_holder',
    'diary_mirrors_diary',
    'diary_mirrors_holder',
    'diary_mirrors_id',
    'diary_mirrors_id_fill',
  ]);
});

test('after step 61 no row of a migrated database holds the old word in any form', () => {
  // Bug: a rename that misses one id, path, key or JSON word, which code then compares against `diary` and never
  // finds. Every seeded value that holds the word is one code compares against.
  const file = at60(DIARY_ALL);
  const left = openedTo68(file, (db) =>
    Object.entries(filledRows(db)).flatMap(([table, all]) =>
      all.filter((row) => /selfreflection/i.test(row)).map((row) => `${table} ${row}`)
    )
  );
  assert.deepEqual(left, []);
});

test("after step 61 a mirror row written with no id gets the trigger's id from the renamed column", () => {
  // Bug: the recreated trigger reads the old column, so a new mirror row's id is `mirror:::` or the insert throws.
  const file = at60(DIARY_ALL);
  const id = openedTo68(file, (db) => {
    db.prepare(
      "INSERT INTO diary_mirrors (diary_id, iface, place_id) VALUES ('diary:e9', 'discord', 'place:p2')"
    ).run();
    return db.prepare("SELECT id FROM diary_mirrors WHERE diary_id = 'diary:e9'").get()?.id;
  });
  assert.equal(id, 'mirror:diary:e9:discord:place:p2');
});

test('after step 61 media_links takes the owner kind diary and refuses selfreflection', () => {
  // Bug: the rebuild keeps the old CHECK, so the next picture link of a diary entry fails, or loses the links.
  const file = at60(DIARY_ALL);
  openedTo68(file, (db) => {
    assert.deepEqual(rows(db, 'SELECT owner_kind, owner_id, media_id FROM media_links ORDER BY owner_id'), [
      { owner_kind: 'diary', owner_id: 'diary:e1', media_id: 'media:diary:diary_e1-1' },
      { owner_kind: 'diary', owner_id: 'diary:old1', media_id: 'media:diary:diary_old1-1' },
      { owner_kind: 'source', owner_id: 'src:1', media_id: 'media:other-1' },
    ]);
    const link = db.prepare('INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES (?, ?, 1, ?)');
    link.run('diary', 'diary:e1', 'media:x');
    assert.throws(() => link.run('selfreflection', 'diary:e1', 'media:y'), /CHECK constraint/);
  });
});

test('step 61 renames the entry ids under selfreflection: and keeps those already under diary:', () => {
  // Bug: the store mints `diary:<uuid>` and finds none of the persona's older entries, or a blind replace turns an id
  // the first rename left as `diary:old1` into something else.
  const file = at60(DIARY_ALL);
  const ids = openedTo68(file, (db) => ({
    entries: values(db, 'SELECT id FROM diary ORDER BY id'),
    publications: values(db, 'SELECT row_id FROM publications ORDER BY row_id'),
    grants: values(db, 'SELECT row_id FROM publication_grants'),
    media: values(db, 'SELECT owner FROM media ORDER BY owner'),
  }));
  assert.deepEqual(ids, {
    entries: ['diary:e1', 'diary:old1'],
    publications: ['diary:e1', 'diary:old1'],
    grants: ['diary:e1'],
    media: ['diary:e1', 'diary:old1'],
  });
});

test('step 61 renames the publications id, kind, key, grant and writer', () => {
  // Bug: the mirrors' drain selects `row_kind = 'diary'` and sends nothing, a key that keeps the old word lets the
  // publisher queue the same post twice, or a mirror's publication loses its mirror row's id.
  const file = at60(DIARY_ALL);
  const after = openedTo68(file, (db) =>
    rows(db, 'SELECT id, row_kind, idempotency_key, grant_id, writer FROM publications ORDER BY id')
  );
  assert.deepEqual(after, [
    {
      id: NEW_MIRROR_PUB,
      row_kind: 'diary',
      idempotency_key: 'diary:diary:e1:place:p1',
      grant_id: 'grant:diary:e1',
      writer: 'diary',
    },
    {
      id: 'pub:0002',
      row_kind: 'diary',
      idempotency_key: 'diary:diary:old1:place:p1',
      grant_id: null,
      writer: 'diary',
    },
  ]);
});

test('step 61 renames the publication grant its id and kind', () => {
  // Bug: preparePublication looks the grant up by `row_kind = 'diary'` and the entry, finds none, and refuses the post.
  const file = at60(DIARY_ALL);
  const after = openedTo68(file, (db) => rows(db, 'SELECT id, row_kind, row_id FROM publication_grants'));
  assert.deepEqual(after, [{ id: 'grant:diary:e1', row_kind: 'diary', row_id: 'diary:e1' }]);
});

test('after step 61 the publications and grants guards refuse a changed key and a delete again', () => {
  // Bug: the step drops the guards to update the keys and does not put them back.
  const file = at60(DIARY_ALL);
  openedTo68(file, (db) => {
    assert.throws(
      () => db.prepare("UPDATE publications SET idempotency_key = 'x' WHERE row_kind = 'diary'").run(),
      /keeps its row and its key/
    );
    assert.throws(() => db.prepare("DELETE FROM publications WHERE row_kind = 'diary'").run(), /never deleted/);
    assert.throws(() => db.prepare("UPDATE publication_grants SET row_id = 'x' WHERE row_kind = 'diary'").run());
    assert.throws(() => db.prepare("DELETE FROM publication_grants WHERE row_kind = 'diary'").run());
  });
});

test('step 61 renames the writer of the entries, their mirrors and the operational row', () => {
  // Bug: place-holder.ts finds the persona's rows by the writer `diary`, so rows left under the old writer are
  // never read and the next save writes a second set beside them.
  const file = at60(DIARY_ALL);
  const writers = openedTo68(file, (db) => ({
    entries: values(db, 'SELECT DISTINCT writer FROM diary'),
    mirrors: values(db, 'SELECT DISTINCT writer FROM diary_mirrors'),
    operational: values(db, "SELECT writer FROM operational WHERE owner LIKE 'unit:%'"),
  }));
  assert.deepEqual(writers, { entries: ['diary'], mirrors: ['diary'], operational: ['diary'] });
});

test('step 61 moves the operational row to the kind diary and the owner collectionId gives that kind', () => {
  // Bug: the store reads the row by `kind = 'diary'`, and a row whose owner still hashes the old kind is a second
  // value the persona's unit never finds.
  const file = at60(DIARY_ALL);
  const after = openedTo68(file, (db) => rows(db, "SELECT kind, owner, value FROM operational WHERE writer = 'diary'"));
  assert.deepEqual(after, [
    { kind: 'diary', owner: collectionId(personaKey('diary')), value: '{"$has":["posts"],"updatedAt":2000}' },
  ]);
});

test('step 61 renames the mirrors kind and ids and keeps an id the first rename left as mirror:diary:', () => {
  // Bug: mirror-config.ts looks a mirror up by `row_kind = 'diary'` and the place, so a row left under the old
  // kind is a mirror the persona never posts to, and a second one is registered beside it.
  const file = at60(DIARY_ALL);
  const after = openedTo68(file, (db) => rows(db, 'SELECT id, place_id, row_kind FROM mirrors ORDER BY place_id'));
  assert.deepEqual(after, [
    { id: 'mirror:diary:place:p1', place_id: 'place:p1', row_kind: 'diary' },
    { id: 'mirror:diary:place:p2', place_id: 'place:p2', row_kind: 'diary' },
  ]);
});

test('step 61 renames the picture ids, their paths and their vectors in folder and file name', () => {
  // Bug: the media job mints `media:diary:diary_<id>-<n>` for a renamed entry and writes a second row and file beside
  // the stored one, or a path that keeps the old folder reads as missing once the folder is moved.
  const file = at60(DIARY_ALL);
  const after = openedTo68(file, (db) => ({
    media: rows(db, 'SELECT id, path FROM media ORDER BY id'),
    vectors: rows(db, 'SELECT item_id, chunk_key FROM vectors ORDER BY item_id'),
  }));
  assert.deepEqual(after, {
    media: [
      { id: 'media:diary:diary_e1-1', path: 'media/diary/diary_e1-1.png' },
      { id: 'media:diary:diary_old1-1', path: 'media/diary/diary_old1-1.png' },
    ],
    vectors: [
      { item_id: 'media:diary:diary_e1-1', chunk_key: 'media:media:diary:diary_e1-1' },
      { item_id: 'media:diary:diary_old1-1', chunk_key: 'media:media:diary:diary_old1-1' },
    ],
  });
});

test('step 61 deletes an orphan media:diary: vector whose media:selfreflection: twin is live', () => {
  // Bug: the rename of the twin's chunk_key hits the UNIQUE key of the orphan and the whole open fails.
  const file = at60(DIARY_ALL);
  // The orphan's model is `orphan` and the twin's `m`, so the row left under the new key shows which one stayed.
  const before = rawRead(file, (db) =>
    rows(db, "SELECT item_id, model FROM vectors WHERE item_id LIKE 'media:%diary_old1-1' ORDER BY item_id")
  );
  assert.deepEqual(before, [
    { item_id: 'media:diary:diary_old1-1', model: 'orphan' },
    { item_id: 'media:selfreflection:diary_old1-1', model: 'm' },
  ]);
  const after = openedTo68(file, (db) =>
    rows(db, "SELECT item_id, chunk_key, model FROM vectors WHERE item_id LIKE 'media:%diary_old1-1'")
  );
  assert.deepEqual(after, [
    { item_id: 'media:diary:diary_old1-1', chunk_key: 'media:media:diary:diary_old1-1', model: 'm' },
  ]);
});

test('step 61 renames the graph nodes of the entries, the publication and the picture with their row ids', () => {
  // Bug: graph.ts projects a diary entry to `diary:<id>` and finds the old node, so it writes a second node and the
  // first keeps the entry's witnesses.
  const file = at60(DIARY_ALL);
  const nodes = openedTo68(file, (db) =>
    rows(db, "SELECT id, kind, row_id FROM graph_nodes WHERE kind IN ('diary', 'media', 'publication') ORDER BY id")
  );
  assert.deepEqual(nodes, [
    { id: NEW.entry, kind: 'diary', row_id: 'diary:e1' },
    { id: NEW.oldIdEntry, kind: 'diary', row_id: 'diary:old1' },
    { id: NEW.picture, kind: 'media', row_id: 'media:diary:diary_e1-1' },
    { id: NEW.publication, kind: 'publication', row_id: NEW_MIRROR_PUB },
  ]);
});

test('step 61 moves the edges to the renamed ends with their keys, owners and ids recomputed', () => {
  // Bug: the projection recomputes an edge's id from its ends and finds none under the old hash, writes a second
  // edge that hits the UNIQUE projection_key, or retires the edges of an owner key it does not recognise.
  const file = at60(DIARY_ALL);
  const edges = openedTo68(file, (db) =>
    rows(db, 'SELECT id, src, dst, projection_key, owner_key FROM graph_edges ORDER BY predicate')
  );
  assert.deepEqual(edges, [
    {
      id: NEW_ILLUSTRATED,
      src: NEW.entry,
      dst: NEW.picture,
      projection_key: projectionKey('illustrated_by', NEW.entry, NEW.picture),
      owner_key: 'diary:diary:e1',
    },
    {
      id: NEW_PUBLISHED,
      src: NEW.entry,
      dst: NEW.publication,
      projection_key: projectionKey('published_as', NEW.entry, NEW.publication),
      owner_key: `publications:${NEW_MIRROR_PUB}`,
    },
  ]);
});

test('step 61 moves the witnesses of the renamed nodes and of the recomputed edges', () => {
  // Bug: node_access keeps the old node ids and edge ids, so the audience check finds no witness and hides the entry.
  const file = at60(DIARY_ALL);
  const access = openedTo68(file, (db) => rows(db, 'SELECT node_id, evidence_id FROM node_access ORDER BY node_id'));
  assert.deepEqual(access, [
    { node_id: NEW.entry, evidence_id: NEW.entry },
    { node_id: NEW.oldIdEntry, evidence_id: NEW.oldIdEntry },
    { node_id: NEW.picture, evidence_id: NEW_ILLUSTRATED },
    { node_id: NEW.publication, evidence_id: NEW_PUBLISHED },
  ]);
});

test('after step 61 every column that references a renamed id finds the row it names', () => {
  // Bug: an id renamed in its own table and not in a column that points at it, which leaves a dangling reference the
  // reader joins on and loses: an entry's mirror, publication, grant, picture or link, a picture's vector, a mirror's
  // publication, a node's row, an edge's end or owner, or a witness.
  const file = at60(DIARY_ALL);
  const dangling = openedTo68(file, (db) => {
    const count = (sql: string): number => Number(values(db, `SELECT COUNT(*) FROM ${sql}`)[0]);
    return {
      'diary_mirrors.diary_id': count('diary_mirrors m WHERE m.diary_id NOT IN (SELECT id FROM diary)'),
      'diary_mirrors.id = publications.id': count('diary_mirrors m WHERE m.id NOT IN (SELECT id FROM publications)'),
      'publications.row_id': count('publications p WHERE p.row_id NOT IN (SELECT id FROM diary)'),
      'publications.grant_id': count(
        'publications p WHERE p.grant_id IS NOT NULL AND p.grant_id NOT IN (SELECT id FROM publication_grants)'
      ),
      'publication_grants.row_id': count('publication_grants g WHERE g.row_id NOT IN (SELECT id FROM diary)'),
      'media.owner': count('media m WHERE m.owner NOT IN (SELECT id FROM diary)'),
      'media_links.owner_id': count(
        "media_links l WHERE l.owner_kind = 'diary' AND l.owner_id NOT IN (SELECT id FROM diary)"
      ),
      'media_links.media_id': count(
        "media_links l WHERE l.owner_kind = 'diary' AND l.media_id NOT IN (SELECT id FROM media)"
      ),
      'vectors.item_id': count("vectors v WHERE v.kind = 'media' AND v.item_id NOT IN (SELECT id FROM media)"),
      'vectors.chunk_key': count(
        "vectors v WHERE v.kind = 'media' AND v.chunk_key NOT IN (SELECT 'media:' || id FROM media)"
      ),
      'graph_nodes.row_id': count(
        `graph_nodes n WHERE (n.kind = 'diary' AND n.row_id NOT IN (SELECT id FROM diary))
          OR (n.kind = 'publication' AND n.row_id NOT IN (SELECT id FROM publications))
          OR (n.kind = 'media' AND n.row_id NOT IN (SELECT id FROM media))`
      ),
      'graph_nodes.id': count("graph_nodes n WHERE n.id <> n.kind || ':' || n.row_id"),
      'graph_edges.src': count('graph_edges e WHERE e.src NOT IN (SELECT id FROM graph_nodes)'),
      'graph_edges.dst': count('graph_edges e WHERE e.dst NOT IN (SELECT id FROM graph_nodes)'),
      'graph_edges.owner_key': count(
        `graph_edges e WHERE e.owner_key NOT IN (SELECT 'diary:' || id FROM diary)
          AND e.owner_key NOT IN (SELECT 'publications:' || id FROM publications)`
      ),
      'node_access.node_id': count('node_access a WHERE a.node_id NOT IN (SELECT id FROM graph_nodes)'),
      'node_access.evidence_id': count(
        `node_access a WHERE a.evidence_id NOT IN (SELECT id FROM graph_nodes)
          AND a.evidence_id NOT IN (SELECT id FROM graph_edges)`
      ),
    };
  });
  assert.deepEqual(
    Object.entries(dangling).filter(([, n]) => n > 0),
    []
  );
});

test("step 61 renames the journal's mode and codes and a receipt's code, and leaves other words alone", () => {
  // Bug: the label lookup tools.result.reasons[<code>] finds no `selfreflection-mirror` any more and shows the persona
  // a raw code, or the step rewrites a mode or code that never held the word.
  const file = at60(DIARY_ALL);
  const after = openedTo68(file, (db) => ({
    day: values(db, 'SELECT extra FROM day ORDER BY id').map(parsed),
    receipt: parsed(values(db, "SELECT receipt FROM deliveries WHERE key = 'del:1'")[0]),
  }));
  assert.deepEqual(after, {
    day: [
      { mode: 'diary', result: { code: 'diary-mirror' }, actions: [{ code: 'diary-draw-only' }, { code: 'ok' }] },
      { mode: 'reply', result: { code: 'ok' } },
    ],
    receipt: { code: 'diary-mirror', ok: false },
  });
});

test("step 61 renames the archive's service and purpose of a diary request and no other request's", () => {
  // Bug: the usage report groups by service and purpose, so the diary's old requests stand apart from its new ones.
  const file = at60(DIARY_ALL);
  const after = openedTo68(file, (db) => rows(db, 'SELECT id, service, purpose FROM model_requests ORDER BY id'));
  assert.deepEqual(after, [
    { id: 'mr:1', service: 'diary', purpose: 'diary-planner' },
    { id: 'mr:2', service: 'core', purpose: 'reply' },
  ]);
});

test('step 61 throws and leaves the file at 60 when a renamed entry id already exists', () => {
  // Bug: the rename overwrites or merges two entries whose ids meet under the new word, and the persona's diary loses
  // one.
  const file = at60(
    `${DIARY_ENTRIES}
    INSERT INTO selfreflection (id, at_ms, kind, status, scope_kind) VALUES ('selfreflection:twin', 3000, 'thought',
      'done', 'group'), ('diary:twin', 3001, 'thought', 'done', 'group');`
  );
  assert.throws(() => openMemoryDb(file).close());
  const left = rawRead(file, (db) => ({
    version: versionOf(db),
    entries: values(db, "SELECT id FROM selfreflection WHERE id LIKE '%twin' ORDER BY id"),
  }));
  assert.deepEqual(left, { version: 60, entries: ['diary:twin', 'selfreflection:twin'] });
});

test('step 61 throws and leaves the file at 60 when a renamed picture id already exists', () => {
  // Bug: a picture's new id meets a live row under media:diary:, and the rename drops one of the two pictures.
  const file = at60(
    `${DIARY_ENTRIES}${PICTURES}
    INSERT INTO media (id, kind, path, owner, scope_kind) VALUES
      ('media:diary:diary_e1-1', 'image', 'media/diary/other-1.png', 'diary:old1', 'group');`
  );
  assert.throws(() => openMemoryDb(file).close());
  assert.equal(rawRead(file, versionOf), 60);
});

test('step 61 throws and leaves the file at 60 when a renamed picture path already exists', () => {
  // Bug: two rows come to name one file, and the deploy's rename of the files overwrites one picture with another.
  const file = at60(
    `${DIARY_ENTRIES}${PICTURES}
    INSERT INTO media (id, kind, path, owner, scope_kind) VALUES
      ('media:other-2', 'image', 'media/diary/diary_e1-1.png', NULL, 'group');`
  );
  assert.throws(() => openMemoryDb(file).close());
  assert.equal(rawRead(file, versionOf), 60);
});

test('step 61 renames two picture rows that share one file before it and leaves them sharing it', () => {
  // Bug: the collision check counts two rows that name one file before the step, a diary picture and the same file
  // as an interface's attachment, as a merge the rename would make, so the step refuses a database that has no clash.
  const file = at60(
    `${DIARY_ENTRIES}${PICTURES}
    INSERT INTO media (id, kind, path, owner, scope_kind) VALUES
      ('media:discord:9001', 'image', 'media/selfreflection/selfreflection_e1-1.png', NULL, 'group');`
  );
  const paths = openedTo68(file, (db) =>
    values(db, "SELECT path FROM media WHERE id IN ('media:discord:9001', 'media:diary:diary_e1-1') ORDER BY id")
  );
  assert.deepEqual(paths, ['media/diary/diary_e1-1.png', 'media/diary/diary_e1-1.png']);
});

test('step 61 throws and leaves the file at 60 when a renamed publication key already exists', () => {
  // Bug: a renamed key meets a publication already under it, and one post's delivery record is lost or merged.
  const file = at60(
    `${DIARY_ENTRIES}
    INSERT INTO publications (id, row_kind, row_id, status, idempotency_key, created_at) VALUES
      ('pub:0003', 'diary', 'diary:e1', 'sent', 'diary:diary:e1:place:p1', '${AT}');`
  );
  assert.throws(() => openMemoryDb(file).close());
  assert.equal(rawRead(file, versionOf), 60);
});

test('a collision on one renamed id rolls the whole step back and changes nothing in the file', () => {
  // Bug: the step renames the tables, the graph or the pictures before it meets the collision, and the throw leaves
  // a half-renamed database that the next open can neither migrate nor read.
  const file = at60(
    `${DIARY_ALL}
    INSERT INTO selfreflection (id, at_ms, kind, status, scope_kind) VALUES ('diary:e1', 4000, 'thought', 'done', 'group');`
  );
  const before = rawRead(file, everything);
  assert.throws(() => openMemoryDb(file).close());
  assert.deepEqual(rawRead(file, everything), before);
});

test('a fresh database and one brought from 60 by step 61 have the same shape', () => {
  // Bug: the step recreates an index, the trigger or media_links in a form the baseline plus the steps does not
  // give a new database, so the two drift apart and the next step meets two shapes.
  const file = at60(DIARY_ALL);
  const migrated = openedTo68(file, schemaShape);
  const fresh = openedTo68(path.join(tempDir('nep-diary-61-fresh-'), 'memory.db'), schemaShape);
  assert.ok('table diary' in fresh, 'a fresh database has the table diary');
  assert.deepEqual(migrated, fresh);
});

test('step 61 run a second time on a migrated database changes no table, index or row', () => {
  // Bug: a step written so that a second run renames again, fails on the tables it already moved, or deletes the
  // vectors it renamed.
  const file = at60(DIARY_ALL);
  const handle = openMemoryDb(file);
  try {
    const db = dbOf(handle);
    // Changed: step 62 follows step 61, so the database holds step 61's row and stands past version 61.
    assert.ok(values(db, 'SELECT version FROM schema_version').includes(61));
    const first = everything(db);
    if (step61 === undefined) assert.fail('MIGRATIONS holds no step 61');
    inTransaction(db, () => (typeof step61 === 'function' ? step61(db) : db.exec(step61)));
    assert.deepEqual(everything(db), first);
  } finally {
    handle.close();
  }
});

// Schema step 62 (src/memory/db/schema.ts) on a database written at version 61: the members' ping states leave the
// memory. The keys `pings` and `pingsOff` leave the value of every operational row of kind `place`, the key `notify`
// leaves the send of every diary entry, and the column `memberships.pings_off` is dropped. Each test builds a version
// 61 file with the steps above the baseline up to 61, fills it with raw SQL the way production holds it, and opens it
// with the current code. Temporary files, synthetic rows.

/** Two places with notes, one holding the ping states and the list of the earlier switch, and a row of another kind. */
const NOTES = `
INSERT INTO operational (kind, owner, value, writer, holder_id) VALUES
  ('place', 'place:p1', '{"$has":["injokes"],"learnedNextId":3,"pings":{"a1":"on","a2":"off"},"pingsOff":["a3"],"notesUpdatedAt":"2026-11-01T10:00:00.000Z"}', 'place', 'unit:p1'),
  ('place', 'place:p2', '{"$has":[],"learnedNextId":1,"emojiUsage":{}}', 'place', 'unit:p2'),
  ('recent', 'place:p1', '{"pings":{"a1":"on"},"lines":[]}', 'recent', 'unit:r1');
`;

/** Two diary entries, one whose send kept who asked to be pinged. */
const PINGS_ENTRIES = `
INSERT INTO diary (id, at_ms, kind, status, scope_kind, extra) VALUES
  ('diary:e1', 1000, 'thought', 'done', 'group', '{"send":{"messages":["one","two"],"mentions":[["a1"],[]],"notify":[true,false],"maxMessageBytes":8}}'),
  ('diary:e2', 2000, 'thought', 'done', 'group', '{"send":{"messages":["three"],"mentions":[[]]}}');
`;

/** Two memberships, one with the column filled the way an older writer could leave it. */
const MEMBERSHIPS = `
INSERT INTO memberships (id, account_id, place_id, nick, roles, addressed_as, pings_off, extra) VALUES
  ('mem:a1', 'a1', 'place:p1', 'Ada', '["r1"]', '[{"name":"Ada","count":2}]', 1, NULL),
  ('mem:a2', 'a2', NULL, NULL, NULL, NULL, NULL, '{"x":1}');
`;

const PINGS_ALL = NOTES + PINGS_ENTRIES + MEMBERSHIPS;

/** The step that brings a database from 61 to 62. */
const step62 = MIGRATIONS[62 - BASELINE_VERSION - 1];

/** A database file at schema version 61 holding `sql`, written with raw SQL after the steps up to 61. */
function at61(sql: string): string {
  const file = path.join(tempDir('nep-pings-62-'), 'memory.db');
  openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 61 - BASELINE_VERSION) }).close();
  const raw = new DatabaseSync(file);
  try {
    assert.equal(raw.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v, 61);
    raw.exec(sql);
  } finally {
    raw.close();
  }
  return file;
}

test('a database at version 61 opens with step 62 recorded', () => {
  // Bug: a step that runs but records no version, so the next open runs it again.
  const file = at61(PINGS_ALL);
  const versions = opened(file, (db) => rows(db, 'SELECT version FROM schema_version').map((row) => row.version));
  assert.deepEqual(
    versions.filter((version) => version === 62),
    [62]
  );
});

test('step 62 takes the ping states out of a place row and keeps its other keys', () => {
  // Bug: the states stay in the notes, so a place's operational row keeps who chose on and off after the feature left.
  const file = at61(PINGS_ALL);
  const value = opened(file, (db) =>
    rows(db, "SELECT value FROM operational WHERE kind = 'place' AND owner = 'place:p1'")
  );
  assert.deepEqual(parsed(value[0]?.value), {
    $has: ['injokes'],
    learnedNextId: 3,
    notesUpdatedAt: '2026-11-01T10:00:00.000Z',
  });
});

test('step 62 leaves a place row without the keys and a row of another kind as they were', () => {
  // Bug: the step rewrites every operational row, so a value of another kind loses a key of its own named `pings`.
  const file = at61(PINGS_ALL);
  const values = opened(file, (db) =>
    rows(
      db,
      "SELECT kind, owner, value FROM operational WHERE owner <> 'place:p1' OR kind <> 'place' ORDER BY kind, owner"
    )
  );
  assert.deepEqual(values, [
    { kind: 'place', owner: 'place:p2', value: '{"$has":[],"learnedNextId":1,"emojiUsage":{}}' },
    { kind: 'recent', owner: 'place:p1', value: '{"pings":{"a1":"on"},"lines":[]}' },
  ]);
});

test('step 62 takes notify out of a diary send and keeps its messages and mentions', () => {
  // Bug: the stored send keeps `notify`, so a mirror posting the entry again reads who asked to be pinged.
  const file = at61(PINGS_ALL);
  const extras = opened(file, (db) => rows(db, 'SELECT id, extra FROM diary ORDER BY id'));
  assert.deepEqual(
    extras.map((row) => [row.id, parsed(row.extra)]),
    [
      ['diary:e1', { send: { messages: ['one', 'two'], mentions: [['a1'], []], maxMessageBytes: 8 } }],
      ['diary:e2', { send: { messages: ['three'], mentions: [[]] } }],
    ]
  );
});

test('step 62 drops memberships.pings_off and keeps every membership with its other columns', () => {
  // Bug: the column stays behind, or the drop loses a membership row or the columns beside it.
  const file = at61(PINGS_ALL);
  const after = opened(file, (db) => ({
    columns: rows(db, "SELECT name FROM pragma_table_info('memberships') ORDER BY cid").map((row) => row.name),
    members: rows(db, 'SELECT id, account_id, place_id, nick, roles, addressed_as, extra FROM memberships ORDER BY id'),
  }));
  assert.equal(after.columns.includes('pings_off'), false);
  assert.deepEqual(after.members, [
    {
      id: 'mem:a1',
      account_id: 'a1',
      place_id: 'place:p1',
      nick: 'Ada',
      roles: '["r1"]',
      addressed_as: '[{"name":"Ada","count":2}]',
      extra: null,
    },
    { id: 'mem:a2', account_id: 'a2', place_id: null, nick: null, roles: null, addressed_as: null, extra: '{"x":1}' },
  ]);
});

test('a fresh database and one brought from 61 by step 62 have the same shape', () => {
  // Bug: the step drops the column in a way the baseline plus the steps does not give a new database.
  const migrated = opened(at61(PINGS_ALL), schemaShape);
  const fresh = opened(path.join(tempDir('nep-pings-62-fresh-'), 'memory.db'), schemaShape);
  assert.deepEqual(migrated, fresh);
});

test('step 62 run a second time on a migrated database changes no table, index or row', () => {
  // Bug: a second run fails on the column it already dropped, or rewrites a value it already cleaned.
  const handle = openMemoryDb(at61(PINGS_ALL));
  try {
    const db = dbOf(handle);
    const first = everything(db);
    if (step62 === undefined) assert.fail('MIGRATIONS holds no step 62');
    inTransaction(db, () => (typeof step62 === 'function' ? step62(db) : db.exec(step62)));
    assert.deepEqual(everything(db), first);
  } finally {
    handle.close();
  }
});

// Schema step 64 (src/memory/db/schema.ts) on a database written at version 63: one link per media of an owner. The key
// `(owner_kind, owner_id, media_id)` of `media_links` refuses a second link of one media to one owner, and the step
// keeps the first link of each pair, closes the gaps in the owner's positions in their old order, and changes nothing
// else. Each test builds a version 63 file with the steps above the baseline up to 63, fills it with raw SQL, and opens
// it with the current code. Temporary files, invented ids.

/** Four media rows and the links of three owners, two of them holding one media more than once. */
const LINKS_ROWS = `
INSERT INTO media (id, kind, native_ref, scope_kind, scope_iface) VALUES
  ('media:fake:e1', 'emoji', 'e1', 'group', 'fake'),
  ('media:fake:e2', 'emoji', 'e2', 'group', 'fake'),
  ('media:fake:s1', 'sticker', 's1', 'group', 'fake'),
  ('media:fake:a1', 'image', 'a1', 'group', 'fake');
INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES
  ('source', 'src:l1', 0, 'media:fake:e1'),
  ('source', 'src:l1', 1, 'media:fake:e2'),
  ('source', 'src:l1', 2, 'media:fake:e1'),
  ('source', 'src:l1', 3, 'media:fake:s1'),
  ('source', 'src:l1', 4, 'media:fake:e1'),
  ('source', 'src:l2', 0, 'media:fake:s1'),
  ('source', 'src:l2', 1, 'media:fake:s1'),
  ('diary', 'diary:d1', 0, 'media:fake:a1'),
  ('diary', 'diary:d1', 1, 'media:fake:e1');
`;

/** A database file at schema version 63 holding `sql`, written with raw SQL after the steps up to 63. */
function at63(sql: string): string {
  const file = path.join(tempDir('nep-links-64-'), 'memory.db');
  openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 63 - BASELINE_VERSION) }).close();
  const raw = new DatabaseSync(file);
  try {
    assert.equal(raw.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v, 63);
    raw.exec(sql);
  } finally {
    raw.close();
  }
  return file;
}

/** The links of every owner as `kind owner position media`, in key order. */
const linkRows = (db: Db): Array<string> =>
  rows(
    db,
    'SELECT owner_kind, owner_id, position, media_id FROM media_links ORDER BY owner_kind, owner_id, position'
  ).map((row) => `${String(row.owner_kind)} ${String(row.owner_id)} ${String(row.position)} ${String(row.media_id)}`);

test('refuses a second link of one media to one owner after the step', () => {
  // Bug: only the item builder keeps a line to one link per media, so any other writer can still double a link.
  const file = at63('');
  opened(file, (db) => {
    const insert = db.prepare('INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES (?, ?, ?, ?)');
    insert.run('source', 'src:l9', 0, 'media:fake:e9');
    assert.throws(() => insert.run('source', 'src:l9', 1, 'media:fake:e9'), /UNIQUE constraint failed/);
  });
});

test('keeps one link per owner and media, with the remaining positions contiguous in their old order', () => {
  // Bug: the step leaves a doubled link, keeps a later copy instead of the first, or leaves a gap in the positions.
  const file = at63(LINKS_ROWS);
  assert.deepEqual(opened(file, linkRows), [
    'diary diary:d1 0 media:fake:a1',
    'diary diary:d1 1 media:fake:e1',
    'source src:l1 0 media:fake:e1',
    'source src:l1 1 media:fake:e2',
    'source src:l1 2 media:fake:s1',
    'source src:l2 0 media:fake:s1',
  ]);
});

test('changes no row outside media_links when it removes doubled links', () => {
  // Bug: the step drops a media row whose doubled link it removed, or touches another table.
  const file = at63(LINKS_ROWS);
  const raw = new DatabaseSync(file);
  const before = filledRows(raw, ['media_links', 'schema_version']);
  raw.close();
  assert.deepEqual(
    opened(file, (db) => filledRows(db, ['media_links', 'schema_version'])),
    before
  );
});

// Schema step 67 (src/memory/db/schema.ts), which gives a stored edit the moment of its line's first revision, on a
// database written at the newest version before it, where an edit row carries the moment the edit arrived. After the
// step a read that orders lines stands the edited line where it was written, with the newest text, and the neighbours
// read of recall is bounded by `sources_place_time`. Each test builds the old file with the steps up to that version,
// fills it with raw SQL as the writer of that version left it, and opens it with the current code. Temporary files,
// invented ids, synthetic text.

/** The newest schema version before the step. */
const MOMENT_BEFORE_STEP = 66;
const PLACE = 'fake:channel:room';
const T0 = Date.parse('2026-11-12T01:00:00.000Z');
const MINUTE = 60_000;
const iso = (minutes: number): string => new Date(T0 + minutes * MINUTE).toISOString();

/** One `sources` row of `PLACE` as raw SQL. */
const line = (id: string, native: string, revision: number, minutes: number, text: string): string =>
  `('${id}', 'seen', 'fake', '${native}', 'message', ${revision}, '${PLACE}', 'fake:member', 'account',
    '${iso(minutes)}', '${iso(minutes)}', '${text}', 'group', 'fake', NULL)`;

/**
 * Six lines a minute apart, `l0` to `l5`, and two edits stored at the moment they arrived: `l1` edited 93 minutes
 * later, and `l3` edited twice, 40 and 50 minutes later.
 */
const MOMENT_ROWS = `
INSERT INTO places (id, iface, kind, native_id, chat, scope_kind) VALUES ('${PLACE}', 'fake', 'channel', 'room', 'group', 'group');
INSERT INTO sources (id, kind, iface, native_id, native_kind, revision, place_id, author_account, author_kind,
  occurred_at, recorded_at, text, scope_kind, scope_iface, scope_dm) VALUES
  ${line('src:l0', 'l0', 1, 0, 'line zero')},
  ${line('src:l1', 'l1', 1, 1, 'line one')},
  ${line('src:l2', 'l2', 1, 2, 'line two')},
  ${line('src:l3', 'l3', 1, 3, 'line three')},
  ${line('src:l4', 'l4', 1, 4, 'line four')},
  ${line('src:l5', 'l5', 1, 5, 'line five')},
  ${line('src:l1:2', 'l1', 2, 94, 'line one, fixed')},
  ${line('src:l3:2', 'l3', 2, 43, 'line three, fixed')},
  ${line('src:l3:3', 'l3', 3, 53, 'line three, fixed again')};
`;

/** A database file at `MOMENT_BEFORE_STEP` holding `sql`, written with raw SQL after the steps up to that version. */
function momentOldFile(sql: string): string {
  const file = path.join(tempDir('nep-edit-moment-'), 'memory.db');
  openMemoryDb(file, { migrations: MIGRATIONS.slice(0, MOMENT_BEFORE_STEP - BASELINE_VERSION) }).close();
  const raw = new DatabaseSync(file);
  try {
    assert.equal(raw.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v, MOMENT_BEFORE_STEP);
    raw.exec(sql);
  } finally {
    raw.close();
  }
  return file;
}

/** `db` with every statement it runs kept as its SQL and parameters. */
function planRecording(db: Db): { db: Db; ran: Array<{ sql: string; params: Array<unknown> }> } {
  const ran: Array<{ sql: string; params: Array<unknown> }> = [];
  const prepare = (sql: string): Statement => {
    const statement = db.prepare(sql);
    const note = (params: Array<unknown>): void => {
      ran.push({ sql, params });
    };
    return {
      get: (...params) => (note(params), statement.get(...params)),
      all: (...params) => (note(params), statement.all(...params)),
      run: (...params) => (note(params), statement.run(...params)),
      iterate: (...params) => (note(params), statement.iterate(...params)),
    };
  };
  return { db: { prepare, exec: (sql) => db.exec(sql) }, ran };
}

/** A walk of every row of a place, or of every row of `sources`. */
const WHOLE_PLACE = /^SEARCH s USING (COVERING )?INDEX sources_place_time \(place_id=\?\)$|^SCAN (s|t|sources)\b/;

/** The `sources` rows that are the first revision of their line, as JSON, in id order. */
const firstRevisions = (db: Db): Array<string> =>
  db
    .prepare('SELECT * FROM sources WHERE revision = 1 ORDER BY id')
    .all()
    .map((row) => JSON.stringify(row));

test('an old database opens past the step', () => {
  // Bug: the step is missing, so a database the old writer left keeps its edits at the moment they arrived.
  const file = momentOldFile(MOMENT_ROWS);
  const version = opened(file, (db) => db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v);
  assert.equal(Number(version) > MOMENT_BEFORE_STEP, true);
});

test('after the step every edited line reads where it was written, with its newest text', () => {
  // Bug: the step moves an edit to the wrong revision's moment, or a line edited twice reads at its second edit.
  const file = momentOldFile(MOMENT_ROWS);
  const lines = opened(file, (db) => chatLines(db, PLACE).map((one) => [one.nativeId, one.text, one.at]));
  assert.deepEqual(lines, [
    ['l0', 'line zero', T0],
    ['l1', 'line one, fixed', T0 + MINUTE],
    ['l2', 'line two', T0 + 2 * MINUTE],
    ['l3', 'line three, fixed again', T0 + 3 * MINUTE],
    ['l4', 'line four', T0 + 4 * MINUTE],
    ['l5', 'line five', T0 + 5 * MINUTE],
  ]);
});

test('after the step each edit stands at its first revision and keeps the moment it arrived', () => {
  // Bug: the step dates an edit by a later revision, or overwrites the moment the edit arrived along with its place.
  const file = momentOldFile(MOMENT_ROWS);
  const edits = opened(file, (db) =>
    db
      .prepare('SELECT id, occurred_at, recorded_at FROM sources WHERE revision > 1 ORDER BY id')
      .all()
      .map((row) => [row.id, row.occurred_at, row.recorded_at])
  );
  assert.deepEqual(edits, [
    ['src:l1:2', iso(1), iso(94)],
    ['src:l3:2', iso(3), iso(43)],
    ['src:l3:3', iso(3), iso(53)],
  ]);
});

test('after the step an edited line is marked edited at the moment its newest edit arrived', () => {
  // Bug: the edited mark follows the corrected moment, so an old edit reads as made when the line was written.
  const file = momentOldFile(MOMENT_ROWS);
  const marks = opened(file, (db) => chatLines(db, PLACE).map((one) => [one.nativeId, one.editedAt ?? null]));
  assert.deepEqual(marks, [
    ['l0', null],
    ['l1', T0 + 94 * MINUTE],
    ['l2', null],
    ['l3', T0 + 53 * MINUTE],
    ['l4', null],
    ['l5', null],
  ]);
});

test('after the step a window around an old edit reads its neighbours without a walk of the place', () => {
  // Bug: an edit row the step left at the moment it arrived still needs the first revision's moment computed per row,
  // so the neighbours read walks every line of the place.
  const file = momentOldFile(MOMENT_ROWS);
  const { ids, walks } = opened(file, (db) => {
    const { db: recorded, ran } = planRecording(db);
    const down = window(recorded, { ctx: groupContext('fake'), anchor: 'l0', move: 'down', messages: 3 });
    const plans = ran.flatMap(({ sql, params }) =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...params)
        .map((row) => String(row.detail))
    );
    return {
      ids: down.windows.flatMap((one) => one.messages).map((message) => message.id),
      walks: plans.filter((detail) => WHOLE_PLACE.test(detail)),
    };
  });
  assert.deepEqual(ids, ['l1', 'l2', 'l3']);
  assert.deepEqual(walks, []);
});

test('the step leaves every first revision as it was', () => {
  // Bug: the step rewrites the moment or another column of a row that is no edit.
  const file = momentOldFile(MOMENT_ROWS);
  const raw = new DatabaseSync(file);
  const before = firstRevisions(dbOf(raw));
  raw.close();
  assert.deepEqual(opened(file, firstRevisions), before);
});

test('a database already past the step opens unchanged', () => {
  // Bug: the step runs again on a database that holds it, or a second open rewrites rows.
  const file = momentOldFile(MOMENT_ROWS);
  opened(file, () => null);
  const raw = new DatabaseSync(file);
  const before = filledRows(dbOf(raw));
  raw.close();
  opened(file, () => null);
  const after = new DatabaseSync(file);
  try {
    assert.deepEqual(filledRows(dbOf(after)), before);
  } finally {
    after.close();
  }
});

// Schema step 68 (src/memory/db/schema.ts), which gives every stored diary entry of the kind `status` the kind `story`,
// on a database written at the newest version before it, where an invented moment was stored under `status`. Each test
// builds the old file with the steps up to that version, fills it with raw SQL as the writer of that version left it,
// and opens it with the current code. Temporary files, invented ids, synthetic text.

/** The newest schema version before the step. */
const STORY_BEFORE_STEP = 67;

/** Five entries as the old writer left them: two of the kind `status`, one of them retired, and three other rows. */
const STORY_ROWS = `
INSERT INTO diary (id, at_ms, kind, gist, text, extra, position, retired_at, writer) VALUES
  ('diary:a', 1000, 'status', 'at the pond', 'at the pond', '{"plan":{"brief":"a status at a pond"}}', 0, NULL, 'diary'),
  ('diary:b', 2000, 'news', 'a status report', 'the status of a launch', '{"status":"sent"}', 1, NULL, 'diary'),
  ('diary:c', 3000, 'status', 'on the roof', 'on the roof', NULL, 2, '2026-01-01T00:00:00.000Z', 'diary'),
  ('diary:d', 4000, NULL, 'no kind', 'no kind', NULL, 3, NULL, 'diary'),
  ('diary:e', 5000, 'thought', 'a thought', 'a thought', NULL, 4, NULL, 'diary');
`;

/** A database file at `STORY_BEFORE_STEP` holding `STORY_ROWS`, written with raw SQL after the steps up to that version. */
function storyOldFile(): string {
  const file = path.join(tempDir('nep-status-story-'), 'memory.db');
  openMemoryDb(file, { migrations: MIGRATIONS.slice(0, STORY_BEFORE_STEP - BASELINE_VERSION) }).close();
  const raw = new DatabaseSync(file);
  try {
    assert.equal(raw.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v, STORY_BEFORE_STEP);
    raw.exec(STORY_ROWS);
  } finally {
    raw.close();
  }
  return file;
}

/** Every entry as `id kind`, in id order. */
const kinds = (db: Db): Array<string> =>
  db
    .prepare('SELECT id, kind FROM diary ORDER BY id')
    .all()
    .map((row) => `${String(row.id)} ${String(row.kind)}`);

test('an entry stored as a status reads as a story after the step, retired or not', () => {
  // Bug: the step is missing or skips a retired row, so an invented moment keeps the kind that means the real day.
  const after = opened(storyOldFile(), kinds);
  assert.deepEqual(after, ['diary:a story', 'diary:b news', 'diary:c story', 'diary:d null', 'diary:e thought']);
});

// Schema steps 69 to 73 (src/memory/db/schema.ts). Steps 69 to 72 drop `publication_grants` with
// `publications.grant_id`, `focus_overrides`, `skill_uses` with `skill_evaluations`, and `index_policy`, removing the
// rows they hold, and step 73 projects again each retired publication whose graph edges are live. Each step logs only
// its counts. Each test builds an old file with the steps up to its version, fills it with raw SQL as the writers
// of that version could leave it, and opens it with the current code. Temporary files, invented ids, synthetic text.

/** The newest schema version before the steps. */
const BEFORE_STEPS = 68;
/** The version the steps reach: 73, since step 73 follows the four drops. */
const AFTER_STEPS = 73;
const DROP_OBSOLETE_AT = '2026-11-01T12:00:00.000Z';
const DROP_OBSOLETE_DROPPED = [
  'publication_grants',
  'focus_overrides',
  'skill_uses',
  'skill_evaluations',
  'index_policy',
];

/** A place, a person and a skill version for the rows below to name. */
const PARENT_ROWS = `
INSERT INTO places (id, iface, kind, native_id) VALUES ('place:p1', 'discord', 'channel', 'n-1');
INSERT INTO people (id, kind) VALUES ('person:a', 'human');
INSERT INTO skills (id, name, lifecycle) VALUES ('skill:s', 's', 'active');
INSERT INTO skill_versions (id, skill_id, version, content_hash, manifest_hash, commit_sha, status, created_at, manifest)
  VALUES ('sv:1', 'skill:s', '1', 'c', 'm', 'abc', 'active', '${DROP_OBSOLETE_AT}', '{}');
`;

/** Rows in every table the steps drop: two grants, an override, two uses, an evaluation and a policy row. */
const DROPPED_ROWS = `
INSERT INTO publication_grants (id, row_kind, row_id, content_hash, destinations, approved_by, approved_at) VALUES
  ('grant:1', 'diary', 'diary:e1', 'h-1', '["place:p1"]', 'owner', '${DROP_OBSOLETE_AT}'),
  ('grant:2', 'diary', 'diary:e2', 'h-2', '["place:p1"]', 'owner', '${DROP_OBSOLETE_AT}');
INSERT INTO focus_overrides (person_id, kind, expires_at, approved_by, reason) VALUES ('person:a', 'pin', NULL, 'owner', NULL);
INSERT INTO skill_uses (skill, version_id, turn_id, kind, at) VALUES ('s', 'sv:1', 't-1', 'read', '${DROP_OBSOLETE_AT}'),
  ('s', 'sv:1', 't-2', 'tried', '${DROP_OBSOLETE_AT}');
INSERT INTO skill_evaluations (id, version_id, kind, passed, at, content_hash, manifest_hash, commit_sha) VALUES
  ('ev:1', 'sv:1', 'tests', 1, '${DROP_OBSOLETE_AT}', 'c', 'm', 'abc');
INSERT INTO index_policy (node_id, tier, reason, pinned, evaluated_at) VALUES ('node:1', 'a', 'touch', 0, '${DROP_OBSOLETE_AT}');
`;

/** A segment in flight, as a claimed or uncertain send keeps it. */
const DELIVERY =
  '{"messages":["one"],"segments":[{"segment":0,"status":"uncertain","key":"k:0","messageIds":[],"attachmentIds":[]}]}';

/**
 * Publications in every state: granted ones sent, queued, sending, unknown, failed and incomplete, one granted row
 * retired before the step, and two with no grant. `publications_unsettled` and the guards stand over them.
 */
const PUBLICATIONS = `
INSERT INTO publications (id, row_kind, row_id, content_hash, rendered, destination_place_id, grant_id, status,
  idempotency_key, receipts, created_at, sent_at, retired_at, code, retryable, claimed_by, claimed_at, delivery) VALUES
  ('pub:sent', 'diary', 'diary:e1', 'h-1', 'one', 'place:p1', 'grant:1', 'sent', 'k-sent',
   '[{"authority":"discord/global","kind":"message","key":"m-1"}]', '${DROP_OBSOLETE_AT}', '${DROP_OBSOLETE_AT}', NULL, NULL, NULL, 'c-1', 5,
   '{"messages":["one"],"segments":[{"segment":0,"status":"sent","key":"k:0","messageIds":["m-1"],"attachmentIds":[]}]}'),
  ('pub:queued', 'diary', 'diary:e2', 'h-2', 'two', 'place:p1', 'grant:2', 'queued', 'k-queued', NULL, '${DROP_OBSOLETE_AT}', NULL,
   NULL, NULL, NULL, NULL, NULL, NULL),
  ('pub:sending', 'diary', 'diary:e3', 'h-3', 'three', 'place:p1', 'grant:1', 'sending', 'k-sending', NULL, '${DROP_OBSOLETE_AT}',
   NULL, NULL, NULL, NULL, 'c-2', 7, '${DELIVERY}'),
  ('pub:unknown', 'diary', 'diary:e4', 'h-4', 'four', 'place:p1', 'grant:1', 'unknown', 'k-unknown', NULL, '${DROP_OBSOLETE_AT}',
   NULL, NULL, 'claim-expired', NULL, 'c-3', 9, '${DELIVERY}'),
  ('pub:failed', 'diary', 'diary:e5', 'h-5', 'five', 'place:p1', 'grant:1', 'failed', 'k-failed', NULL, '${DROP_OBSOLETE_AT}', NULL,
   NULL, 'refused', 1, NULL, NULL, NULL),
  ('pub:incomplete', 'diary', 'diary:e6', 'h-6', 'six', 'place:p1', 'grant:1', 'incomplete', 'k-incomplete', NULL,
   '${DROP_OBSOLETE_AT}', NULL, NULL, 'missing-file', 1, NULL, NULL, NULL),
  ('pub:retired', 'diary', 'diary:e7', 'h-7', 'seven', 'place:p1', 'grant:1', 'queued', 'k-retired', NULL, '${DROP_OBSOLETE_AT}',
   NULL, '2026-10-01T00:00:00.000Z', NULL, NULL, NULL, NULL, NULL),
  ('pub:plain-queued', 'diary', 'diary:e8', 'h-8', 'eight', 'place:p1', NULL, 'queued', 'k-plain-queued', NULL, '${DROP_OBSOLETE_AT}',
   NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('pub:plain-unknown', 'diary', 'diary:e9', 'h-9', 'nine', 'place:p1', NULL, 'unknown', 'k-plain-unknown', NULL,
   '${DROP_OBSOLETE_AT}', NULL, NULL, NULL, NULL, 'c-4', 11, '${DELIVERY}');
INSERT INTO publications (rowid, id, row_kind, row_id, destination_place_id, grant_id, status, idempotency_key,
  created_at) VALUES (40, 'pub:late', 'diary', 'diary:e10', 'place:p1', 'grant:2', 'queued', 'k-late', '${DROP_OBSOLETE_AT}');
`;

/** The granted publications whose sending had not ended and that were not retired: the step retires them. */
const UNFINISHED_GRANTED = ['pub:failed', 'pub:incomplete', 'pub:late', 'pub:queued', 'pub:sending', 'pub:unknown'];

/** A database file at `version`, written with raw SQL after the steps up to that version. */
function oldFile(version: number, sql: string): string {
  const file = path.join(tempDir('nep-drop-obsolete-'), 'memory.db');
  openMemoryDb(file, { migrations: MIGRATIONS.slice(0, version - BASELINE_VERSION) }).close();
  const raw = new DatabaseSync(file);
  try {
    assert.equal(raw.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v, version);
    raw.exec(sql);
  } finally {
    raw.close();
  }
  return file;
}

/** Opens `file` with `migrations` (the current steps by default), then `read` on its connection. */
function dropObsoleteOpened<TResult>(file: string, read: (db: Db) => TResult, migrations = MIGRATIONS): TResult {
  const handle = openMemoryDb(file, { migrations });
  try {
    return read(dbOf(handle));
  } finally {
    handle.close();
  }
}

/** What `read` answers on `file` without migrating it. */
function raw<TResult>(file: string, read: (db: DatabaseSync) => TResult): TResult {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** The log entries of `run`, its own lines only. */
function logged(run: () => void): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  const stop = onLog((entry) => entries.push(entry));
  try {
    run();
  } finally {
    stop();
  }
  return entries;
}

const tables = (db: Db | DatabaseSync): Array<string> =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row.name));
const columns = (db: Db | DatabaseSync, table: string): Array<string> =>
  db
    .prepare(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((row) => String(row.name));
const version = (db: Db | DatabaseSync): number =>
  Number(db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v);
const publications = (db: Db | DatabaseSync): Array<Record<string, unknown>> =>
  db
    .prepare('SELECT rowid AS position, * FROM publications ORDER BY id')
    .all()
    .map((row) => ({ ...row }));
const guards = (db: Db | DatabaseSync): Array<string> =>
  db
    .prepare("SELECT type, name FROM sqlite_master WHERE tbl_name = 'publications' AND sql IS NOT NULL ORDER BY name")
    .all()
    .map((row) => `${String(row.type)} ${String(row.name)}`);

/** The integrity check and the foreign key check of a connection, `ok` and no row when the file holds together. */
function integrity(db: Db | DatabaseSync): { integrity: unknown; foreignKeys: number } {
  return {
    integrity: db.prepare('PRAGMA integrity_check').get()?.integrity_check,
    foreignKeys: db.prepare('PRAGMA foreign_key_check').all().length,
  };
}

test('a new database reaches the newest version without the dropped tables and column, whole', () => {
  // Bug: a new install keeps a table the steps drop, or a rebuild of publications leaves a broken file.
  const file = path.join(tempDir('nep-drop-obsolete-'), 'memory.db');
  const lines = logged(() =>
    dropObsoleteOpened(file, (db) => {
      assert.equal(version(db), AFTER_STEPS);
      for (const table of DROP_OBSOLETE_DROPPED) assert.equal(tables(db).includes(table), false, table);
      assert.equal(columns(db, 'publications').includes('grant_id'), false);
      assert.deepEqual(integrity(db), { integrity: 'ok', foreignKeys: 0 });
    })
  );
  assert.ok(lines.every((line) => line.level !== 'error' && line.level !== 'warn'));
});

test('an upgrade from 68 removes the dropped rows, logs their counts and keeps every publication', () => {
  // Bug: a step that refuses a non-empty table, loses a publication or one of its values, or logs content.
  const file = oldFile(BEFORE_STEPS, PARENT_ROWS + DROPPED_ROWS + PUBLICATIONS);
  const before = raw(file, (db) => ({ rows: publications(db), guards: guards(db) }));
  const lines = logged(() =>
    dropObsoleteOpened(file, (db) => {
      assert.equal(version(db), AFTER_STEPS);
      for (const table of DROP_OBSOLETE_DROPPED) assert.equal(tables(db).includes(table), false, table);
      const after = publications(db);
      assert.equal(after.length, before.rows.length);
      for (const old of before.rows) {
        const now = after.find((row) => row.id === old.id);
        assert.ok(now, `${String(old.id)} kept`);
        const { grant_id: grant, retired_at: wasRetired, ...kept } = old;
        const { retired_at: retired, ...rest } = now;
        assert.deepEqual(rest, kept, `${String(old.id)} keeps every value but its grant`);
        if (UNFINISHED_GRANTED.includes(String(old.id))) {
          assert.equal(wasRetired, null);
          assert.ok(Date.parse(String(retired)) > Date.parse(DROP_OBSOLETE_AT), `${String(old.id)} leaves the queue`);
        } else assert.equal(retired, wasRetired, `${String(old.id)} keeps its retirement (grant ${String(grant)})`);
      }
      assert.deepEqual(guards(db), before.guards, 'the indexes and guards of publications come back');
      assert.throws(
        () =>
          db.prepare("UPDATE publications SET rendered = 'other', content_hash = 'h-x' WHERE id = 'pub:sent'").run(),
        /keeps its content/
      );
      assert.throws(() => db.prepare("DELETE FROM publications WHERE id = 'pub:sent'").run(), /never deleted/);
      assert.equal(
        db.prepare("SELECT value FROM meta WHERE key = 'graph_pending'").get()?.value,
        '{"unit":0,"after":null}',
        'the graph projects the retired rows again'
      );
      assert.deepEqual(integrity(db), { integrity: 'ok', foreignKeys: 0 });
    })
  );
  const removed = lines.filter((line) => line.msg === 'memory db: schema step removed rows');
  assert.deepEqual(
    removed.map((line) =>
      Object.fromEntries(Object.entries(line).filter(([key]) => !['level', 'time', 'msg'].includes(key)))
    ),
    [
      { version: 69, publication_grants: 2, granted_publications: 8, retired_publications: 6 },
      { version: 70, focus_overrides: 1 },
      { version: 71, skill_uses: 2, skill_evaluations: 1 },
      { version: 72, index_policy: 1 },
      // Step 73 finds no live edge: these rows were written raw and never projected.
      { version: 73, reprojected_publications: 0 },
    ]
  );
});

test('an upgraded database opens again unchanged at the newest version', () => {
  // Bug: a step that runs twice, or a reopen that finds the rebuilt publications in another shape.
  const file = oldFile(BEFORE_STEPS, PARENT_ROWS + DROPPED_ROWS + PUBLICATIONS);
  const first = dropObsoleteOpened(file, (db) => ({
    shape: schemaShape(db),
    rows: filledRows(db),
    publications: publications(db),
  }));
  const lines = logged(() =>
    dropObsoleteOpened(file, (db) => {
      assert.equal(version(db), AFTER_STEPS);
      assert.deepEqual(schemaShape(db), first.shape);
      assert.deepEqual(filledRows(db), first.rows);
      assert.deepEqual(publications(db), first.publications);
    })
  );
  assert.equal(lines.filter((line) => line.msg === 'memory db: schema step removed rows').length, 0);
});

test('an upgrade from 56 runs the rename of step 61 over the grants, then drops them', () => {
  // Bug: a new step that runs before step 61 or breaks it, which leaves an old file unopenable.
  const legacy = `${PARENT_ROWS}
INSERT INTO publication_grants (id, row_kind, row_id, content_hash, destinations, approved_by, approved_at) VALUES
  ('grant:selfreflection:e1', 'selfreflection', 'selfreflection:e1', 'h-1', '["place:p1"]', 'owner', '${DROP_OBSOLETE_AT}');
INSERT INTO publications (id, row_kind, row_id, content_hash, rendered, destination_place_id, grant_id, status,
  idempotency_key, created_at) VALUES
  ('pub:selfreflection:1', 'selfreflection', 'selfreflection:e1', 'h-1', 'one', 'place:p1', 'grant:selfreflection:e1',
   'queued', 'selfreflection:selfreflection:e1:place:p1', '${DROP_OBSOLETE_AT}');
INSERT INTO focus_overrides (person_id, kind, approved_by) VALUES ('person:a', 'exclude', 'owner');
INSERT INTO skill_uses (skill, version_id, turn_id, kind, at) VALUES ('s', 'sv:1', 't-1', 'read', '${DROP_OBSOLETE_AT}');
INSERT INTO index_policy (node_id, tier, evaluated_at) VALUES ('node:1', 'b', '${DROP_OBSOLETE_AT}');`;
  const file = oldFile(BASELINE_VERSION, legacy);
  dropObsoleteOpened(file, (db) => {
    assert.equal(version(db), AFTER_STEPS);
    for (const table of DROP_OBSOLETE_DROPPED) assert.equal(tables(db).includes(table), false, table);
    const [row] = publications(db);
    assert.equal(row?.id, 'pub:diary:1');
    assert.equal(row?.idempotency_key, 'diary:diary:e1:place:p1');
    assert.equal(row?.status, 'queued');
    assert.ok(
      Date.parse(String(row?.retired_at)) > Date.parse(DROP_OBSOLETE_AT),
      'the granted queued row leaves the queue'
    );
    assert.deepEqual(integrity(db), { integrity: 'ok', foreignKeys: 0 });
  });
});

test('a step that fails after 69 and 70 ran leaves the file at 68 with every row', () => {
  // Bug: a step that commits on its own, so a later failure leaves the file at 69 or 70 without its grants.
  const file = oldFile(BEFORE_STEPS, PARENT_ROWS + DROPPED_ROWS + PUBLICATIONS);
  const before = raw(file, (db) => ({ shape: schemaShape(db as unknown as Db), publications: publications(db) }));
  const failing = [
    ...MIGRATIONS.slice(0, BEFORE_STEPS + 2 - BASELINE_VERSION),
    () => {
      throw new Error('synthetic failure of step 71');
    },
  ];
  const lines = logged(() =>
    assert.throws(() => dropObsoleteOpened(file, () => null, failing), /synthetic failure of step 71/)
  );
  assert.equal(lines.filter((line) => line.msg === 'memory db: schema step removed rows').length, 0);
  raw(file, (db) => {
    assert.equal(version(db), BEFORE_STEPS);
    assert.deepEqual(schemaShape(db as unknown as Db), before.shape);
    assert.deepEqual(publications(db), before.publications);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM publication_grants').get()?.n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM focus_overrides').get()?.n, 1);
  });
});

/** The meta key of the pending graph pass, and a cursor already past the publications unit. */
const PENDING = 'graph_pending';
const PAST_PUBLICATIONS = '{"unit":13,"after":null}';

/** Projects the publications of `file` at `version`, as the writers of that version left the graph. */
function project(file: string, version: number): void {
  const handle = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, version - BASELINE_VERSION) });
  try {
    reproject(handle, { tables: ['publications'] });
  } finally {
    handle.close();
  }
}

/** Writes `sql` into `file` without migrating it. */
function write(file: string, sql: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/** Each `published_as` edge by its publication: the edge's retirement and the row's. */
const publishedEdges = (db: Db | DatabaseSync): Record<string, { edge: unknown; row: unknown }> =>
  Object.fromEntries(
    db
      .prepare(
        `SELECT p.id, e.retired_at AS edge, p.retired_at AS row FROM graph_edges e
          JOIN publications p ON e.dst = 'publication:' || p.id WHERE e.predicate = 'published_as' ORDER BY p.id`
      )
      .all()
      .map((r) => [String(r.id), { edge: r.edge, row: r.row }])
  );

/** The retired publications that still own a live edge. */
const liveEdgesOfRetired = (db: Db | DatabaseSync): Array<string> =>
  db
    .prepare(
      `SELECT DISTINCT p.id FROM graph_edges e JOIN publications p ON e.owner_key = 'publications:' || p.id
        WHERE p.retired_at IS NOT NULL AND e.retired_at IS NULL ORDER BY p.id`
    )
    .all()
    .map((r) => String(r.id));

const graphRows = (db: Db | DatabaseSync): unknown =>
  ['graph_nodes', 'graph_edges', 'node_access'].map((table) =>
    db
      .prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3`)
      .all()
      .map((row) => ({ ...row }))
  );

const stepLines = (lines: Array<Record<string, unknown>>, step: number): Array<Record<string, unknown>> =>
  lines
    .filter((line) => line.msg === 'memory db: schema step removed rows' && line.version === step)
    .map((line) => Object.fromEntries(Object.entries(line).filter(([key]) => !['level', 'time', 'msg'].includes(key))));

/** Checks that every publication step 69 retired has its `published_as` edge retired at the row's own moment. */
function assertRetiredWithRows(db: Db): void {
  assert.deepEqual(liveEdgesOfRetired(db), []);
  const edges = publishedEdges(db);
  for (const id of UNFINISHED_GRANTED) {
    assert.ok(edges[id]?.row, `${id} is retired`);
    assert.equal(edges[id]?.edge, edges[id]?.row, `${id} retires its edge with the row`);
  }
  for (const id of ['pub:sent', 'pub:plain-queued', 'pub:plain-unknown'])
    assert.equal(edges[id]?.edge, null, `${id} keeps its live edge`);
}

test('an upgrade from 68 with no pending pass retires the edges of the publications step 69 retires', () => {
  // Bug: step 69 retires publications in SQL and leaves their `published_as` edges live until a later graph pass.
  const file = oldFile(BEFORE_STEPS, PARENT_ROWS + DROPPED_ROWS + PUBLICATIONS);
  project(file, BEFORE_STEPS);
  raw(file, (db) => {
    assert.equal(db.prepare('SELECT 1 FROM meta WHERE key = ?').get(PENDING), undefined);
    assert.equal(publishedEdges(db)['pub:queued']?.edge, null, 'the fixture starts with live edges');
  });
  const lines = logged(() =>
    dropObsoleteOpened(file, (db) => {
      assertRetiredWithRows(db);
      assert.deepEqual(integrity(db), { integrity: 'ok', foreignKeys: 0 });
    })
  );
  assert.deepEqual(stepLines(lines, 73), [{ version: 73, reprojected_publications: UNFINISHED_GRANTED.length }]);
});

test('an upgrade from 68 retires those edges when a pending pass had already passed the publications', () => {
  // Bug: `INSERT OR IGNORE` keeps a cursor past the publications unit, so the pass never projects the retired rows.
  const file = oldFile(BEFORE_STEPS, PARENT_ROWS + DROPPED_ROWS + PUBLICATIONS);
  project(file, BEFORE_STEPS);
  write(file, `INSERT INTO meta (key, value) VALUES ('${PENDING}', '${PAST_PUBLICATIONS}')`);
  dropObsoleteOpened(file, (db) => {
    assertRetiredWithRows(db);
    assert.equal(db.prepare('SELECT value FROM meta WHERE key = ?').get(PENDING)?.value, PAST_PUBLICATIONS);
    assert.deepEqual(integrity(db), { integrity: 'ok', foreignKeys: 0 });
  });
});

test('a database at 72 with live edges of retired publications has them retired once', () => {
  // Bug: a database that took steps 69 to 72 keeps the live edges, since no step after them projects the rows again.
  const file = oldFile(
    72,
    `${PARENT_ROWS}
INSERT INTO publications (id, row_kind, row_id, destination_place_id, status, idempotency_key, created_at) VALUES
  ('pub:left', 'diary', 'diary:e1', 'place:p1', 'queued', 'k-left', '${DROP_OBSOLETE_AT}'),
  ('pub:kept', 'diary', 'diary:e2', 'place:p1', 'queued', 'k-kept', '${DROP_OBSOLETE_AT}');`
  );
  project(file, 72);
  write(
    file,
    `UPDATE publications SET retired_at = '2026-11-02T00:00:00.000Z' WHERE id = 'pub:left';
     INSERT INTO meta (key, value) VALUES ('${PENDING}', '${PAST_PUBLICATIONS}');`
  );
  const lines = logged(() =>
    dropObsoleteOpened(file, (db) => {
      assert.equal(version(db), AFTER_STEPS);
      assert.deepEqual(publishedEdges(db), {
        'pub:kept': { edge: null, row: null },
        'pub:left': { edge: '2026-11-02T00:00:00.000Z', row: '2026-11-02T00:00:00.000Z' },
      });
      assert.deepEqual(integrity(db), { integrity: 'ok', foreignKeys: 0 });
    })
  );
  assert.deepEqual(stepLines(lines, 73), [{ version: 73, reprojected_publications: 1 }]);
  const graph = dropObsoleteOpened(file, graphRows);
  const again = logged(() => dropObsoleteOpened(file, (db) => assert.deepEqual(graphRows(db), graph)));
  assert.deepEqual(stepLines(again, 73), [], 'a reopen projects nothing again');
});

// Schema step 66 (src/memory/db/schema.ts) on a database written at version 65: the description vectors of the GIF
// library leave, the `vectors` rows of kind `gif` under `gif:<item id>`, and every other vector stays.

const NOW = Date.parse('2026-11-18T12:00:00.000Z');

const ROWS = `INSERT INTO vectors (item_id, chunk_key, kind, model, dims, occurred_at) VALUES
  ('m1#e0', 'gif:m1#e0', 'gif', 'm/one', 2, '2026-11-05T00:00:00.000Z'),
  ('a2', 'gif:a2', 'gif', 'm/one', 2, '2026-11-06T00:00:00.000Z'),
  ('media:gif:k1', 'media:media:gif:k1', 'media', 'm/one', 2, '2026-11-07T00:00:00.000Z'),
  ('line-1', 'record:line-1:1', 'record', 'm/one', 2, '2026-11-08T00:00:00.000Z');`;

/** A data folder whose database holds the four vectors, at `version`. */
async function dataDirAt(version: number): Promise<string> {
  const dataDir = tempDataDir();
  const first = await openTestMemory({ dataDir, now: () => NOW });
  await first.close();
  const raw = new DatabaseSync(path.join(dataDir, 'memory.db'));
  try {
    raw.exec(`${ROWS} DELETE FROM schema_version WHERE version > ${version};`);
  } finally {
    raw.close();
  }
  return dataDir;
}

async function chunkKeysAfterOpen(dataDir: string): Promise<Array<unknown>> {
  const second = await openTestMemory({ dataDir, now: () => NOW });
  try {
    const db = second.memoryDb.database();
    if (!db) throw new Error('database unavailable');
    return db
      .prepare('SELECT chunk_key FROM vectors ORDER BY chunk_key')
      .all()
      .map((row) => row.chunk_key);
  } finally {
    await second.close();
  }
}

test('step 66 deletes the GIF description vectors and keeps the media and record vectors', async () => {
  assert.deepEqual(await chunkKeysAfterOpen(await dataDirAt(65)), ['media:media:gif:k1', 'record:line-1:1']);
});

test('a database already at version 66 keeps every vector it holds', async () => {
  assert.deepEqual(await chunkKeysAfterOpen(await dataDirAt(66)), [
    'gif:a2',
    'gif:m1#e0',
    'media:media:gif:k1',
    'record:line-1:1',
  ]);
});

// The rows memory finds through stored columns instead of the text of their keys, on a database written before the
// columns existed (schema step 57, src/memory/db/schema.ts): a memory line's attitude rows by their decision, a split
// page's parts by the page of its runs, a lorebook entry's id from the claim's own fields and a GIF vector by its kind.
// Each test writes through the real writers, takes the database back to version 56 the way production holds it (the
// new columns dropped, the entry ids gone from the claims), opens it again and reads the same thing. Synthetic data.

const ROW_LINKS_NOW = Date.parse('2026-11-09T10:00:00.000Z');
const DAY = '2026-11-09T08:00:00.000Z';
const ROOT = 'synthetic:root:1';

/** The database file of `dataDir` taken back to version 56: the columns of step 57 dropped, the lore entry ids gone. */
function backTo56(dataDir: string, extra = ''): void {
  const db = new DatabaseSync(path.join(dataDir, 'memory.db'));
  try {
    db.exec(`DROP INDEX affinity_events_decision;
      ALTER TABLE affinity_events DROP COLUMN decision_id;
      DROP INDEX session_runs_page;
      ALTER TABLE session_runs DROP COLUMN page;
      ALTER TABLE session_runs DROP COLUMN parts;
      DROP INDEX vectors_kind;
      ALTER TABLE vectors DROP COLUMN kind;
      UPDATE claims SET extra = json_remove(extra, '$.id') WHERE kind = 'lore';
      DELETE FROM schema_version WHERE version > 56;
      ${extra}`);
  } finally {
    db.close();
  }
}

test("a database from before step 57 reads each memory line's own attitude after the step", async () => {
  // Bug: a step that leaves the old attitude rows without their decision loses every attitude of the journal, and a
  // reader that still matches the id prefix gives line `a` the attitude of line `a:2`.
  const dataDir = tempDataDir();
  const first = await openTestMemory({ dataDir, now: () => ROW_LINKS_NOW, iface: () => 'synthetic' });
  try {
    const journal = createJournal({ dataDir, memoryDb: first.memoryDb, now: () => Date.parse(DAY) });
    await journal.memory(ROOT, { id: 'line-a', batchId: 'b-1', attitude: [{ accountId: 'member', delta: 1 }] });
    await journal.memory(ROOT, { id: 'line-a:2', batchId: 'b-2', attitude: [{ accountId: 'member', delta: 2 }] });
  } finally {
    await first.close();
  }
  backTo56(dataDir);
  const second = await openTestMemory({ dataDir, now: () => ROW_LINKS_NOW, iface: () => 'synthetic' });
  try {
    const journal = createJournal({ dataDir, memoryDb: second.memoryDb, now: () => Date.parse(DAY) });
    const read = (await journal.read(ROOT, { day: DAY, n: 10 })) as Array<{
      id?: string;
      attitude?: Array<{ delta?: number }>;
    }>;
    assert.deepEqual(read.map((line) => [line.id, (line.attitude ?? []).map((move) => move.delta)]).sort(), [
      ['line-a', [1]],
      ['line-a:2', [2]],
    ]);
  } finally {
    await second.close();
  }
});

test('a database from before step 57 keeps its lorebook entry ids after the step', async () => {
  // Bug: entries that lose their id read back without one.
  const dataDir = tempDataDir();
  const lore = [
    { id: 'k3x9', title: 'The pier', keys: ['pier'], text: 'Boats tie up at the north end.', always: false },
    { title: 'Tides', keys: ['tide'], text: 'Low water at dawn.', always: true },
  ];
  const first = await openTestMemory({ dataDir, now: () => ROW_LINKS_NOW, iface: () => 'synthetic' });
  let written: unknown;
  try {
    await first.memoryDb.writePlaceLore({ placeId: ROOT, value: lore });
    written = unitValue(dbOf(first.memoryDb.readHandle()!), placeCollection('lore', ROOT));
  } finally {
    await first.close();
  }
  backTo56(dataDir);
  const second = await openTestMemory({ dataDir, now: () => ROW_LINKS_NOW, iface: () => 'synthetic' });
  try {
    const db = dbOf(second.memoryDb.readHandle()!);
    assert.deepEqual(unitValue(db, placeCollection('lore', ROOT)), written);
  } finally {
    await second.close();
  }
});

test('a database from before step 57 keeps the split of a page whose part was applied', async () => {
  // Bug: a run stored before the step names its page and parts only in its batch key, so the next try sends the page
  // whole or split another way and writes the notes of the applied part a second time.
  const dataDir = tempDataDir();
  const first = await openTestMemory({ dataDir, now: () => ROW_LINKS_NOW, iface: () => 'synthetic' });
  await first.close();
  backTo56(
    dataDir,
    `INSERT INTO session_runs (id, scope_key, mode, cursor_from, cursor_to, batch_key, applied, outcome)
       VALUES ('run:part', 'group:synthetic', 'apply', 40, 90, 'apply|group:synthetic|40|90|1|0/3', 1, 'ok');`
  );
  const second = await openTestMemory({ dataDir, now: () => ROW_LINKS_NOW, iface: () => 'synthetic' });
  try {
    const db = dbOf(second.memoryDb.readHandle()!);
    const units = unitsOf(db, {
      mode: 'apply',
      scopeKey: 'group:synthetic',
      cursor: 40,
      cursorTo: 90,
      pages: 2,
      applied: (key) => key === 'apply|group:synthetic|40|90|1|0/3',
      partsOfPage: () => 1,
    });
    assert.deepEqual(
      units.map((unit) => [unit.page, unit.part, unit.parts, unit.applied]),
      [
        [0, 0, 1, false],
        [1, 0, 3, true],
        [1, 1, 3, false],
        [1, 2, 3, false],
      ]
    );
  } finally {
    await second.close();
  }
});

// Schema v11: wake runs with their states and
// idempotent actions, the inner life recording its runs through the service's writer (behind memoryDb.wakeRuns), stale
// runs interrupted at start-up. The skills registry of the SKILL.md skills is tested in
// tests/src/memory/db/skills.test.ts. Synthetic data only; the ids are made up.

// The chat the persona wakes in is held by a fake interface named `fake`.
useIface('fake');

const WAKES_NOW = Date.parse('2026-10-24T12:00:00.000Z');

test('v11: the tables exist, the schema is at its last version, constraints hold', () => {
  const handle = openMemoryDb(':memory:');
  try {
    assert.equal(schemaVersion(dbOf(handle)), BASELINE_VERSION + MIGRATIONS.length);
    for (const table of ['wake_runs', 'wake_actions', 'skills', 'skill_versions'])
      assert.ok(
        dbOf(handle).prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
        table
      );
    const columns = (table: string) =>
      dbOf(handle)
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => column.name as string);
    assert.ok(columns('sources').includes('tier'));
    assert.ok(columns('vectors').includes('evicted_at'));
    assert.ok(columns('media').includes('availability'));
    startRun(handle, { id: 'run-1', kind: 'heartbeat', startedAt: WAKES_NOW });
    // The key must spell the run and the number; an unknown status is refused.
    assert.throws(
      () =>
        dbOf(handle)
          .prepare(
            "INSERT INTO wake_actions (run_id, n, idempotency_key, kind, status, at) VALUES ('run-1', 1, 'wake:other:1', 'x', 'executed', 'now')"
          )
          .run(),
      /CHECK/
    );
    assert.throws(
      () =>
        dbOf(handle)
          .prepare("INSERT INTO wake_runs (id, kind, status) VALUES ('run-2', 'heartbeat', 'sleeping')")
          .run(),
      /CHECK/
    );
    assert.throws(
      () =>
        dbOf(handle)
          .prepare(
            "INSERT INTO wake_actions (run_id, n, idempotency_key, kind, status, at) VALUES ('nope', 1, 'wake:nope:1', 'x', 'executed', 'now')"
          )
          .run(),
      /FOREIGN KEY/
    );
    assert.deepEqual(dbOf(handle).prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    handle.close();
  }
});

// One sent line, one `sources` row. The interface echoes the persona's own message to the core, the observation stores it under the
// key of its message family, and the record line of the same send (src/turn/journal-notes.ts#recordSaid and its siblings,
// all `record.append(placeId, [line], {})`) arrives with no descriptor, so it must find that family by itself.
// Synthetic data only.

const SAID_ROWS_SINGLE_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const SENT = SAID_ROWS_SINGLE_NOW - 60_000;
const IFACE = 'synthetic';
const SAID_ROWS_SINGLE_ROOT = 'root';
// The place that holds the record of the chat's tree, as the pipeline names it (src/memory/addresses.ts#sharedPlaceOf).
const TOP = topPlaceSpelled(IFACE, SAID_ROWS_SINGLE_ROOT);
const ROOM = 'room-a';
const SELF_ID = 'her-account';
const MEMBER = 'member-account';
const WORDS = 'κουνέλι στον κήπο';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;

/** The `message.received` event of a line: the persona's when `author` is their id, as the interface delivers their own echo. */
function lineEvent({
  id = 'sent-1',
  author = SELF_ID,
  at = SENT,
  text = WORDS,
  replyToId,
  mentionedAccountIds = [],
}: {
  id?: string;
  author?: string;
  at?: number;
  text?: string;
  replyToId?: string;
  mentionedAccountIds?: Array<string>;
} = {}) {
  return {
    iface: IFACE,
    at,
    chat: { id: ROOM, kind: 'channel', chatType: 'channel', rootId: SAID_ROWS_SINGLE_ROOT },
    addressing: { mentionedAccountIds },
    message: {
      id,
      at,
      content: text,
      author: { id: author, self: author === SELF_ID },
      ...(replyToId ? { replyToId } : {}),
    },
  };
}

async function observeLine(memory: Memory, options: Parameters<typeof lineEvent>[0] = {}): Promise<string> {
  const envelope = observationOf(lineEvent(options), { selfId: SELF_ID });
  if (!envelope) throw new Error('the synthetic event was refused');
  const done = await memory.memoryDb.observeMessage(envelope, { placeId: TOP });
  if (!done || !('sourceId' in done) || typeof done.sourceId !== 'string')
    throw new Error('the observation was refused');
  return done.sourceId;
}

function database(memory: Memory): Db {
  const db = memory.memoryDb.database();
  if (!db) throw new Error('database unavailable');
  return db;
}

test('a database from before step 58 links every record vector whose line it holds, the -2 ones included', async () => {
  // Bug: vectors stored before the link read the line from its own fields keep no source, so a search by meaning
  // never reaches the line through them.
  const dataDir = tempDataDir();
  const first = await openTestMemory({ dataDir, now: () => SAID_ROWS_SINGLE_NOW, iface: () => IFACE });
  let own: unknown;
  try {
    const sourceId = await observeLine(first, { id: 'member-3', author: MEMBER });
    own = database(first).prepare('SELECT rowid FROM sources WHERE id = ?').get(sourceId)?.rowid;
    const line = { row: 0, kind: 'record', id: 'member-3', revision: 1, occurredAt: new Date(SENT).toISOString() };
    const write = { op: 'append' as const, placeId: TOP, month: '2026-10', model: 'test/embedder' };
    for (const fill of [1, 2])
      await first.memoryDb.writeLineVectors({ ...write, lines: [{ line, bytes: Uint8Array.from([fill, 2, 3, 4]) }] });
  } finally {
    await first.close();
  }
  const raw = new DatabaseSync(path.join(dataDir, 'memory.db'));
  raw.exec(
    "UPDATE vectors SET source_rowid = NULL WHERE kind = 'record'; DELETE FROM schema_version WHERE version > 57;"
  );
  raw.close();
  const second = await openTestMemory({ dataDir, now: () => SAID_ROWS_SINGLE_NOW, iface: () => IFACE });
  try {
    const links = database(second)
      .prepare("SELECT source_rowid FROM vectors WHERE item_id = 'member-3' ORDER BY chunk_key")
      .all()
      .map((row) => row.source_rowid);
    assert.deepEqual(links, [own, own]);
  } finally {
    await second.close();
  }
});
