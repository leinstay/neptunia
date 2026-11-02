// The two keys the owner's status card reads statistics with: the simulation's key (its spend) and the management key
// (the account's balance). While `keys.json` exists they are the store's, the extra key `simulation.key` names and the
// extra key `management`, and `.env` has no say; without the store they are `OPENROUTER_SIM_KEY` and
// `OPENROUTER_MANAGEMENT_KEY`. Read at the moment of the card by src/core.ts. A store that cannot be read gives no key
// rather than an error, so the card still renders. Nothing here logs or returns a key anywhere but to its caller.

import { keysFileExists } from './store.ts';
import { readKeys } from '../subharness/keys-file.ts';

export type CardKeys = { simKey: string | null; managementKey: string | null };

/** The name of the extra key the status card reads the account's balance with. */
const MANAGEMENT_KEY = 'management';

const filled = (value: string | undefined): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

export function statusCardKeys(privateDir: string, env: Readonly<Record<string, string | undefined>>): CardKeys {
  if (!keysFileExists(privateDir))
    return { simKey: filled(env.OPENROUTER_SIM_KEY), managementKey: filled(env.OPENROUTER_MANAGEMENT_KEY) };
  try {
    const store = readKeys(privateDir);
    const simName = store.simulation.key;
    const extraOf = (name: string | null): string | null =>
      name !== null && Object.hasOwn(store.extra, name) ? filled(store.extra[name]) : null;
    return { simKey: extraOf(simName), managementKey: extraOf(MANAGEMENT_KEY) };
  } catch {
    // An unreadable keys.json is the keys commands' to report; the card renders without the two statistics.
    return { simKey: null, managementKey: null };
  }
}
