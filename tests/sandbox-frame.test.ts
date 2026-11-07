// Tests for src/behavior/sandbox-frame.ts: the frame a replayed reply carries on the `new` arm of `--frame`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayFrame, type ReplayTurn } from '../src/behavior/sandbox-frame.ts';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

/** A replayed mention in channel `c1`, its memory holding no place tree unless `memory` gives one. */
function turn(memory: ReplayTurn['memory'] = {}): ReplayTurn {
  return {
    memory,
    channel: { id: 'c1', name: 'café', iface: 'discord' },
    trigger: { id: 'm1', authorId: 'u1', authorName: 'Zoé' },
    mode: 'reply',
    triggerKind: 'mention',
    now: NOW,
    timezone: 'UTC',
  };
}

test('the old arm builds no frame, so a replay without --frame keeps the request it always had', () => {
  // Bug: the default arm carries a frame and the two arms of a comparison render the same request.
  assert.deepEqual(replayFrame('old', turn()), { frame: null, whereabouts: null });
  assert.deepEqual(replayFrame(undefined, turn()), { frame: null, whereabouts: null });
});

test('the new arm places the reply in the stored chain of the channel, with the author as the counterpart', () => {
  // Bug: the replay builds the frame for the channel id alone, so <spatial_awareness> names a place the live turn does not.
  const chain = [
    { id: 'p-c1', kind: 'channel', name: 'café' },
    { id: 'p-root', kind: 'root', name: 'Ágora' },
  ];
  const { frame, whereabouts } = replayFrame(
    'new',
    turn({
      placeOfConversation: () => 'p-c1',
      placeChainOf: (id) => (id === 'p-c1' ? chain : []),
      accountOf: () => 'a-u1',
      personOfAccount: () => 'person-1',
    })
  );
  assert.equal(frame?.place?.id, 'p-c1');
  assert.equal(frame?.root?.id, 'p-root');
  assert.deepEqual(frame?.counterpart, { personId: 'person-1', accountId: 'a-u1', name: 'Zoé' });
  assert.equal(whereabouts?.kind, 'place');
});

test('the new arm falls back to the channel by its name when the view holds no tree', () => {
  // Bug: a snapshot without places gives a frame with no place, and the place check fails on every turn.
  const { frame } = replayFrame('new', turn());
  assert.equal(frame?.place?.id, 'c1');
  assert.equal(frame?.place?.name, 'café');
});
