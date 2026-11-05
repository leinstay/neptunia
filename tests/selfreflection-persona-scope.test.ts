// The diary tick (the selfreflection mechanism) with no home community: making an entry needs no server, and where the entry
// is delivered is the mirror's own record.
// Contract, plan 2026-11-04-cli-and-memory task 5: `createSelfreflection` takes no `getGuildId`; plans and posts are one persona
// collection (`store.getSelfreflection()`, `store.setSelfreflectionPosts(posts, opts)`); a turn request carries `selfreflection` and no `guildId`.
// Appendix entries: src/behavior/selfreflection.ts, src/behavior/selfreflection-turn.ts, src/turn/selfreflection.ts, src/memory/db/selfreflection-audience.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSelfreflection } from '../src/behavior/selfreflection.ts';
import type { SelfreflectionDeps } from '../src/behavior/selfreflection.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { useIface, world } from './fixtures/turn-world.ts';

useIface('fake');

const NOW = Date.parse('2026-11-05T12:00:00Z');

function rig(): { selfreflection: ReturnType<typeof createSelfreflection>; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const deps = {
    hot: { config: { bot: { timezone: 'UTC' }, selfreflection: { enabled: true } }, prompts: { labels: {} } },
    store: {
      state: { data: {}, markDirty() {} },
      getSelfreflection: () => ({ posts: [], updatedAt: 0 }),
      readMemory: () => [],
    },
    reads: world().reads,
    iface: () => 'fake',
    turns: {
      isAnyBusy: () => false,
      runTurn: (params: Record<string, unknown>) => {
        calls.push(params);
        return Promise.resolve({
          outcome: 'spoke',
          selfreflection: { kind: 'status', picture: false, search: false, messages: 1 },
        });
      },
    },
    rng: () => 0.5,
    now: () => NOW,
  };
  return { selfreflection: createSelfreflection(wrongly<SelfreflectionDeps>(deps)), calls };
}

test('a forced entry runs on a core with no community', async () => {
  // Bug: `force` answers `no-guild`, so a persona with only DMs never reflects.
  const { selfreflection, calls } = rig();
  const answer = (await selfreflection.force({ kind: 'status' })) as { outcome?: string; reason?: string };
  assert.notEqual(answer.reason, 'no-guild');
  assert.equal(calls.length, 1);
});

test('the turn of an entry names no community', async () => {
  // Bug: the entry's turn keeps memory and audience under the server that happened to be the home one.
  const { selfreflection, calls } = rig();
  await selfreflection.force({ kind: 'status' });
  assert.equal('guildId' in (calls[0] ?? {}), false);
});

test('the status reads the plan of the one persona', () => {
  // Bug: `status` keys the plan by community, so with none it reports no history for a persona that has posts.
  const { selfreflection } = rig();
  assert.equal(selfreflection.status().history, 0);
  assert.deepEqual(selfreflection.status().slots, []);
});
