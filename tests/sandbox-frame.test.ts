// Tests for src/behavior/sandbox-frame.ts: the frame a replayed reply carries.

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

test('a replayed reply is placed in the stored chain of the channel, with the author as the counterpart', () => {
  // Bug: the replay builds the frame for the channel id alone, so <spatial_awareness> names a place the live turn does not.
  const chain = [
    { id: 'p-c1', kind: 'channel', name: 'café' },
    { id: 'p-root', kind: 'root', name: 'Ágora' },
  ];
  // Slice 7: the replay's `--frame old` is gone, so every replayed turn is built on its frame and replayFrame takes
  // the turn alone.
  const { frame, whereabouts } = replayFrame(
    turn({
      placeOfChat: () => 'p-c1',
      placeChainOf: (id) => (id === 'p-c1' ? chain : []),
      accountOf: () => 'a-u1',
      personOfAccount: () => 'person-1',
    })
  );
  assert.equal(frame?.place?.id, 'p-c1');
  assert.equal(frame?.root?.id, 'p-root');
  // The counterpart carries the id the interface names them by (plan 2026-11-08 ids-by-links, slice 7b), so the request
  // reads it from the frame and never parses it out of the account id.
  assert.deepEqual(frame?.counterpart, { personId: 'person-1', accountId: 'a-u1', nativeId: 'u1', name: 'Zoé' });
  assert.equal(whereabouts?.kind, 'place');
});

test('a replayed turn falls back to the channel by its name when the view holds no tree', () => {
  // Bug: a snapshot without places gives a frame with no place, and the place check fails on every turn.
  const { frame } = replayFrame(turn());
  assert.equal(frame?.place?.id, 'c1');
  assert.equal(frame?.place?.name, 'café');
});
