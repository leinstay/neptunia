// The places of the roots an interface names in `hello` (`root` and `roots`, each `{ id, name }`,
// src/protocol/envelope.ts). The core takes every hello (src/core.ts) and writes the whole list it carried through the
// one writer, as `{ kind: 'roots', iface, roots, at }` (session-write.ts, `applyRootsWrite`).
//
//   noteRoots(handle, { iface, roots, at, names? }) -> { ok: true, noted: number }
//     Each root is the server place `<iface>:server:<id>` (kind `server`, authority `<iface>/global`, or the
//     server place the database already holds for that native id). A missing place is created, with the name when the
//     hello gave one; a retired place is revived; a name differing from the stored one renames it, and an empty name
//     keeps the stored one. A root the hello leaves out is not touched.
//     `names` is what the hello says of the interface itself (`hello.names`: `{ interface, nouns, dm }`): `interfaces.name`
//     becomes its `interface`, and its nouns of the kinds of place and its word for a direct chat go to
//     `interfaces.extra` (`{ nouns, dm }`), where the name index reads the nouns (names.ts). A hello without names leaves
//     a stored name as it is and names an unnamed interface by its id.

import { addKey, ensureInterface, placeColumns } from './rows.ts';
import { projectRow } from './graph.ts';
import { touchNames } from './names.ts';
import { topPlaceSpelled } from './ids.ts';
import { asText, dbOf } from './types.ts';
import type { Db, MemoryHandle, Row } from './types.ts';
import type { InterfaceNames } from '../../protocol/serve.ts';

export type { InterfaceNames };

export type Root = { id: string; name: string };

/** Whether `value` is the names a hello carries: a name, nouns by kind of place, and a word for a direct chat. */
export function isInterfaceNames(value: unknown): value is InterfaceNames {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const names = value as Record<string, unknown>;
  const nouns = names.nouns;
  return (
    typeof names.interface === 'string' &&
    typeof names.dm === 'string' &&
    nouns !== null &&
    typeof nouns === 'object' &&
    !Array.isArray(nouns) &&
    Object.values(nouns).every((noun) => typeof noun === 'string')
  );
}

/** The interface's name and nouns, from its hello's names or, for an unnamed interface, its id. */
function noteInterfaceNames(db: Db, iface: string, names: InterfaceNames | undefined): void {
  ensureInterface(db, iface);
  if (names === undefined) {
    db.prepare("UPDATE interfaces SET name = ? WHERE id = ? AND (name IS NULL OR name = '')").run(iface, iface);
  } else {
    const name = asText(names.interface).trim();
    const extra = JSON.stringify({ nouns: names.nouns, dm: names.dm });
    db.prepare('UPDATE interfaces SET name = ?, extra = ? WHERE id = ?').run(name === '' ? iface : name, extra, iface);
  }
  touchNames(db, 'interfaces', iface);
}

/** Writes the places of the roots one hello named, in one transaction. */
export function noteRoots(
  handle: MemoryHandle,
  { iface, roots, at, names }: { iface: string; roots: ReadonlyArray<Root>; at: string; names?: InterfaceNames }
): { ok: true; noted: number } {
  return handle.transaction(() => {
    const db = dbOf(handle);
    noteInterfaceNames(db, iface, names);
    let noted = 0;
    for (const root of roots) {
      const native = asText(root.id);
      if (native === '') continue;
      const name = asText(root.name ?? '').trim();
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
          `INSERT INTO places (id, iface, kind, native_id, parent_id, scope_kind, name, authority_id, native_key, generation, chat)
           VALUES (?, ?, 'server', ?, NULL, 'group', ?, ?, ?, 1, ?)`
        ).run(
          asText(probe.id),
          iface,
          native,
          name === '' ? null : name,
          cols.authority_id,
          cols.native_key,
          cols.chat
        );
        addKey(db, cols.authority_id, 'place', cols.native_key, probe.id, { at });
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
