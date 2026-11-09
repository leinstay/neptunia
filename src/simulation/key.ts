// The simulation's switch, its one key reader and the key ring of a paid script. The simulation is the paid scripts of
// scripts/ (the replay, the recall evaluation, the memory session): they spend a named `extra` key of keys.json and
// nothing else, and refuse with one line while the simulation is off. `simulation enable --key <name>` names the key in
// `llm.simulationKey` of config.json (src/subharness/routing.ts), `simulation disable` forgets it. The shape follows the
// other features of Hermes' tool configuration (hermes_cli/tools_config.py): the same result as the subharness, a state
// that is read at each use. Nothing here prints a key value.

import type { KeyRing, KeyRoute } from '../keys/ring.ts';
import type { SubharnessResult } from '../subharness/control.ts';
import { readRouting, updateRouting } from '../subharness/routing.ts';
import { hasExtraKey, readKeys } from '../keys/file.ts';

/** The simulation as config.json holds it: whether it is on, and the name of its key. */
export function simulationStatus(privateDir: string): { on: boolean; key: string | null } {
  const { key } = readRouting(privateDir).simulation;
  return { on: key !== null, key };
}

/** Switches the simulation on with the extra key `name`. A name that is no extra key, a core key's included, is refused. */
export function enableSimulation(privateDir: string, name: string): SubharnessResult {
  const store = readKeys(privateDir);
  if (!hasExtraKey(store, name))
    return {
      ok: false,
      code: 'key-unknown',
      changed: false,
      message: `${name} is no extra key; the simulation never spends a core key`,
    };
  if (readRouting(privateDir).simulation.key === name)
    return { ok: true, code: 'ok', changed: false, message: `the simulation is on with key ${name} already` };
  updateRouting(privateDir, (routing) => ({ ...routing, simulation: { key: name } }));
  return { ok: true, code: 'ok', changed: true, message: `the simulation is on with key ${name}` };
}

/** Switches the simulation off. */
export function disableSimulation(privateDir: string): SubharnessResult {
  if (readRouting(privateDir).simulation.key === null)
    return { ok: true, code: 'ok', changed: false, message: 'the simulation is off already' };
  updateRouting(privateDir, (routing) => ({ ...routing, simulation: { key: null } }));
  return { ok: true, code: 'ok', changed: true, message: 'the simulation is off; the paid scripts refuse to run' };
}

/** The refusal of a paid script: one line, the code `simulation-off`, never a value. */
function refusal(message: string): Error {
  return Object.assign(new Error(message), { code: 'simulation-off' });
}

/**
 * The simulation's key by name and value, for a paid script. Throws an error with the code `simulation-off` and one line
 * that names `simulation enable` while the simulation is off or its key has left the store.
 */
export function simulationRoute(privateDir: string): KeyRoute {
  const { key } = readRouting(privateDir).simulation;
  const store = readKeys(privateDir);
  if (key === null) throw refusal('the simulation is off: switch it on with "simulation enable --key <name>"');
  if (!hasExtraKey(store, key))
    throw refusal(`the simulation key ${key} is not in the store: name another with "simulation enable --key <name>"`);
  return { name: key, value: store.extra[key] ?? '' };
}

/** The value of the simulation's key (`simulationRoute`), for a script that sends it itself. */
export function simulationKey(privateDir: string): string {
  return simulationRoute(privateDir).value;
}

/**
 * The key ring of a paid script: every role goes out on the simulation key `route` and on nothing else, so neither a
 * binding of `llm.boundKeys` nor a core key is ever spent. A budget error has no key to move to.
 */
export function simulationRing(route: KeyRoute): KeyRing {
  return {
    route: () => route,
    names: () => [route.name],
    failed: () => null,
    states: () => [],
    bound: () => [],
    grants: () => ({}),
    variables: () => ({}),
  };
}
