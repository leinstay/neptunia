import test from 'node:test';
import assert from 'node:assert/strict';
import { reactionKey } from '../../../src/protocol/reaction-key.ts';

test('reactionKey reads a unicode emoji as itself', () => {
  assert.equal(reactionKey({ id: null, name: '🔥' }), '🔥');
});

// An emoji and a sticker go by a stable name of the engine.
test('reactionKey reads a custom emoji as the protocol token of its id', () => {
  assert.equal(reactionKey({ id: '55', name: 'kek' }), '<emoji:55>');
});

test('reactionKey gives null for an emoji without a name or none at all', () => {
  assert.equal(reactionKey({ id: '55', name: null }), null);
  assert.equal(reactionKey(null), null);
  assert.equal(reactionKey(undefined), null);
});
