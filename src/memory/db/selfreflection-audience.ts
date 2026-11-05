// The audience of a selfreflection entry over the memory database: the places she can name (`publicationPlaces`, what the writer
// request shows and what her `<audience>` is checked against) and whether a stored entry may reach a place
// (`audienceRefusal`, reached through publish.ts#storedSelfreflectionPublicationRefusal at queue time and right before a send).
//
// Places are compared by their interface-qualified id, so the same native id on two interfaces stays two places. A place
// audience covers the place and its descendants through `parent_id`. The audience only narrows what trusted restrictions
// allow: an entry that is neither group material nor under a saved boundary reaches nothing, whatever it names.
//
// A row with no `publicationAudience` predates the audience and stays as it is: an old group entry stays on its own
// `scope_iface`, and anything with no interface or a private scope reaches nothing. Pure reads. Logs: none.

import { selfreflectionMetadataOf, isPublicationAudience, refusedAudience } from '../../tools/publication.ts';
import type { KnownPlaces, PublicationAudience } from '../../tools/publication.ts';
import type { Db, Row } from './types.ts';

export const NO_PLACES: KnownPlaces = { interfaces: [], places: [] };

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** The group places memory knows, by interface and id, and their interfaces. A private conversation is none of them. */
export function publicationPlaces(connection: unknown): KnownPlaces {
  const db = connection as Db; // a node:sqlite connection; the query below reads it
  const rows = db
    .prepare(
      `SELECT id, iface, name, parent_id FROM places
        WHERE scope_kind = 'group' AND kind <> 'dm' AND retired_at IS NULL AND iface IS NOT NULL AND iface <> ''
        ORDER BY iface, id`
    )
    .all();
  return {
    interfaces: [...new Set(rows.map((row) => String(row.iface)))],
    places: rows.map((row) => ({
      id: String(row.id),
      name: textOrNull(row.name),
      parentId: textOrNull(row.parent_id),
    })),
  };
}

/** The entries whose audience could not be read, oldest first, each with why: blocked on every mirror. */
export function refusedEntries(db: Db): Array<{ entryId: string; reason: string }> {
  return db
    .prepare(
      `SELECT id, extra FROM selfreflection WHERE retired_at IS NULL AND extra LIKE '%publicationAudience%'
        ORDER BY at_ms, COALESCE(position, 0), id`
    )
    .all()
    .flatMap((row) => {
      const refused = refusedAudience(selfreflectionMetadataOf(row.extra).publicationAudience);
      return refused ? [{ entryId: String(row.id), reason: refused.reason }] : [];
    });
}

/** Whether `audience` covers the place `placeId`. */
function covers(db: Db, audience: PublicationAudience, placeId: string): boolean {
  if (audience.kind === 'unrestricted') return true;
  const place = db.prepare('SELECT iface, parent_id FROM places WHERE id = ?');
  if (audience.kind === 'interface') return place.get(placeId)?.iface === audience.iface;
  const walked = new Set<string>();
  for (let at: string | null = placeId; at !== null && !walked.has(at); at = textOrNull(place.get(at)?.parent_id)) {
    if (at === audience.placeId) return true;
    walked.add(at);
  }
  return false;
}

/**
 * What a stored entry's audience says against reaching `placeId`, after its saved boundary let the place through:
 * `audience-excluded`, `audience-invalid` for a stored value that cannot be read, or null when it may go. A row that is
 * not there says nothing: the selfreflection service publishes an entry only after its row settled (src/behavior/selfreflection.ts).
 */
export function audienceRefusal(
  db: Db,
  row: Row | undefined,
  placeId: string
): 'audience-excluded' | 'audience-invalid' | null {
  // The live path publishes after `flushSettled`, so a row that is not there is no entry of hers to hold back.
  if (!row) return null;
  const metadata = selfreflectionMetadataOf(row.extra);
  const bounded = metadata.publicationBoundary !== undefined;
  if (!bounded && row.scope_kind !== 'group') return 'audience-excluded';
  const audience = metadata.publicationAudience;
  if (audience !== undefined)
    return !isPublicationAudience(audience)
      ? 'audience-invalid'
      : covers(db, audience, placeId)
        ? null
        : 'audience-excluded';
  if (bounded) return null;
  const iface = db.prepare('SELECT iface FROM places WHERE id = ?').get(placeId)?.iface;
  return textOrNull(row.scope_iface) !== null && row.scope_iface === iface ? null : 'audience-excluded';
}
