import test from 'node:test';
import assert from 'node:assert/strict';
import { reactionKey } from '../src/protocol/reaction-key.ts';

test('reactionKey reads a unicode emoji as itself', () => {
  assert.equal(reactionKey({ id: null, name: '🔥' }), '🔥');
});

test('reactionKey reads a custom emoji as its name between colons', () => {
  assert.equal(reactionKey({ id: '55', name: 'kek' }), ':kek:');
});

test('reactionKey gives null for an emoji without a name or none at all', () => {
  assert.equal(reactionKey({ id: '55', name: null }), null);
  assert.equal(reactionKey(null), null);
  assert.equal(reactionKey(undefined), null);
});
