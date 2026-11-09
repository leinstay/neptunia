// The key the owner's status card reads statistics with: the management key (the account's balance and each key's
// activity). While `keys.json` exists it is the store's extra key `management`, and `.env` has no say; without the
// store it is `OPENROUTER_MANAGEMENT_KEY`. Read at the moment of the card by src/core.ts. A store that cannot be read
// gives no key rather than an error, so the card still renders. Nothing here logs or returns a key anywhere but to its
// caller.

import { keysFileExists } from './store.ts';
import { readKeys } from './file.ts';

export type CardKeys = { managementKey: string | null };

/** The name of the extra key the status card reads the account's balance with. */
const MANAGEMENT_KEY = 'management';

const filled = (value: string | undefined): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

export function statusCardKeys(privateDir: string, env: Readonly<Record<string, string | undefined>>): CardKeys {
  if (!keysFileExists(privateDir)) return { managementKey: filled(env.OPENROUTER_MANAGEMENT_KEY) };
  try {
    const { extra } = readKeys(privateDir);
    return { managementKey: Object.hasOwn(extra, MANAGEMENT_KEY) ? filled(extra[MANAGEMENT_KEY]) : null };
  } catch {
    // An unreadable keys.json is the commands' to report; the card renders without the statistics.
    return { managementKey: null };
  }
}
