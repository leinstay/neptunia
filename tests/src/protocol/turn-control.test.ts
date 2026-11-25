// Tests for src/protocol/turn-control.ts: the wire reader of the turn events and actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTurnAction, readTurnEvent } from '../../../src/protocol/turn-control.ts';

test('the wire reader refuses an event or action without its turn id, and an unknown kind', () => {
  // Bug: a malformed acknowledgement reads as the cancel of whatever turn runs now.
  const event = { type: 'cancelled', turnId: 't1', seq: 4, at: 1000 };
  assert.deepEqual(readTurnEvent(event), { ok: true, event });
  assert.equal(readTurnEvent({ type: 'cancelled', seq: 4, at: 1000 }).ok, false);
  assert.equal(readTurnEvent({ type: 'cancelled', turnId: 't1', at: 1000 }).ok, false);
  assert.equal(readTurnEvent({ type: 'other', turnId: 't1', seq: 1, at: 1000 }).ok, false);
  assert.equal(readTurnEvent(null).ok, false);
  const action = { kind: 'turn.cancel', turnId: 't1' };
  assert.deepEqual(readTurnAction(action), { ok: true, action });
  assert.equal(readTurnAction({ kind: 'turn.cancel' }).ok, false);
  assert.equal(readTurnAction({ kind: 'errand.cancel', turnId: 't1' }).ok, false);
});
