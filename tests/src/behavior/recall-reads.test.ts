// src/behavior/recall-reads.ts: what the recall runner decides that needs none of its state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inRoot, hasRecallContext } from '../../../src/behavior/recall-reads.ts';
import { channel, privateChannel } from '../../fixtures/reads-rig.ts';

test('tells a chat of a root from a private chat', () => {
  assert.equal(inRoot(channel('c1')), true);
  assert.equal(inRoot({ ...privateChannel('c4', []), rootId: null }), false);
  assert.equal(inRoot(null), false);
});

test('a DM with a partner has a recall context with no root', () => {
  // Bug: `Boolean(rootId && ...)` turns recall off in every DM that has no root.
  assert.equal(
    hasRecallContext({
      channel: { id: 'd1', kind: 'dm', rootId: null },
      partnerId: 'u1',
      memoryContext: null,
    }),
    true
  );
});

test('a private chat with no partner still has none', () => {
  // Bug: removing the root check opens stored recall to a chat nobody can be authorized for.
  assert.equal(
    hasRecallContext({ channel: { id: 'd1', kind: 'dm', rootId: null }, partnerId: null, memoryContext: null }),
    false
  );
});
