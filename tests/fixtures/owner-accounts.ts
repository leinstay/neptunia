// The owner check (src/tools/operations/grants.ts#isOwnerId) for a test with no memory database: `bot.ownerPerson`
// names OWNER_PERSON, and every platform id `ownedBy` was given is an account the owner bound to it, on any
// interface. A test file or fixture calls it once at module level; a core a test starts installs its own reader over
// its database for as long as it runs.
import { useOwnerAccounts } from '../../src/tools/operations/grants.ts';

export const OWNER_PERSON = 'person:0e0e0000-owner';

const owned = new Set<string>();

/** Adds `natives` to the owner's accounts and installs the reader over all of them; returns its removal. */
export function ownedBy(natives: ReadonlyArray<string | number>): () => void {
  for (const native of natives) owned.add(String(native));
  return useOwnerAccounts({ isBoundTo: (person, native) => person === OWNER_PERSON && owned.has(native) });
}
