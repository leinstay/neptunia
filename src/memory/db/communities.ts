// The places of the communities an interface names in `hello` (`community` and `communities`, each `{ id, name }`,
// src/protocol/envelope.ts). The core takes every hello (src/core.ts) and writes the whole list it carried through the
// one writer, as `{ kind: 'communities', iface, communities, at }` (session-write.ts, `applyCommunitiesWrite`).
//
//   noteCommunities(handle, { iface, communities, at }) -> { ok: true, noted: number }
//     Each community is the server place `<iface>:server:<id>` (kind `server`, authority `<iface>/global`, or the
//     server place the database already holds for that native id). A missing place is created, with the name when the
//     hello gave one; a retired place is revived; a name differing from the stored one renames it, and an empty name
//     keeps the stored one. A community the hello leaves out is not touched.

import { addKey, ensureInterface, placeColumns } from './rows.ts';
import { projectRow } from './graph.ts';
import { LEGACY_AUTHORITY, topPlaceSpelled } from './ids.ts';
import { asText, dbOf } from './types.ts';
import type { MemoryHandle, Row } from './types.ts';

export type Community = { id: string; name: string };

/** Writes the places of the communities one hello named, in one transaction. */
export function noteCommunities(
  handle: MemoryHandle,
  { iface, communities, at }: { iface: string; communities: ReadonlyArray<Community>; at: string }
): { ok: true; noted: number } {
  return handle.transaction(() => {
    const db = dbOf(handle);
    let noted = 0;
    for (const community of communities) {
      const native = asText(community.id);
      if (native === '') continue;
      const name = asText(community.name ?? '').trim();
      const probe: Row = {
        id: topPlaceSpelled(iface, native),
        iface,
        kind: 'server',
        native_id: native,
        scope_kind: 'group',
      };
      const cols = placeColumns(probe);
      const found = db
        .prepare("SELECT id, name, retired_at FROM places WHERE authority_id = ? AND kind = 'server' AND native_id = ?")
        .get(cols.authority_id, native);
      if (found === undefined) {
        ensureInterface(db, iface);
        db.prepare(
          `INSERT INTO places (id, iface, kind, native_id, parent_id, scope_kind, name, authority_id, native_key, generation, conversation)
           VALUES (?, ?, 'server', ?, NULL, 'group', ?, ?, ?, 1, ?)`
        ).run(
          asText(probe.id),
          iface,
          native,
          name === '' ? null : name,
          cols.authority_id,
          cols.native_key,
          cols.conversation
        );
        addKey(db, cols.authority_id, 'place', cols.native_key, probe.id, { at });
        addKey(db, LEGACY_AUTHORITY, 'place', probe.id, probe.id, { at });
      } else {
        const renamed = name !== '' && name !== found.name;
        if (!renamed && found.retired_at === null) continue;
        db.prepare('UPDATE places SET name = ?, retired_at = NULL WHERE id = ?').run(
          renamed ? name : found.name,
          asText(found.id)
        );
      }
      projectRow(db, 'places', { id: found?.id ?? probe.id }, { at });
      noted += 1;
    }
    return { ok: true as const, noted };
  });
}
