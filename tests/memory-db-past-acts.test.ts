// What she already did near a proposed purpose (src/memory/db/past-acts.ts), read from the engine's own tables on a
// memory database built with the real schema (tests/fixtures/memory-db/mind-world.ts): her own lines by their stored
// vectors with what people wrote after them, and her intentions with what the turns that carried them out sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownIntentionsOf, pastActsOf } from '../src/memory/db/past-acts.ts';
import type { PastAct } from '../src/memory/db/past-acts.ts';
import { writeIntentions } from '../src/memory/db/intentions-write.ts';
import { finishRun, startRun } from '../src/memory/db/wakes.ts';
import { quantize } from '../src/memory/vectors.ts';
import { addLine } from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
import { TURN_NOW, serviceWorld } from './fixtures/service-turn.ts';

const MODEL = 'x/embed';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GARDEN = 'fake:channel:c2';
const ROOM = 'fake:channel:c1';
const HARBOUR = 'tele:channel:k1';
const NEAR: ReadonlyArray<number> = [1, 0, 0, 0];
const FAR: ReadonlyArray<number> = [0, 1, 0, 0];
/** A vector at a cosine of about 0.67 to NEAR: past the limit of an intention and short of the limit of a line. */
const BETWEEN: ReadonlyArray<number> = [0.67, Math.sqrt(1 - 0.67 * 0.67), 0, 0];
const ZOE_DM = 'fake:dm:5678';
const iso = (at: number): string => new Date(at).toISOString();

/**
 * The stored vector of a line, as the index keeps one: int8 bytes with their scale and norm, linked to the line's row.
 * Its `item_id` is another message id than the line's own, as an older index wrote it, so only the link finds the line.
 */
function addVector(world: World, line: string, at: number, vector: ReadonlyArray<number>): void {
  const { bytes, scale, norm } = quantize(vector);
  const row = world.db.prepare('SELECT rowid FROM sources WHERE id = ?').get(line);
  world.db
    .prepare(
      `INSERT INTO vectors (source_rowid, item_id, chunk_key, model, dims, scale, norm, bytes, occurred_at, kind, place_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'record', 'fake:server:g1')`
    )
    .run(
      Number(row?.rowid),
      `other-${line}`,
      `record:${line}:1`,
      MODEL,
      vector.length,
      scale,
      norm,
      new Uint8Array(bytes.buffer),
      iso(at)
    );
}

/** A line of hers written by `turn` (none for a line older than the turns that keep one), with its vector when given. */
function ownLine(
  world: World,
  id: string,
  place: string,
  ago: number,
  turn: string | null,
  vector?: ReadonlyArray<number>
) {
  const iface = place.split(':')[0] ?? 'fake';
  addLine(world.db, { id, iface, place, author: 'self', text: `ΓΡΑΜΜΗ-${id}`, at: iso(TURN_NOW - ago), turn });
  if (vector) addVector(world, id, TURN_NOW - ago, vector);
}

/** An intention record as the store keeps it. */
const intention = (id: string, status: string, ago: number) => ({
  id,
  purpose: `ΣΚΟΠΟΣ-${id}`,
  status,
  createdAt: TURN_NOW - ago,
  updatedAt: TURN_NOW - ago,
  provenance: { kind: 'self', turnId: null, scope: 'group' },
});

/** A finished wake run that carried `intentionId`. */
function run(world: World, id: string, intentionId: string, ago: number): void {
  startRun(world.handle, {
    id,
    kind: 'intention_due',
    startedAt: TURN_NOW - ago,
    inputs: { wakes: [], intentions: [{ id: intentionId, updatedAt: null }], facts: [], placeId: null },
  });
  finishRun(world.handle, { id, status: 'succeeded', outcome: 'spoke', finishedAt: TURN_NOW - ago + 60_000 });
}

/** The world of the tests: her lines near and far, a line of Ελένη's near, three intentions for one thing and one for another. */
function pastWorld(): World {
  const world = serviceWorld();
  ownLine(world, 'p1', GARDEN, 30 * DAY, 'turn:a', NEAR);
  addLine(world.db, {
    id: 'p2',
    iface: 'fake',
    place: GARDEN,
    author: 'fake:111',
    text: 'ΑΠΑΝΤΗΣΗ-ΤΗΣ-ΕΛΕΝΗΣ',
    at: iso(TURN_NOW - 30 * DAY + 2 * HOUR),
  });
  world.db.prepare("UPDATE sources SET reply_to = 'p1' WHERE id = 'p2'").run();
  addVector(world, 'p2', TURN_NOW - 30 * DAY + 2 * HOUR, NEAR);
  addLine(world.db, {
    id: 'p2b',
    iface: 'fake',
    place: GARDEN,
    author: 'fake:5678',
    text: 'ΑΣΧΕΤΗ-ΓΡΑΜΜΗ',
    at: iso(TURN_NOW - 30 * DAY + 3 * HOUR),
  });
  ownLine(world, 'p5', ROOM, 60 * DAY, null, NEAR);
  ownLine(world, 'p3', ROOM, 20 * DAY, 'turn:b', FAR);
  ownLine(world, 'p4', HARBOUR, 10 * DAY, 'turn:c', NEAR);
  writeIntentions(world.db, { op: 'value', intentions: [intention('i3', 'pending', 2 * DAY)] }, iso(TURN_NOW));
  writeIntentions(
    world.db,
    {
      op: 'archive',
      records: [
        intention('i5', 'done', 9 * DAY),
        intention('i6', 'done', 8 * DAY),
        intention('i7', 'done', 7 * DAY),
        intention('i1', 'done', 6 * DAY),
        intention('i2', 'cancelled', 4 * DAY),
        intention('i4', 'done', 5 * DAY),
      ],
    },
    iso(TURN_NOW)
  );
  run(world, 'turn:r1', 'i1', 5 * DAY);
  ownLine(world, 'r1-line', ROOM, 5 * DAY, 'turn:r1');
  run(world, 'turn:r2', 'i2', 3 * DAY);
  ownLine(world, 'p6', HARBOUR, 12 * DAY, 'turn:d', BETWEEN);
  // A run that wrote in Ζωή's direct chat, answered a day and a half later, and one that wrote in the garden, the same.
  run(world, 'turn:r5', 'i5', 8 * DAY);
  addLine(world.db, {
    id: 'r5-line',
    iface: 'fake',
    place: ZOE_DM,
    author: 'self',
    text: 'ΓΡΑΜΜΗ-r5',
    at: iso(TURN_NOW - 8 * DAY),
    turn: 'turn:r5',
    audience: { dm: ZOE_DM, iface: 'fake', person: 'person:fake:5678' },
  });
  answer(world, 'r5-answer', ZOE_DM, 'r5-line', TURN_NOW - 8 * DAY + 36 * HOUR);
  run(world, 'turn:r6', 'i6', 7 * DAY);
  ownLine(world, 'r6-line', GARDEN, 7 * DAY, 'turn:r6');
  answer(world, 'r6-answer', GARDEN, 'r6-line', TURN_NOW - 7 * DAY + 36 * HOUR);
  return world;
}

/** A line of Ζωή's in `place` at `at` that answers the line `to`. */
function answer(world: World, id: string, place: string, to: string, at: number): void {
  const dm = place === ZOE_DM;
  addLine(world.db, {
    id,
    iface: 'fake',
    place,
    author: 'fake:5678',
    text: `ΑΠΑΝΤΗΣΗ-${id}`,
    at: iso(at),
    ...(dm ? { audience: { dm: ZOE_DM, iface: 'fake', person: 'person:fake:5678' } } : {}),
  });
  world.db.prepare('UPDATE sources SET reply_to = ? WHERE id = ?').run(to, id);
}

/** The acts near `vector` with the given scores of her intentions. */
function actsOf(world: World, scores: Record<string, number>): Array<PastAct> {
  return pastActsOf(world.db, {
    vector: NEAR,
    model: MODEL,
    intentionScores: new Map(Object.entries(scores)),
    nearIntention: 0.65,
    nearLine: 0.7,
    limit: 10,
    now: TURN_NOW,
  });
}

test('her near line comes with how many lines people wrote in its place within a day after it and how many answer it', () => {
  // Bug: the record reads her line and nothing of what followed, or counts a busy chat's every line as an answer.
  const world = pastWorld();
  try {
    const acts = actsOf(world, {});
    const answered = acts.find((one) => one.kind === 'line' && one.id === 'p1');
    const quiet = acts.find((one) => one.kind === 'line' && one.id === 'p4');
    assert.ok(answered?.kind === 'line' && quiet?.kind === 'line', JSON.stringify(acts));
    assert.deepEqual(answered.after, { lines: 2, people: 2, answers: 1, direct: false });
    assert.equal(answered.placeId, GARDEN);
    assert.deepEqual(quiet.after, { lines: 0, people: 0, answers: 0, direct: false });
  } finally {
    world.close();
  }
});

test('a near line of hers with no turn and a vector under another message id is an item', () => {
  // Bug: her lines are read by their turn and their vectors by message id, so a post older than the turns is invisible.
  const world = pastWorld();
  try {
    const ids = actsOf(world, {}).map((one) => one.id);
    assert.ok(ids.includes('p5'), ids.join(' '));
  } finally {
    world.close();
  }
});

test('a near line of another person and a far line of hers are never items', () => {
  // Bug: the vector search reads every stored line, so Ελένη's answer stands in her record as an act of hers.
  const world = pastWorld();
  try {
    const ids = actsOf(world, {}).map((one) => one.id);
    assert.ok(!ids.includes('p2'), ids.join(' '));
    assert.ok(!ids.includes('p3'), ids.join(' '));
  } finally {
    world.close();
  }
});

test('three intentions for one thing come as three, each with the state the store holds', () => {
  // Bug: only the nearest intention is kept, and a burst of three for one thing reads as one.
  const world = pastWorld();
  try {
    const states = actsOf(world, { i1: 0.9, i2: 0.8, i3: 0.7, i4: 0.1 })
      .filter((one) => one.kind === 'intention')
      .map((one) => (one.kind === 'intention' ? `${one.id}:${one.status}` : ''));
    assert.deepEqual(states, ['i1:done', 'i2:cancelled', 'i3:pending']);
  } finally {
    world.close();
  }
});

test('an intention whose turn sent a line says where, and one whose turn sent nothing says so', () => {
  // Bug: a done intention reads as delivered although its turn sent nothing, and a sent one shows no place.
  const world = pastWorld();
  try {
    const acts = actsOf(world, { i1: 0.9, i2: 0.8, i3: 0.7 });
    const runsOf = (id: string) => {
      const found = acts.find((one) => one.kind === 'intention' && one.id === id);
      return found?.kind === 'intention' ? found.runs : null;
    };
    assert.deepEqual(
      runsOf('i1')?.map((one) => ({ sent: one.sent, places: one.placeIds })),
      [{ sent: 1, places: [ROOM] }]
    );
    assert.deepEqual(
      runsOf('i2')?.map((one) => one.sent),
      [0]
    );
    assert.deepEqual(runsOf('i3'), []);
  } finally {
    world.close();
  }
});

test('her intentions are read newest first, open and archived together, up to the window', () => {
  // Bug: the window reads only the open list, so a closed burst of the last days is never compared.
  const world = pastWorld();
  try {
    assert.deepEqual(
      ownIntentionsOf(world.db, 3).map((one) => one.id),
      ['i3', 'i2', 'i4']
    );
  } finally {
    world.close();
  }
});

test('an intention at a score between the two limits is an act, and a line at that score is none', () => {
  // Bug: one limit serves both kinds, so a repeat found by an intention is missed or new work near a line is noticed.
  const world = pastWorld();
  try {
    const ids = actsOf(world, { i7: 0.67 }).map((one) => one.id);
    assert.ok(ids.includes('i7'), ids.join(' '));
    assert.ok(!ids.includes('p6'), ids.join(' '));
  } finally {
    world.close();
  }
});

/** What followed each run of intention `id` among the acts. */
function followOf(world: World, id: string) {
  const found = actsOf(world, { [id]: 0.9 }).find((one) => one.kind === 'intention' && one.id === id);
  return found?.kind === 'intention' ? found.runs.map((one) => one.after) : null;
}

test('a run that wrote in a direct chat reports a line that answered it a day and a half later', () => {
  // Bug: a direct chat is counted within a day, so a person who answered two days later reads as silent.
  const world = pastWorld();
  try {
    assert.deepEqual(followOf(world, 'i5'), [{ lines: 1, people: 1, answers: 1, direct: true }]);
  } finally {
    world.close();
  }
});

test('a run that wrote in a group chat reports no line within the day and the one answer that came later', () => {
  // Bug: an answer after the day is lost in a group chat, or every later line of a busy room is counted.
  const world = pastWorld();
  try {
    assert.deepEqual(followOf(world, 'i6'), [{ lines: 0, people: 0, answers: 1, direct: false }]);
  } finally {
    world.close();
  }
});

test('a run that sent no line reports nothing after it', () => {
  // Bug: a run that sent nothing is given what people wrote somewhere, as if it had been answered.
  const world = pastWorld();
  try {
    assert.deepEqual(followOf(world, 'i2'), [null]);
  } finally {
    world.close();
  }
});
