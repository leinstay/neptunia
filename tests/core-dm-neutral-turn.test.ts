// A direct chat from the door to the request, over the real link with fake interfaces, a scripted model and temporary
// folders: a DM has no community, nothing manufactures one, and the partner's person is read from the stored account.
// Black box on purpose: what is asserted is what the database and the request hold after the turn.
// Plan 2026-11-04-cli-and-memory task 5, routing and queues, turn preflight and context.
// Appendix entries: src/core.ts, src/pipeline/{handle-message,observe,conversations,private-gate}.ts,
// src/behavior/{core-pause,pipeline,turn,turn-input}.ts, src/turn/inputs.ts, src/turn/phases/{preflight,context}.ts,
// src/turn/phases/request/{build,setup,gather,facts}.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from '../src/memory/db/types.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { addAccount, addClaim, addDmPlace } from './fixtures/memory-db/opaque-people.ts';
import {
  directIn,
  mentionIn,
  postedIn,
  seedDm,
  seedPerson,
  seedRoom,
  waitFor,
  withFakes,
} from './fixtures/two-fakes.ts';
import type { Rig, Running } from './fixtures/two-fakes.ts';

const OPAQUE = 'person:4c9e77d1';

type Unit = { kind: string; subject_type: string; subject_id: string; scope_place_id: string | null };
const unitsOf = (rig: Rig): Array<Unit> =>
  rig
    .rows('SELECT kind, subject_type, subject_id, scope_place_id FROM storage_units')
    .map((row) => row as unknown as Unit);

async function dmTurn(running: Running, conversation: string, author: string, id: string): Promise<void> {
  seedDm(running, conversation, author);
  await directIn(running, conversation, author, id);
  await waitFor(() => postedIn(running, conversation).length > 0, `the answer on ${running.iface}`);
}

/**
 * Rows the writer did not make, over a plain connection because the running core holds the writer's lock. Only before
 * the first event, and only rows no cache holds yet.
 */
function seedOver(rig: Rig, body: (db: Db) => void): void {
  const connection = new DatabaseSync(join(rig.dataDir, 'memory.db'));
  try {
    body(wrongly<Db>(connection));
  } finally {
    connection.close();
  }
}

test('a DM on a core with no community stores nothing under a community scope', async () => {
  // Bug: the turn preflight falls back to `no-community`, a scope that names no place and collides across interfaces.
  await withFakes({ owners: ['u1'], names: ['one'] }, async (rig) => {
    const one = await rig.connect('one', []);
    await dmTurn(one, 'dm-1', 'u1', 'm1');
    const scoped = unitsOf(rig).filter((unit) => unit.scope_place_id !== null);
    assert.deepEqual(
      scoped.map((unit) => unit.scope_place_id),
      []
    );
    assert.equal(
      unitsOf(rig).some((unit) => unit.subject_id.includes('no-community')),
      false
    );
  });
});

test('the journal of a DM turn is a collection of its actual DM place', async () => {
  // Bug: a DM's journal day sits under a fabricated community, so the place browser cannot reach it.
  await withFakes({ owners: ['u1'], names: ['one'] }, async (rig) => {
    const one = await rig.connect('one', []);
    await dmTurn(one, 'dm-1', 'u1', 'm1');
    const places = rig.rows("SELECT id FROM places WHERE conversation = 'dm'").map((row) => row.id);
    assert.equal(places.length, 1);
    // The engine's own system lines have no conversation: they belong to the persona.
    const journal = unitsOf(rig).filter((unit) => unit.kind === 'journal' && unit.subject_type !== 'persona');
    assert.ok(journal.length > 0);
    for (const unit of journal) {
      assert.equal(unit.subject_type, 'place');
      assert.equal(unit.subject_id, places[0]);
    }
  });
});

test('equal native ids on two interfaces keep two places and two sets of public units', async () => {
  // Bug: the collection key holds the native community id, and only the ambient interface keeps the two apart.
  await withFakes({ owners: ['u1'], names: ['one', 'two'] }, async (rig) => {
    const same = [{ id: 'same', name: 'Same id' }];
    const one = await rig.connect('one', same);
    const two = await rig.connect('two', same);
    seedRoom(one, 'room', 'same');
    seedRoom(two, 'room', 'same');
    await mentionIn(one, 'room', 'same', 'm1');
    await waitFor(() => postedIn(one, 'room').length > 0, 'the answer on one');
    await mentionIn(two, 'room', 'same', 'm2');
    await waitFor(() => postedIn(two, 'room').length > 0, 'the answer on two');
    const known = rig.rows('SELECT id FROM places').map((row) => row.id);
    const journals = unitsOf(rig).filter((unit) => unit.kind === 'journal' && unit.subject_type !== 'persona');
    assert.equal(new Set(journals.map((unit) => unit.subject_id)).size, 2);
    for (const unit of journals) assert.ok(known.includes(unit.subject_id), unit.subject_id);
  });
});

test('a DM on the interface that serves the configured community takes nothing of that community', async () => {
  // Bug: `dmCommunityOf` answers the home community, so the private units of a DM are scoped to a server.
  await withFakes({ guildId: 'home', owners: ['u1'], names: ['one'] }, async (rig) => {
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

test('a group turn stores its public collections under the place of its community, a real place row', async () => {
  // Bug: the scope is a spelled `<iface>:guild:<id>` string that no `places` row answers.
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
      unitsOf(rig).filter((unit) => /:guild:/.test(unit.subject_id) || /:guild:/.test(unit.scope_place_id ?? '')),
      []
    );
  });
});

test('a DM turn issues its context for the person stored on the account, not one spelled from the native id', async () => {
  // Bug: src/turn/inputs.ts manufactures `person:<iface>:<native>`, so an opaque person gets a context of nobody.
  await withFakes({ owners: ['u1'], names: ['one'] }, async (rig) => {
    const one = await rig.connect('one', []);
    seedOver(rig, (db) => {
      addAccount(db, { id: 'account:u1', iface: 'one', authority: 'one/global', native: 'u1', person: OPAQUE });
    });
    await dmTurn(one, 'dm-1', 'u1', 'm1');
    const issued = rig.rows("SELECT partner_person_id FROM execution_contexts WHERE mode = 'outward'");
    assert.ok(issued.length > 0);
    assert.deepEqual([...new Set(issued.map((row) => row.partner_person_id))], [OPAQUE]);
  });
});

test('what the person said in a linked DM on another interface reaches the request, and a stranger DM does not', async () => {
  // Bug: the request reads one community's unit of one account, so a private-only person arrives with empty memory.
  await withFakes({ owners: ['u1'], names: ['one'] }, async (rig) => {
    const one = await rig.connect('one', []);
    seedOver(rig, (db) => {
      addAccount(db, { id: 'account:u1', iface: 'one', authority: 'one/global', native: 'u1', person: OPAQUE });
      addAccount(db, { id: 'account:far', iface: 'far', authority: 'far/global', native: 'n1', person: OPAQUE });
      addAccount(db, {
        id: 'account:else',
        iface: 'far',
        authority: 'far/global',
        native: 'n2',
        person: 'person:else',
      });
      addDmPlace(db, {
        id: 'place:far',
        iface: 'far',
        authority: 'far/global',
        account: 'account:far',
        person: OPAQUE,
      });
      addDmPlace(db, {
        id: 'place:else',
        iface: 'far',
        authority: 'far/global',
        account: 'account:else',
        person: 'person:else',
      });
      addClaim(db, 'claim:far', OPAQUE, 'aud:dm:place:far', 'keeps bees on a synthetic roof');
      addClaim(db, 'claim:else', OPAQUE, 'aud:dm:place:else', 'owes a synthetic debt');
    });
    await dmTurn(one, 'dm-1', 'u1', 'm1');
    const requests = JSON.stringify(rig.requests);
    assert.ok(requests.includes('keeps bees on a synthetic roof'));
    assert.equal(requests.includes('owes a synthetic debt'), false);
  });
});
