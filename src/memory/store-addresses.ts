// How the store names what a core module holds natively: the place of a conversation, the top of its tree, the account and
// the person of a member, and the native id back for a read of the interface. Reads the memory database through the store's
// read seam; without a database every id answers as given, so a test's store needs no rows.

import { currentIface } from './db/current-iface.ts';
import { interfaceAccountId, interfacePlaceOf, nativeAuthorityOf, nativeOfAny, topPlaceSpelled } from './db/ids.ts';
import { LEGACY_IFACE } from './db/legacy-namespace.ts';
import { conversationPlaceKey } from './db/observe-event.ts';
import { accountNodeOf } from './db/person-links.ts';
import { rootPlaceInDb } from './db/place-tree.ts';
import { linkedPrivateClaims } from './db/private-read.ts';
import { PERSONA_ID } from './db/storage-keys.ts';
import type { StorageKind } from './db/storage-keys.ts';
import { listUnits } from './db/storage-units.ts';
import type { Db } from './db/types.ts';

/** What the store knows of a conversation it names. */
type ConversationNames = Parameters<typeof conversationPlaceKey>[0] & {
  iface?: string | null;
  authorityId?: string | null;
  rootId?: string | null;
  id?: string | null;
};

type Seam = { db(): Db; run<TResult>(fn: () => TResult): TResult };

type AddressedDb = { readHandle?(): unknown; namespace?(): unknown } | null | undefined;

function buildAddressing({ memoryDb, seam }: { memoryDb: AddressedDb; seam: Seam }) {
  const readable = (): boolean => Boolean(memoryDb?.readHandle?.());
  const ifaceNow = (): string => {
    const named: unknown = typeof memoryDb?.namespace === 'function' ? memoryDb.namespace() : null;
    return currentIface() ?? (typeof named === 'string' && named ? named : LEGACY_IFACE);
  };

  function rootPlaceOf(placeId: string): string | null {
    if (!readable()) return null;
    return seam.run(() => rootPlaceInDb(seam.db(), placeId));
  }

  /** The account a stored DM place is with, or null. */
  function partnerOfPlace(placeId: unknown): string | null {
    if (typeof placeId !== 'string' || !readable()) return null;
    const found: unknown = seam.run(
      () => seam.db().prepare('SELECT partner_account FROM places WHERE id = ?').get(placeId)?.partner_account
    );
    return typeof found === 'string' ? found : null;
  }

  /** Where a private item of an account is archived: its DM place, the persona's archive when it has none yet. */
  function dmHomeOf(accountId: string): string | null {
    if (!readable()) return null;
    const found: unknown = seam.run(
      () =>
        seam
          .db()
          .prepare(
            `SELECT id FROM places WHERE partner_account = ? AND retired_at IS NULL
             ORDER BY COALESCE(seen_to_at, '') DESC, id LIMIT 1`
          )
          .get(accountId)?.id
    );
    return typeof found === 'string' ? found : null;
  }

  /** The native id an account or a place holds, for the stored value's own `id`. */
  function nativeOfRow(table: 'accounts' | 'places', id: string): string {
    const native: unknown = readable()
      ? seam.run(() => seam.db().prepare(`SELECT native_id FROM ${table} WHERE id = ?`).get(id)?.native_id)
      : null;
    return typeof native === 'string' && native ? native : (nativeOfAny(id) ?? id);
  }

  function placeOfCommunity(nativeId: string, iface?: string): string {
    if (!memoryDb || nativeId === PERSONA_ID) return String(nativeId);
    const name = String(iface ?? ifaceNow());
    const authority = nativeAuthorityOf(name);
    const found: unknown = readable()
      ? seam.run(
          () =>
            seam
              .db()
              .prepare("SELECT id FROM places WHERE authority_id = ? AND kind = 'server' AND native_id = ?")
              .get(authority, String(nativeId))?.id
        )
      : null;
    return typeof found === 'string' ? found : topPlaceSpelled(name, nativeId);
  }

  function placeOfConversation(conversation: ConversationNames, iface?: string): string {
    if (!memoryDb) return String(conversation?.id ?? '');
    const name = String(conversation?.iface ?? iface ?? ifaceNow());
    const authority = String(conversation?.authorityId ?? nativeAuthorityOf(name));
    const key = conversationPlaceKey(conversation);
    const found: unknown = readable()
      ? seam.run(
          () =>
            seam.db().prepare('SELECT id FROM places WHERE authority_id = ? AND native_key = ?').get(authority, key)?.id
        )
      : null;
    return typeof found === 'string' ? found : interfacePlaceOf(authority, key).id;
  }

  const methods = () => ({
    dmHomeOf,
    placeOfConversation,
    placeOfCommunity,

    /**
     * Whether a stored place holds this native conversation as a channel, a thread or a group DM. A DM is keyed by its
     * partner, so its conversation id is never held: a caller with no partner in hand reads `false` as "not a group's".
     */
    holdsSharedConversation(conversationId: string, iface?: string): boolean {
      if (!readable()) return false;
      const authority = nativeAuthorityOf(String(iface ?? ifaceNow()));
      return seam.run(() =>
        ['channel', 'thread', 'group_dm'].some((kind) =>
          seam
            .db()
            .prepare('SELECT 1 FROM places WHERE authority_id = ? AND native_key = ?')
            .get(authority, `${kind}:${conversationId}`)
        )
      );
    },

    /** The place that holds what a conversation shares with its tree: the top of it; a DM is its own. */
    sharedPlaceOf(conversation: ConversationNames, iface?: string): string {
      if (!memoryDb) return String(conversation?.rootId ?? conversation?.id ?? '');
      const name = conversation?.iface ?? iface;
      if (typeof conversation?.rootId === 'string' && conversation.rootId)
        return placeOfCommunity(conversation.rootId, name);
      const own = placeOfConversation(conversation, name);
      return rootPlaceOf(own) ?? own;
    },

    /** The account of a member an interface names by a native id: the stored one, its spelled id before one exists. */
    accountOf(nativeId: string, iface?: string): string {
      if (!memoryDb) return String(nativeId);
      const name = String(iface ?? ifaceNow());
      const authority = nativeAuthorityOf(name);
      const found = readable()
        ? seam.run(() =>
            accountNodeOf(seam.db(), {
              interfaceId: name,
              authorityId: authority,
              nativeId: String(nativeId),
              generation: 1,
            })
          )
        : null;
      return found ?? interfaceAccountId(authority, String(nativeId));
    },

    /** The person an account is linked to: the stored one, the id spelled from the account before one exists. */
    personOfAccount(accountId: string): string {
      const stored: unknown = readable()
        ? seam.run(() => seam.db().prepare('SELECT person_id FROM accounts WHERE id = ?').get(accountId)?.person_id)
        : null;
      return typeof stored === 'string' && stored ? stored : `person:${accountId}`;
    },

    /**
     * The native id an interface knows a community by, from its place: the id as given when no row holds it (already
     * native), null for a place no community read can name (a DM, a place with no native id).
     */
    nativeCommunityOf(placeId: string): string | null {
      if (!readable()) return placeId;
      const row = seam.run(() =>
        seam.db().prepare('SELECT native_id, kind, conversation FROM places WHERE id = ?').get(placeId)
      );
      if (!row) return /^[^:]+:server:(.+)$/.exec(placeId)?.[1] ?? placeId;
      if (row.kind === 'dm' || row.conversation === 'dm') return null;
      return typeof row.native_id === 'string' ? row.native_id : null;
    },

    /**
     * The top of a place's stored tree: the place itself when it has no parent, the last stored place when a parent is
     * missing, null for an unknown id and for a cycle. A DM is its own root.
     */
    rootPlaceOf,

    /** The stored child places of a place, one level of `places.parent_id` down, in id order. */
    listChildren(placeId: string): Array<Record<string, unknown>> {
      if (!readable()) return [];
      return seam.run(() =>
        seam
          .db()
          .prepare('SELECT * FROM places WHERE parent_id = ? AND retired_at IS NULL ORDER BY id')
          .all(placeId)
          .map((row) => ({ ...row }))
      );
    },

    /** The top of every tree that holds conversations of many people, in id order. */
    topPlaces(iface?: string): Array<string> {
      if (!readable()) return [];
      return seam.run(() =>
        seam
          .db()
          .prepare("SELECT id, iface FROM places WHERE kind = 'server' AND retired_at IS NULL ORDER BY id")
          .all()
          .filter((row) => iface === undefined || row.iface === iface)
          .map((row) => String(row.id))
      );
    },

    /** The subject of the first collection of `kind` the database holds, for a registry kept in one place. */
    placesHolding(kind: StorageKind): Array<string> {
      if (!readable()) return [];
      return seam.run(() => [...new Set(listUnits(seam.db(), { kind }).map((unit) => unit.key.subject.id))]);
    },

    placeHolding(kind: StorageKind): string | null {
      if (!readable()) return null;
      return seam.run(() => listUnits(seam.db(), { kind })[0]?.key.subject.id ?? null);
    },

    /** What a person said in their other DMs, for the request of a DM turn: `{ text }` per claim. */
    linkedPrivateOf(accountId: string): Array<{ text: string }> {
      if (!readable()) return [];
      return seam.run(() => linkedPrivateClaims(seam.db(), accountId));
    },
  });

  /** Whether a channel shows from `placeId`: it sits in that tree, or `placeId` is a DM on the channel's interface. */
  function inViewOf(listed: string, placeId: string): boolean {
    if (listed === placeId || rootPlaceOf(listed) === placeId) return true;
    if (!readable()) return false;
    const db = seam.db();
    const place = seam.run(() => db.prepare('SELECT iface, kind FROM places WHERE id = ?').get(placeId));
    if (place?.kind !== 'dm') return false;
    return seam.run(() => db.prepare('SELECT iface FROM places WHERE id = ?').get(listed))?.iface === place.iface;
  }

  return { methods, rootPlaceOf, partnerOfPlace, dmHomeOf, nativeOfRow, inViewOf };
}

export const createAddressing = (given: { memoryDb: AddressedDb; seam: Seam }): ReturnType<typeof buildAddressing> =>
  buildAddressing(given);
