// Tests for src/keys/ring.ts: the key ring read off the chains of routes, `chainRing` over a fake chain view whose
// chains, keys in force and switches the test sets. Names only: no value but a route's own reaches a reader.
// Changed: the ring of core keys with its failover is gone (spec 2026-11-09-model-routes, slice 4); the chain client
// switches routes, and the ring names what the chains give.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainRing } from '../src/keys/ring.ts';
import type { Route } from '../src/llm/route-text.ts';

const api = (key: string, model = 'x/model'): Route => ({ via: 'api', key, model, effort: null });
const harness: Route = { via: 'harness', backend: 'claude', model: 'claude-opus-4-6', effort: null };

/** A chain view over fixed chains, the key in force of each role and the switches the chain recorded. */
function view(
  chains: Record<string, Array<Route>>,
  inForce: Record<string, string> = {},
  states: Array<{ role: string; route: string; switchedAt: number }> = []
) {
  return {
    routes: (role: string): Array<Route> => chains[role] ?? [],
    keyRouteOf: (role: string) => {
      const name = inForce[role];
      return name === undefined ? null : { name, value: `value-of-${name}` };
    },
    states: () => states,
  };
}

test('route gives the key of the route in force, and null for a role on no key', () => {
  // Catches: the ring reading the first key of the file instead of the role's route, so a check spends the wrong key.
  const ring = chainRing(view({ analyzer: [api('helpers')] }, { analyzer: 'helpers' }));
  assert.deepEqual(ring.route('analyzer'), { name: 'helpers', value: 'value-of-helpers' });
  assert.equal(ring.route('core'), null);
});

test('names lists the keys a chain names once each, in order, and none for a harness route', () => {
  // Catches: a harness route counted as a key, or a key named twice, so the status card reads one key twice.
  const ring = chainRing(view({ core: [harness, api('main'), api('spare'), api('main', 'y/other')] }));
  assert.deepEqual(ring.names('core'), ['main', 'spare']);
  assert.deepEqual(ring.names('nobody'), []);
});

test('states names the key of a role that switched to a later route on a key, and skips a switch to a harness', () => {
  // Catches: a switch shown under its route text, so the status card prints a model where it names a key.
  const ring = chainRing(
    view({}, {}, [
      { role: 'analyzer', route: 'spare/x/model', switchedAt: 5 },
      { role: 'core', route: 'harness:claude/claude-opus-4-6', switchedAt: 6 },
    ])
  );
  assert.deepEqual(ring.states(), [{ role: 'analyzer', key: 'spare', switchedAt: 5 }]);
});

test("bound groups the roles by the key they are on now, leaving out the core and the core's own key", () => {
  // Catches: the core's key listed again as a role key, so its balance is read and shown twice.
  const ring = chainRing(
    view({}, { core: 'main', analyzer: 'helpers', vision: 'helpers', embedding: 'main', search: 'tools' })
  );
  assert.deepEqual(ring.bound(), [
    { name: 'helpers', roles: ['analyzer', 'vision'] },
    { name: 'tools', roles: ['search'] },
  ]);
});
