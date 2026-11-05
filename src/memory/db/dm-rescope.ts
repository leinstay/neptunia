// One DM names one partner: when a DM place takes its partner person, every row of that place's audience takes it in
// `scope_dm`, so the rows before the link and after it read as one DM. The audience of a row never changes here: a line, a
// fact or a feeling stays in the conversation it came from. Used by observe.ts, identity-links.ts and
// scripts/memory-repair-audit.ts, inside their transactions.

import { dmAudienceId } from './scope.ts';
import { SCOPED_TABLES } from './schema.ts';
import type { Db } from './types.ts';

/** Sets `scope_dm` to `person` on the rows of a DM place's audience that name anything else. Returns how many changed. */
export function rescopeDmPlace(db: Db, place: string, person: string): number {
  let changed = 0;
  for (const table of SCOPED_TABLES)
    changed += Number(
      db
        .prepare(`UPDATE "${table}" SET scope_dm = ?1 WHERE audience_id = ?2 AND scope_dm IS NOT ?1`)
        .run(person, dmAudienceId(place)).changes
    );
  return changed;
}

/** `rescopeDmPlace` for each DM place whose partner account is `accountId`, to the partner person the place names. */
export function rescopeDmPlacesOfAccount(db: Db, accountId: string): number {
  let changed = 0;
  const places = db
    .prepare(
      `SELECT id, partner_person FROM places WHERE partner_account = ? AND partner_person IS NOT NULL
       AND (conversation = 'dm' OR kind = 'dm')`
    )
    .all(accountId);
  for (const place of places) changed += rescopeDmPlace(db, String(place.id), String(place.partner_person));
  return changed;
}
