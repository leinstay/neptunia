import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  directIn,
  mentionIn,
  postedIn,
  type Rig,
  type Running,
  seedDm,
  seedPerson,
  seedRoom,
  waitFor,
  withFakes,
} from '../../../fixtures/two-fakes.ts';

type Unit = { kind: string; subject_type: string; subject_id: string; scope_place_id: string | null };

/** The tables whose rows name their writer and holder (upsert.ts). */
const OWNED_TABLES = [
  'sources',
  'day',
  'decisions',
  'claims',
  'claim_versions',
  'operational',
  'episodes',
  'accounts',
  'people',
];

/** Every collection the writers hold, read from the rows' writer and holder columns: a writer as its kind, its holder as subject. */
const unitsOf = (rig: Rig): Array<Unit> =>
  rig
    .rows(
      `SELECT DISTINCT CASE writer WHEN 'profile' THEN 'user' ELSE writer END AS kind,
         CASE WHEN holder_id = 'persona:local' THEN 'persona' WHEN writer IN ('profile', 'private') THEN 'account'
           ELSE 'place' END AS subject_type,
         holder_id AS subject_id, NULL AS scope_place_id
       FROM (${OWNED_TABLES.map((table) => `SELECT writer, holder_id FROM "${table}"`).join(' UNION ALL ')})
       WHERE writer IS NOT NULL AND writer != 'session' AND holder_id IS NOT NULL`
    )
    .map((row) => row as unknown as Unit);

async function dmTurn(running: Running, chat: string, author: string, id: string): Promise<void> {
  seedDm(running, chat, author);
  await directIn(running, chat, author, id);
  await waitFor(() => postedIn(running, chat).length > 0, `the answer on ${running.iface}`);
}

test('a DM on a core with no root stores nothing under a root scope', async () => {
  // Bug: the turn preflight falls back to `no-root`, a scope that names no place and collides across interfaces.
  await withFakes({ owners: ['u1'], names: ['one'] }, async (rig) => {
    const one = await rig.connect('one', []);
    await dmTurn(one, 'dm-1', 'u1', 'm1');
    const scoped = unitsOf(rig).filter((unit) => unit.scope_place_id !== null);
    assert.deepEqual(
      scoped.map((unit) => unit.scope_place_id),
      []
    );
    assert.equal(
      unitsOf(rig).some((unit) => unit.subject_id.includes('no-root')),
      false
    );
  });
});

test('a DM on the interface that serves the configured root takes nothing of that root', async () => {
  // Bug: `dmRootOf` answers the home root, so the private units of a DM are scoped to a server.
  await withFakes({ owners: ['u1'], names: ['one'] }, async (rig) => {
    const one = await rig.connect('one', [{ id: 'home', name: 'Home' }]);
    seedPerson(one, 'home', 'u1', 'Eleni');
    await dmTurn(one, 'dm-2', 'u1', 'm1');
    const dmUnits = unitsOf(rig).filter((unit) => unit.kind === 'private');
    assert.deepEqual(
      dmUnits.filter((unit) => unit.scope_place_id !== null),
      []
    );
    const journals = unitsOf(rig).filter((unit) => unit.kind === 'journal');
    assert.deepEqual(
      journals.filter((unit) => (unit.scope_place_id ?? '').includes('home') || unit.subject_id.includes('home')),
      []
    );
  });
});

test('a group turn stores its public collections under the place of its root, a real place row', async () => {
  // Bug: the scope is a spelled `<iface>:root:<id>` string that no `places` row answers.
  await withFakes({ owners: ['u1'], names: ['one'] }, async (rig) => {
    const one = await rig.connect('one', [{ id: 'g1', name: 'Alpha' }]);
    seedRoom(one, 'r1', 'g1');
    await mentionIn(one, 'r1', 'g1', 'm1');
    await waitFor(() => postedIn(one, 'r1').length > 0, 'the answer in the room');
    const known = new Set(rig.rows('SELECT id FROM places').map((row) => row.id));
    const subjects = unitsOf(rig).filter((unit) => unit.subject_type === 'place');
    assert.ok(subjects.length > 0);
    for (const unit of subjects) assert.ok(known.has(unit.subject_id), `${unit.kind} ${unit.subject_id}`);
    assert.deepEqual(
      unitsOf(rig).filter((unit) => /:root:/.test(unit.subject_id) || /:root:/.test(unit.scope_place_id ?? '')),
      []
    );
  });
});
