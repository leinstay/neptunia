// Who memory knows (src/memory/db/known-people.ts), read on a memory database built with the real schema
// (tests/fixtures/service-turn.ts): the people a heartbeat lists and the only people she may open a direct chat with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { knownPersonIds, knownPersonOf } from '../src/memory/db/known-people.ts';
import { NIKOS, heartbeatWorld } from './fixtures/service-turn.ts';

test('leaves out a person memory holds nothing about, though a direct chat with them is stored', () => {
  // Bug: every person with an account counts as known, and she opens a direct chat with a stranger.
  const world = heartbeatWorld();
  try {
    const ids = knownPersonIds(world.db);
    assert.ok(ids.includes(NIKOS), ids.join(' '));
    assert.ok(!ids.includes('person:fake:5678'), ids.join(' '));
  } finally {
    world.close();
  }
});

test('answers null for a known person whose only account is a bot', () => {
  // Bug: the account's kind is not read, and a bot she holds a description of is a person to write to.
  const world = heartbeatWorld();
  try {
    assert.deepEqual(
      knownPersonOf(world.db, NIKOS)?.accounts.map((one) => one.id),
      ['fake:222']
    );
    world.db.prepare("UPDATE accounts SET kind = 'bot' WHERE id = 'fake:222'").run();
    assert.equal(knownPersonOf(world.db, NIKOS), null);
  } finally {
    world.close();
  }
});
