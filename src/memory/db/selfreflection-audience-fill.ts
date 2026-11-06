// The owner's fill of the audience on old selfreflection entries (`/memory selfreflection audience fill [--dry-run]`, writer kind
// `selfreflection-audience-fill`). An entry written before she could choose an audience carries no `publicationAudience`.
// A row's own `kind` does not matter: it is the entry's kind, NULL or any value. By the owner's word the fill gives each such group entry the explicit `{ kind: 'unrestricted' }`, merged into its
// `extra` so every other key and a saved `publicationBoundary` stay. Left alone: an entry with any audience (chosen or
// invalid), a retired entry, an entry outside the group scope, and one whose `extra` cannot be read as an object.
// A second run finds nothing, and `dryRun` counts the same set without writing. Only the owner fills (`OWNER_ONLY`).
// Logs: none.

import { projectRow } from './graph.ts';
import { dbOf } from './types.ts';
import type { MemoryHandle, Row } from './types.ts';

/** The entry's metadata when it is readable as an object (an empty one for none), else null. */
function metadataOf(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined || raw === '') return {};
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Metadata that cannot be read may hold a restriction: the entry stays as it is.
  }
  return null;
}

/** The write of `applyMemoryWrite` kind `selfreflection-audience-fill`: `{ by, dryRun?, now? }`, one transaction. */
export function applySelfreflectionAudienceFill(
  handle: MemoryHandle,
  update: Row
): { ok: true; written: number; dryRun: boolean } {
  if (update.by !== 'owner') throw Object.assign(new Error('OWNER_ONLY'), { code: 'OWNER_ONLY' });
  const dryRun = update.dryRun === true;
  const at = new Date(typeof update.now === 'number' ? update.now : Date.now()).toISOString();
  return handle.transaction(() => {
    const db = dbOf(handle);
    const rows = db
      .prepare(
        `SELECT id, extra FROM selfreflection
          WHERE scope_kind = 'group' AND retired_at IS NULL ORDER BY at_ms, id`
      )
      .all();
    const write = db.prepare('UPDATE selfreflection SET extra = ? WHERE id = ?');
    let written = 0;
    for (const row of rows) {
      const metadata = metadataOf(row.extra);
      if (metadata === null || metadata.publicationAudience !== undefined) continue;
      written += 1;
      if (dryRun) continue;
      write.run(JSON.stringify({ ...metadata, publicationAudience: { kind: 'unrestricted' } }), row.id);
      projectRow(db, 'selfreflection', { id: String(row.id) }, { at });
    }
    return { ok: true, written, dryRun };
  });
}
