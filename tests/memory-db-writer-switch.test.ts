// The open description flags (src/memory/db/writer-switch.ts#openFlags): the context a flag's review reads in.
// Synthetic ids only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { openFlags } from '../src/memory/db/writer-switch.ts';
import { canRead } from '../src/memory/db/scope.ts';
import { sqlOf, wrongly } from './fixtures/loose-types.ts';
import type { Db } from '../src/memory/db/types.ts';

const PLACE = 'discord:dm:n1';
const AUDIENCE = `aud:dm:${PLACE}`;
const META = 'person:0b6f2c1e-0000-4000-8000-000000000001';

/** A DM session run whose partner is a meta-person, and the flag it raised on one field of `subject`. */
function flagged(subject: { kind: string; id: string }, field: string) {
  const handle = openMemoryDb(':memory:');
  const db = sqlOf(handle);
  db.prepare("INSERT INTO places (id, kind, iface, partner_account) VALUES (?, 'dm', 'discord', 'discord:n1')").run(
    PLACE
  );
  db.prepare("INSERT INTO audiences (id, kind, iface, place_id) VALUES (?, 'dm', 'discord', ?)").run(AUDIENCE, PLACE);
  db.prepare(
    `INSERT INTO session_runs (id, sweep_id, scope_key, scope_kind, scope_iface, scope_dm, mode, started_at, outcome, audience_id)
     VALUES ('run:r1', 'sweep:s1', ?, 'dm', 'discord', ?, 'apply', '2026-11-08T10:00:00.000Z', 'ok', ?)`
  ).run(`dm:discord:${PLACE}`, META, AUDIENCE);
  const scope = { scope_kind: 'dm', scope_iface: 'discord', scope_dm: META };
  db.prepare(
    `INSERT INTO decisions (id, at, by, target_kind, target_id, action, reason, extra)
     VALUES ('dec:run:r1:0', '2026-11-08T10:00:01.000Z', 'her', 'description', 'desc:x', 'flag:description', 'never written', ?)`
  ).run(
    JSON.stringify({
      run: 'run:r1',
      scope,
      op: { subjectKind: subject.kind, subjectId: subject.id, field, why: 'never written' },
    })
  );
  return wrongly<Db>(handle.db);
}

test('reads a direct chat flag in its own chat when the partner is a meta-person', () => {
  const db = flagged({ kind: 'place', id: PLACE }, 'purpose');
  const [flag] = openFlags(db, {});
  assert.ok(flag);
  assert.equal(canRead({ audience_id: AUDIENCE }, flag.readCtx), true);
});

test('keeps another direct chat out of a flag raised in one direct chat', () => {
  const db = flagged({ kind: 'person', id: META }, 'relationship');
  const [flag] = openFlags(db, {});
  assert.ok(flag);
  assert.equal(canRead({ audience_id: 'aud:dm:discord:dm:n2' }, flag.readCtx), false);
});
