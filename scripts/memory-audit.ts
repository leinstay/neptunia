// A read-only consistency audit of the memory database, counts only: every line's place exists, its scope kind matches its
// place, its audience is the one its scope derives, every media link points at a live row, no row sits in `aud:none` without a
// reason. `auditMemory` holds the checks; the command prints the counts and exits non-zero on a finding.
//
//   node scripts/memory-audit.ts --db <file>

import { DatabaseSync } from 'node:sqlite';
import { dmAudienceId, groupAudienceId } from '../src/memory/db/scope.ts';
import type { Db, Row } from '../src/memory/db/types.ts';

/** What the audit found, by check. Zero is clean. */
export type AuditFindings = {
  sourceWithoutPlace: number;
  scopeKindMismatch: number;
  audienceMismatch: number;
  audienceNone: number;
  linkToMissingMedia: number;
  linkFromMissingOwner: number;
  linkedMediaRetired: number;
};

/** The audience a source row's scope derives, when its scope alone says it. */
function derivedAudience(row: Row): string | null {
  if (row.scope_kind === 'group') return groupAudienceId(row.scope_iface);
  if (row.scope_kind === 'dm') return typeof row.place_id === 'string' ? dmAudienceId(row.place_id) : null;
  return null;
}

/** The kind of scope a place holds, in the words of a source row. */
const placeScope = (row: Row): string | null =>
  row.conversation === 'dm' ? 'dm' : row.conversation === 'group' ? 'group' : null;

const countOf = (db: Db, sql: string): number => Number(db.prepare(sql).get()?.n ?? 0);

/** The checks over an open connection. Reads only, and holds no content of any row. */
export function auditMemory(db: Db): { findings: AuditFindings } {
  let audienceMismatch = 0;
  let scopeKindMismatch = 0;
  const lines = db.prepare(
    `SELECT s.scope_kind AS scope_kind, s.scope_iface AS scope_iface, s.place_id AS place_id, s.audience_id AS audience_id,
       p.conversation AS conversation
     FROM sources s LEFT JOIN places p ON p.id = s.place_id
     WHERE s.kind IN ('seen', 'said') AND s.retired_at IS NULL`
  );
  for (const row of lines.iterate()) {
    const derived = derivedAudience(row);
    // `aud:none` has its own check; a person-scoped DM audience names its partner, which only its place can say.
    if (derived !== null && row.audience_id !== 'aud:none' && !String(row.audience_id).startsWith(derived.slice(0, 7)))
      audienceMismatch += 1;
    const scope = placeScope(row);
    if (scope !== null && scope !== row.scope_kind && row.scope_kind !== 'internal') scopeKindMismatch += 1;
  }
  return {
    findings: {
      sourceWithoutPlace: countOf(
        db,
        `SELECT COUNT(*) AS n FROM sources s WHERE s.place_id IS NOT NULL AND s.retired_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM places p WHERE p.id = s.place_id)`
      ),
      scopeKindMismatch,
      audienceMismatch,
      audienceNone: countOf(
        db,
        "SELECT COUNT(*) AS n FROM sources WHERE audience_id = 'aud:none' AND retired_at IS NULL"
      ),
      linkToMissingMedia: countOf(
        db,
        'SELECT COUNT(*) AS n FROM media_links l WHERE NOT EXISTS (SELECT 1 FROM media m WHERE m.id = l.media_id)'
      ),
      linkFromMissingOwner: countOf(
        db,
        `SELECT COUNT(*) AS n FROM media_links l WHERE
         (l.owner_kind = 'source' AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = l.owner_id))
         OR (l.owner_kind = 'diary' AND NOT EXISTS (SELECT 1 FROM diary d WHERE d.id = l.owner_id))`
      ),
      linkedMediaRetired: countOf(
        db,
        `SELECT COUNT(*) AS n FROM media_links l JOIN media m ON m.id = l.media_id WHERE m.retired_at IS NOT NULL
         AND (l.owner_kind <> 'source' OR EXISTS (SELECT 1 FROM sources s WHERE s.id = l.owner_id AND s.retired_at IS NULL))`
      ),
    },
  };
}

if (import.meta.main) {
  const at = process.argv.indexOf('--db');
  if (at < 0 || !process.argv[at + 1]) {
    process.stderr.write('usage: node scripts/memory-audit.ts --db <file>\n');
    process.exit(2);
  }
  const db = new DatabaseSync(process.argv[at + 1], { readOnly: true }) as unknown as Db;
  const { findings } = auditMemory(db);
  for (const [name, count] of Object.entries(findings)) process.stdout.write(`${name}: ${count}\n`);
  process.exit(Object.values(findings).some((count) => count > 0) ? 1 : 0);
}
