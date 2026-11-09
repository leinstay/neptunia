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
//   embedObjects({ db, write, embed, config, model, now }): Promise<{ pending, written }>   one bounded batch: at most
//     `memoryDb.retrieval.embedBatch` pending texts, oldest first, cut to stay under `llm.maxRequestTokens`, in one
//     `embed` request with purpose `memory-object`, written through one `object-embedding` message
// Names are invented, in Greek and accented Latin.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { auditMemory } from '../src/memory/db/audit.ts';
import { applyObjectEmbedding, embedObjects, pendingObjectEmbeds } from '../src/memory/db/object-vectors.ts';
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

test('object vectors keep their audience', async () => {
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
    assert.equal(checks.audienceDerived, 0);
  } finally {
    db.close();
  }
});

// ---------- the minute job ----------

type EmbedCall = { texts: Array<string>; purpose: unknown };

/** A fake embedding client: one vector per text, every call recorded. */
function fakeEmbedder(calls: Array<EmbedCall>, fail = false) {
  return (texts: ReadonlyArray<string>, options: Record<string, unknown>): Promise<unknown> => {
    calls.push({ texts: [...texts], purpose: options.purpose });
    return fail ? Promise.reject(new Error('provider down')) : Promise.resolve(texts.map(() => VECTOR));
  };
}

/** A person with episodes far older than anything else in the world, each `what` its own text. */
function withEpisodes(episodes: Array<{ id: string; what: string; at: string }>): World {
  const w = withPerson();
  insertRows(w.db, {
    episodes: episodes.map((one) => ({
      id: one.id,
      kind: 'episode',
      subject_id: PERSON,
      what: one.what,
      created_at: one.at,
      scope_kind: 'group',
      scope_iface: 'discord',
      scope_dm: null,
    })),
  });
  // The world's name sets get their vectors first, so the job's batch holds only the episodes.
  const others = pendingObjectEmbeds(w.db, { model: MODEL, limit: 1000 }).filter((one) => one.kind !== 'episode');
  applyMemoryWrite(w.handle, { kind: 'object-embedding', model: MODEL, now: NOW, items: others.map(embedded) });
  return w;
}

function runJob(w: World, calls: Array<EmbedCall>, config: unknown, fail = false) {
  return embedObjects({
    db: w.db,
    write: (update) => Promise.resolve(applyMemoryWrite(w.handle, update)),
    embed: fakeEmbedder(calls, fail),
    config,
    model: MODEL,
    now: NOW,
  });
}

const vectorsOf = (db: Db, prefix: string): Array<string> =>
  db
    .prepare('SELECT item_id FROM vectors WHERE substr(chunk_key, 1, ?) = ? ORDER BY item_id')
    .all(prefix.length, prefix)
    .map((row) => String(row.item_id));

test('the job embeds at most embedBatch texts, oldest first, in one request', async () => {
  // Bug: the job sends every pending text at once, or the newest first, so a backfill outruns the batch it promised.
  const w = withEpisodes([
    { id: 'episode:c', what: 'Τρίτο επεισόδιο', at: '2020-01-03T00:00:00.000Z' },
    { id: 'episode:a', what: 'Πρώτο επεισόδιο', at: '2020-01-01T00:00:00.000Z' },
    { id: 'episode:b', what: 'Δεύτερο επεισόδιο', at: '2020-01-02T00:00:00.000Z' },
  ]);
  const calls: Array<EmbedCall> = [];
  await runJob(w, calls, { memoryDb: { retrieval: { embedBatch: 2 } }, llm: { maxRequestTokens: 50000 } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].texts, ['Πρώτο επεισόδιο', 'Δεύτερο επεισόδιο']);
  assert.equal(calls[0].purpose, 'memory-object');
  assert.deepEqual(vectorsOf(w.db, 'episode:'), ['episode:a', 'episode:b']);
  assert.equal(pendingOf(w.db, 'episode:c').length, 1);
});

test('the job cuts a batch at llm.maxRequestTokens and sends the rest on its next run', async () => {
  // Bug: a batch over the request cap goes out whole, the client refuses it, and nothing is ever embedded.
  const w = withEpisodes([
    { id: 'episode:a', what: 'Α'.repeat(20), at: '2020-01-01T00:00:00.000Z' },
    { id: 'episode:b', what: 'Β'.repeat(20), at: '2020-01-02T00:00:00.000Z' },
  ]);
  const config = { memoryDb: { retrieval: { embedBatch: 50 } }, llm: { maxRequestTokens: 15 } };
  const calls: Array<EmbedCall> = [];
  await runJob(w, calls, config);
  assert.deepEqual(calls[0].texts, ['Α'.repeat(20)]);
  assert.deepEqual(vectorsOf(w.db, 'episode:'), ['episode:a']);
  await runJob(w, calls, config);
  assert.deepEqual(calls[1].texts, ['Β'.repeat(20)]);
  assert.deepEqual(vectorsOf(w.db, 'episode:'), ['episode:a', 'episode:b']);
});

test('a failed embedding request leaves the batch pending', async () => {
  // Bug: the job marks the batch done before the vectors arrive, so a provider outage loses the objects for good.
  const w = withEpisodes([{ id: 'episode:a', what: 'Πρώτο επεισόδιο', at: '2020-01-01T00:00:00.000Z' }]);
  const calls: Array<EmbedCall> = [];
  await runJob(w, calls, { memoryDb: { retrieval: { embedBatch: 5 } }, llm: { maxRequestTokens: 50000 } }, true).catch(
    () => {}
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(vectorsOf(w.db, 'episode:'), []);
  assert.equal(pendingOf(w.db, 'episode:a').length, 1);
});

test('the job sends no request when nothing is pending', async () => {
  // Bug: the steady state spends one request a minute on an empty batch against the daily cap.
  const w = withEpisodes([{ id: 'episode:a', what: 'Πρώτο επεισόδιο', at: '2020-01-01T00:00:00.000Z' }]);
  const config = { memoryDb: { retrieval: { embedBatch: 1000 } }, llm: { maxRequestTokens: 50000 } };
  const calls: Array<EmbedCall> = [];
  await runJob(w, calls, config);
  await runJob(w, calls, config);
  assert.equal(calls.length, 1);
});
