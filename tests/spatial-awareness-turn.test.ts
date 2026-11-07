// Every turn of hers carries `<spatial_awareness>`: a reply in a channel, an inner turn that runs in a place, a
// heartbeat and a selfimprovement wake, over the real turn runner with a fake model. The store hands the turn its place
// chain through `placeChainOf(placeId)`, the store method over `placeChainInDb` (src/memory/db/place-tree.ts); the
// owner's notes come from `config.spatial.notes`. The labels are the fixture's markers. Synthetic names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatNow } from '../src/format.ts';
import { labels } from './fixtures/labels.ts';
import { NOW, coreTurn, fakeStore, requestText } from './fixtures/turn-harness.ts';
import { useIface } from './fixtures/turn-world.ts';
import { WAKE_NOW, requestText as wakeRequestText, wakeOfKind, wakeTurn } from './fixtures/wake-turn.ts';

useIface('fake');

const CHAIN = [
  { id: 'p-channel', kind: 'channel', name: 'general' },
  { id: 'p-server', kind: 'server', name: 'Example Server' },
];

/** The harness's store, which also answers the chain of any place it is asked about. */
function storeWithTree(asked: Array<string>) {
  return {
    ...fakeStore(),
    placeChainOf: (placeId: string) => {
      asked.push(placeId);
      return CHAIN;
    },
  };
}

/** The body of `<spatial_awareness>` in a request text, null when it has none. */
function spatialOf(text: string): string | null {
  const match = /<spatial_awareness>\n([\s\S]*?)\n<\/spatial_awareness>/.exec(text);
  return match ? (match[1] ?? null) : null;
}

// A category is no place, the owner's word of 2026-11-06, so no chain holds one.
test('a reply in a channel names the channel, its server, the interface, the time and the note', async () => {
  // Bug: the turn builds its request without asking where it is, so she never sees the block on a live reply.
  const asked: Array<string> = [];
  const run = await coreTurn({
    answers: ['<skip/>'],
    store: storeWithTree(asked),
    config: { spatial: { notes: { 'p-server': 'adults only' } } },
  });
  const body = spatialOf(requestText(run.llm, 0));
  assert.ok(asked.length > 0, 'the turn asked the store for its chain');
  assert.deepEqual(body?.split('\n'), [
    `SPATIAL-PLACE channel #general < server Example Server ON fake AT ${formatNow(NOW, 'UTC', labels.locale)}`,
    'SPATIAL-GROUP',
    'SPATIAL-NOTE adults only',
  ]);
});

test('an inner turn that runs in a channel names that place', async () => {
  const run = await coreTurn({
    answers: ['<skip/>'],
    store: storeWithTree([]),
    inner: {
      kind: 'intention_due',
      items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
      intentions: [{ id: 'i1', purpose: 'say hello', dueAt: NOW - 60_000 }],
      now: NOW,
      timezone: 'UTC',
      channels: [],
      budgets: { chain: { used: 0, cap: 3, left: 3 } },
    },
    config: { wakes: { mode: 'live', chatMessages: 2 } },
    prompts: { inner: 'Do what the wake says.' },
  });
  const body = spatialOf(requestText(run.llm, 0));
  assert.ok(body?.startsWith('SPATIAL-PLACE channel #general < server'), String(body));
});

for (const kind of ['heartbeat', 'selfimprovement']) {
  test(`a ${kind} wake says she is on her own server, with the time`, async () => {
    // Bug: her own time carries no block at all, or names the anchor channel the wake rode in on.
    // Stage AC, the owner's word of 2026-11-06: a wake with no conversation place is at the command line of her server.
    const run = await wakeTurn({ wake: wakeOfKind(kind, `${kind}:1`), answers: ['<skip/>'], board: null });
    const body = spatialOf(wakeRequestText(run.requests[0] ?? []));
    assert.equal(body, `SPATIAL-SERVER AT ${formatNow(WAKE_NOW, 'UTC', labels.locale)}`);
  });
}
