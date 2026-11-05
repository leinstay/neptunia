// One DM place is one scope: whatever values its rows carry in `scope_dm`, a memory session sweeps it once, from one cursor,
// and no line is read twice or left unread. The values come from history (a line seen before the account was linked, the
// importer's spelling of the command line, the owner's person on new lines); a link made later must not fork the DM again.
// Synthetic ids and text only. The scopes and batches are read through the exports of `session.ts`, as the sweep reads them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { observe } from '../src/memory/db/observe.ts';
import { batchOf, cursorKey, scopesOf } from '../src/memory/db/session.ts';
import type { SweepScope } from '../src/memory/db/session.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import {
  CLI_AUDIENCE,
  CLI_PLACE,
  CURSOR_AT,
  LINES,
  OLD_PERSON,
  OWNER,
  addCliLines,
  addCliPlace,
  productionWorld,
} from './fixtures/memory-audit-production.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPAIR = path.join(ROOT, 'scripts', 'memory-repair-audit.ts');

const cliScopes = (db: Db): Array<SweepScope> =>
  scopesOf(db, { audienceColumn: true }).filter((one) => one.scope.scope_iface === 'cli');

/** The ids of the lines the sweep would read for `scope` after `cursor`, in the order it reads them. */
const batchIds = (db: Db, scope: SweepScope, cursor: number): Array<string> =>
  batchOf(db, scope.scope, {
    cursor,
    since: null,
    maxMessages: 1000,
    settleBefore: Number.POSITIVE_INFINITY,
    audienceId: scope.audienceId ?? null,
  }).map((line) => String(line.id));

const ids = (from: number, to: number): Array<string> =>
  Array.from({ length: to - from + 1 }, (_, i) => `src:cli:${from + i}`);

test('lines that carry three spellings of the partner make one scope, not one per spelling', () => {
  // Bug: a line with the owner's opaque person keys a second scope (`dm:cli:<place>`) beside `dm:cli:person:cli:owner`;
  // each starts at cursor 0 and reads the whole DM, so every line is summarised twice.
  const file = path.join(tempDir('nep-dm-one-scope-'), 'memory.db');
  openMemoryDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = OFF');
  addCliPlace(raw, 'person:0wn3r');
  addCliLines(raw, 9, (n) => (n % 3 === 0 ? null : n % 3 === 1 ? OLD_PERSON : 'person:0wn3r'));
  raw.close();
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    const db = dbOf(handle);
    const scopes = cliScopes(db);
    assert.equal(scopes.length, 1);
    assert.deepEqual(batchIds(db, scopes[0], 0), ids(1, 9), 'every line once, in arrival order');
  } finally {
    handle.close();
  }
});

test('a DM whose lines all carry the place partner is swept as one scope that reads its lines', () => {
  // Bug: a person spelled for another interface (`person:discord:...` on a `cli` DM) names no audience from the triple, so
  // the scope is dropped as malformed and the DM is never summarised once its old rows are retired.
  const file = path.join(tempDir('nep-dm-one-scope-'), 'memory.db');
  openMemoryDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = OFF');
  addCliPlace(raw);
  addCliLines(raw, 4, () => OWNER);
  raw.close();
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    const db = dbOf(handle);
    const scopes = cliScopes(db);
    assert.equal(scopes.length, 1);
    const [scope] = scopes as [SweepScope];
    assert.equal(scope.audienceId, CLI_AUDIENCE);
    assert.equal(scope.ctx.place, CLI_PLACE);
    assert.equal(scope.ctx.person, OWNER);
    assert.deepEqual(batchIds(db, scope, 0), ids(1, 4));
  } finally {
    handle.close();
  }
});

test('after the repair the session sweeps the DM as one scope with the cursor it had, no line read twice or skipped', async () => {
  // Bug: normalising `scope_dm` renames the scope key, the new key starts at cursor 0, and the eight lines already
  // summarised are read again; or the scope is dropped and the seven lines after the cursor are never read.
  const file = await productionWorld();
  const done = spawnSync(process.execPath, [REPAIR, '--db', file, '--apply'], { cwd: ROOT, encoding: 'utf8', env: {} });
  assert.equal(done.status, 0, done.stderr);
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    const db = dbOf(handle);
    const scopes = cliScopes(db);
    assert.equal(scopes.length, 1, 'one scope for the one DM');
    const [scope] = scopes as [SweepScope];
    const kept = db.prepare('SELECT value FROM meta WHERE key = ?').get(cursorKey('apply', scope.key))?.value;
    const old = db.prepare('SELECT rowid FROM sources WHERE id = ?').get(`src:cli:${CURSOR_AT}`)?.rowid;
    assert.equal(Number(kept), Number(old), 'the cursor of the old key is the cursor of the scope');
    assert.deepEqual(
      db
        .prepare("SELECT key FROM meta WHERE key LIKE 'memory_session.cursor.apply.dm:cli:%'")
        .all()
        .map((row) => row.key),
      [cursorKey('apply', scope.key)],
      'no cursor is left under a key the sweep no longer walks'
    );
    assert.deepEqual(batchIds(db, scope, Number(kept)), ids(CURSOR_AT + 1, LINES));
  } finally {
    handle.close();
  }
});

test('an account linked after its first lines does not fork the DM: every row of the place takes the partner', () => {
  // Bug: `linkOwnerAccount` re-points the place to the owner's person and nothing rewrites the rows already stored, so
  // the lines before the link keep one `scope_dm` and the lines after it carry another.
  const file = path.join(tempDir('nep-dm-link-later-'), 'memory.db');
  const handle = openMemoryDb(file);
  try {
    const db = dbOf(handle);
    const line = (n: number, link: boolean) => {
      const at = Date.parse('2026-11-05T10:00:00Z') + n * 60_000;
      const envelope = observationOf(
        {
          kind: 'message.received',
          iface: 'cli',
          at,
          conversation: { id: CLI_PLACE, kind: 'dm', chatType: 'dm', partnerId: 'owner' },
          message: { id: `line-${n}`, at, content: 'a synthetic line', author: { id: 'owner', name: 'owner' } },
        },
        { connection: 'conn:cli', direct: true }
      );
      assert.ok(envelope);
      const given = link ? { ...envelope, consoleOwner: { person: OWNER, listed: [] } } : envelope;
      const stored = observe(handle, given, { now: () => at });
      assert.equal(stored.ok, true);
    };
    line(1, false);
    const before = db.prepare("SELECT scope_dm FROM sources WHERE place_id = ? AND kind = 'seen'").all(CLI_PLACE);
    assert.equal(before.length, 1);
    assert.notEqual(before[0]?.scope_dm, OWNER, 'the first line was stored before the account was linked');
    db.prepare(
      `INSERT INTO day (id, at, what, place_id, scope_kind, scope_iface, scope_dm, audience_id)
       VALUES ('day:before-link', '2026-11-05T10:00:30.000Z', 'turn', ?, 'dm', 'cli', ?, ?)`
    ).run(CLI_PLACE, before[0]?.scope_dm ?? null, CLI_AUDIENCE);

    line(2, true);
    line(3, true);

    assert.deepEqual(
      db
        .prepare("SELECT DISTINCT scope_dm FROM sources WHERE place_id = ? AND kind = 'seen'")
        .all(CLI_PLACE)
        .map((row) => ({ ...row })),
      [{ scope_dm: OWNER }],
      'the lines before and after the link share one scope_dm'
    );
    assert.deepEqual(
      db
        .prepare("SELECT scope_dm, audience_id FROM day WHERE id = 'day:before-link'")
        .all()
        .map((row) => ({ ...row })),
      [{ scope_dm: OWNER, audience_id: CLI_AUDIENCE }],
      'a derived row of the DM follows, and keeps its audience'
    );
    const scopes = cliScopes(db);
    assert.equal(scopes.length, 1);
    assert.equal(batchIds(db, scopes[0], 0).length, 3, 'all three lines are read, once');
  } finally {
    handle.close();
  }
});
