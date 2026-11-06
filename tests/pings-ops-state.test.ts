// `pings.get` and `pings.set` (src/tools/impl/pings.ts): the caller's own state, `on`, `off` or default. `pings.set`
// takes the mode `on`, `off` or `clear` (back to default, where the interface switch decides). The store is a fake that
// keeps the state the way `getPings` and `setPings` of src/memory/store.ts hand it out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/tools/impl/pings.ts';
import { getOp } from '../src/tools/impl/registry.ts';
import type { Env } from '../src/tools/impl/env.ts';

type State = 'on' | 'off' | null;

function rig() {
  const kept = new Map<string, State>();
  const key = (placeId: string, accountId: string) => `${placeId}:${accountId}`;
  const store = {
    getPings: (placeId: string, accountId: string): State => kept.get(key(placeId, accountId)) ?? null,
    setPings: (placeId: string, accountId: string, state: State): State => {
      if (state === null) kept.delete(key(placeId, accountId));
      else kept.set(key(placeId, accountId), state);
      return state;
    },
  };
  const env = {
    store,
    freshenIfPaused: () => {},
    requirePlaceId: (context: { placeId?: string | null }) => context.placeId ?? '',
  } as unknown as Env;
  // A throw of the operation becomes a rejection, whether it threw at once or later.
  const run = (op: string, args: Record<string, unknown>, accountId = '999'): Promise<unknown> =>
    new Promise((resolve) => {
      const found = getOp(op);
      assert.ok(found, op);
      resolve(found.run(args, { env, placeId: 'g1', accountId }));
    });
  return { kept, run };
}

test('pings.get with nothing set says default, and a member who never chose is not shown as on', async () => {
  // Bug: an unset member is shown as `on`, and they believe the interface switch cannot silence them.
  const { run } = rig();
  assert.equal(await run('pings.get', {}), 'Pings: default');
});

test('pings.set takes on, off and clear for the caller, each replacing the last', async () => {
  // Bug: `on` is dropped as the same as `clear`, or there is no way back to default after a choice.
  const { kept, run } = rig();
  assert.equal(await run('pings.set', { mode: 'on' }), 'Pings: on');
  assert.equal(kept.get('g1:999'), 'on');
  assert.equal(await run('pings.get', {}), 'Pings: on');
  assert.equal(await run('pings.set', { mode: 'off' }), 'Pings: off');
  assert.equal(kept.get('g1:999'), 'off');
  assert.equal(await run('pings.set', { mode: 'clear' }), 'Pings: default');
  assert.equal(kept.has('g1:999'), false);
});

test('pings.set changes only the caller', async () => {
  // Bug: the state is written under a shared key, and one member's `on` turns pings on for the place.
  const { kept, run } = rig();
  await run('pings.set', { mode: 'on' }, '999');
  assert.equal(await run('pings.get', {}, '777'), 'Pings: default');
  assert.deepEqual([...kept.keys()], ['g1:999']);
});

test('pings.set refuses an unknown mode and writes nothing', async () => {
  // Bug: a mode that is none of the three is written as a state, and the sender reads it as off.
  const { kept, run } = rig();
  await assert.rejects(() => run('pings.set', { mode: 'maybe' }), /mode must be one of: on, off, clear/);
  assert.equal(kept.size, 0);
});
