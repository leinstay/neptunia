// src/memory/db/object-vectors.ts: the vectors of the memory objects a search reads as text (spec
// 2026-11-08-embeddings-everywhere, slice 1). A live claim, a description, a live episode and the name set of a person or
// a place in one audience each get one row of `vectors` under their own chunk key, with the hash of the text in
// `context`. The writer's projection retires a row whose object changed its text or retired, in the same write.
// Contract:
//   pendingObjectEmbeds(db, { model, limit }): Array<PendingObject>   the objects with no vector of `model`
//   PendingObject = { kind: 'claim' | 'desc' | 'episode' | 'names'; itemId; audienceId; text; hash; chunkKey; at }
//   the writer message { kind: 'object-embedding', model, now, items: [{ kind, itemId, audienceId, hash, vector }] }
//     writes a row only while the object still holds the text of `hash`; returns { written }
//   touchVectors(db, table, id), called by graph.ts#projectRow beside names.ts#touchNames
// Names are invented, in Greek and accented Latin.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { auditMemory } from '../src/memory/db/audit.ts';
import { applyObjectEmbedding, pendingObjectEmbeds } from '../src/memory/db/object-vectors.ts';
import type { PendingObject } from '../src/memory/db/object-vectors.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import type { Db } from '../src/memory/db/types.ts';
import { auditWorld } from './fixtures/memory-audit-world.ts';
import {
  AT,
  NOW,
  addClaim,
  addDm,
  addPerson,
  noteInterface,
  openWorld,
  personNode,
} from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';

const MODEL = 'test/embedder';
const VECTOR = [0.25, -0.5, 0.75];

const worlds: Array<World> = [];
after(() => {
  for (const world of worlds) world.close();
});

function world(): World {
  const opened = openWorld();
  worlds.push(opened);
  noteInterface(opened, 'discord', [{ id: 'g1', name: 'Ágora' }]);
  return opened;
}

const pendingOf = (db: Db, itemId: string): Array<PendingObject> =>
  pendingObjectEmbeds(db, { model: MODEL, limit: 1000 }).filter((one) => one.itemId === itemId);

const embedded = (pending: PendingObject) => ({
  kind: pending.kind,
  itemId: pending.itemId,
  audienceId: pending.audienceId,
  hash: pending.hash,
  vector: VECTOR,
});

function embed(w: World, pending: PendingObject): unknown {
  return applyMemoryWrite(w.handle, { kind: 'object-embedding', model: MODEL, now: NOW, items: [embedded(pending)] });
}

const rowCount = (db: Db, chunkKey: string): number =>
  Number(db.prepare('SELECT COUNT(*) AS n FROM vectors WHERE chunk_key = ?').get(chunkKey)?.n);

const PERSON = 'person:discord:n1';
const fact = (text: string) => ({
  id: 'claim:fact:n1',
  person: PERSON,
  kind: 'fact' as const,
  text,
  audience: { group: 'discord' },
});

function withPerson(): World {
  const w = world();
  addPerson(w.db, {
    id: PERSON,
    accounts: [{ id: 'discord:n1', iface: 'discord', native: 'n1', names: ['Nikifóros'] }],
  });
  return w;
}

test('a claim whose text changes loses its vector in the same write and is pending with the new text', () => {
  // Bug: the vector of the old text stays, so a search ranks the claim by words it no longer holds.
  const w = withPerson();
  addClaim(w.db, fact('Μαγειρεύει κάθε Κυριακή'));
  const [pending] = pendingOf(w.db, 'claim:fact:n1');
  assert.ok(pending, 'the new claim is pending');
  embed(w, pending);
  assert.equal(rowCount(w.db, pending.chunkKey), 1);
  addClaim(w.db, fact('Δεν μαγειρεύει πια'));
  assert.equal(rowCount(w.db, pending.chunkKey), 0);
  assert.deepEqual(
    pendingOf(w.db, 'claim:fact:n1').map((one) => one.text),
    ['Δεν μαγειρεύει πια']
  );
});

test('a claim written again with the same text keeps its vector', () => {
  // Bug: every projection deletes the row, so each confirmation of a claim pays for a new embedding.
  const w = withPerson();
  addClaim(w.db, fact('Παίζει βιολί'));
  const [pending] = pendingOf(w.db, 'claim:fact:n1');
  embed(w, pending);
  addClaim(w.db, fact('Παίζει βιολί'));
  assert.equal(rowCount(w.db, pending.chunkKey), 1);
  assert.deepEqual(pendingOf(w.db, 'claim:fact:n1'), []);
});

test('a retired episode loses its vector and is pending no more', () => {
  // Bug: an episode the session closed keeps ranking places and people by its vector.
  const w = withPerson();
  const episode = {
    id: 'episode:n1',
    kind: 'episode',
    subject_id: PERSON,
    what: 'Έφερε γλυκά στη συνάντηση',
    quote: 'Τα έφτιαξα μόνος μου',
    created_at: AT,
    scope_kind: 'group',
    scope_iface: 'discord',
    scope_dm: null,
  };
  insertRows(w.db, { episodes: [episode] });
  const [pending] = pendingOf(w.db, 'episode:n1');
  assert.equal(pending?.text, 'Έφερε γλυκά στη συνάντηση\nΤα έφτιαξα μόνος μου');
  embed(w, pending);
  assert.equal(rowCount(w.db, pending.chunkKey), 1);
  insertRows(w.db, { episodes: [{ ...episode, retired_at: '2026-11-01T12:00:00.000Z' }] });
  assert.equal(rowCount(w.db, pending.chunkKey), 0);
  assert.deepEqual(pendingOf(w.db, 'episode:n1'), []);
});

test('a name set of a DM audience is keyed apart from the group set of the same person', () => {
  // Bug: one set per person mixes a name learned in a private chat into the vector a group search reads.
  const w = withPerson();
  const dm = addDm(w.db, { iface: 'discord', native: 'n1', person: PERSON, account: 'discord:n1' });
  addClaim(w.db, {
    id: 'claim:alias:n1',
    person: PERSON,
    kind: 'alias',
    text: 'Níkos',
    audience: { dm, iface: 'discord', person: PERSON },
  });
  const sets = pendingOf(w.db, personNode(PERSON)).filter((one) => one.kind === 'names');
  const dmSet = sets.find((one) => one.audienceId === `aud:dm:${dm}`);
  const groupSet = sets.find((one) => one.audienceId === 'aud:group:discord');
  assert.ok(dmSet && groupSet, 'one set per audience');
  assert.notEqual(dmSet.chunkKey, groupSet.chunkKey);
  assert.equal(dmSet.text, 'Níkos');
  assert.ok(!groupSet.text.includes('Níkos'), 'the group set holds no private alias');
  assert.ok(groupSet.text.includes('Nikifóros'), 'the group set holds the public name');
});

test('an embedding of a text the claim no longer holds writes nothing', () => {
  // Bug: a vector made before a revision lands after it and is kept as the vector of the new text.
  const w = withPerson();
  addClaim(w.db, fact('Ζει κοντά στη θάλασσα'));
  const [pending] = pendingOf(w.db, 'claim:fact:n1');
  addClaim(w.db, fact('Μετακόμισε στα βουνά'));
  assert.deepEqual(embed(w, pending), { written: 0 });
  assert.equal(rowCount(w.db, pending.chunkKey), 0);
});

test('object vectors are counted by no month manifest and keep their audience', async () => {
  // Bug: an object vector is filed under a month, so the month's manifest no longer counts what it holds, or the row
  // carries an audience its scope does not resolve to.
  let written = 0;
  const file = await auditWorld((db) => {
    const items = pendingObjectEmbeds(db, { model: MODEL, limit: 1000 }).map(embedded);
    written = applyObjectEmbedding(db, { model: MODEL, now: NOW, items }).written;
  });
  assert.ok(written >= 3, 'the world holds a claim, a description and an episode');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const { checks } = auditMemory(db);
    assert.equal(checks.vectorManifests, 0);
    assert.equal(checks.audienceDerived, 0);
  } finally {
    db.close();
  }
});
