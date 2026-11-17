// The people and the places a heartbeat lists (src/memory/db/heartbeat-lists.ts), read on a memory database built with
// the real schema (tests/fixtures/memory-db/mind-world.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heartbeatListsOf } from '../src/memory/db/heartbeat-lists.ts';
import { MIRROR, NIKOS, TURN_NOW, YARD, heartbeatWorld } from './fixtures/service-turn.ts';

test('reads every live chat, a group room and a direct chat, on the real schema of places', () => {
  // Bug: a scope clause names columns `places` does not have (`scope_iface`) and the read throws on a real database.
  const world = heartbeatWorld();
  try {
    const { people, places } = heartbeatListsOf(world.db, TURN_NOW);
    const ids = places.map((one) => one.placeId);
    assert.ok(ids.includes(YARD), ids.join(' '));
    assert.ok(ids.includes('fake:dm:5678'), ids.join(' '));
    assert.ok(!ids.includes(MIRROR), ids.join(' '));
    assert.ok(
      people.some((one) => one.personId === NIKOS),
      people.map((one) => one.personId).join(' ')
    );
  } finally {
    world.close();
  }
});
