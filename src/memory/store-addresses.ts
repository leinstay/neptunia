// How the store names what a core module holds natively: the place of a chat, the top of its tree, the account and
// the person of a member, and the native id back for a read of the interface. Reads the memory database through the store's
// read seam; without a database every id answers as given, so a test's store needs no rows. The way back, from an id to
// its person or native id, reads a stored row or what this store named the id from, and never the text of the id.

import { currentIface } from './db/current-iface.ts';
import { placeRefOf } from './db/frame-reads.ts';
import type { PlaceRef } from './db/frame-reads.ts';
import { interfaceAccountId, interfacePlaceOf, nativeAuthorityOf, topPlaceSpelled } from './db/ids.ts';
import { chatPlaceKey } from './db/observe-event.ts';
import { accountNodeOf } from './db/person-links.ts';
import { placeChainInDb, rootPlaceInDb } from './db/place-tree.ts';
import type { PlaceChainLink } from './db/place-tree.ts';
import { linkedPrivateClaims } from './db/private-read.ts';
import { lineNumberOf } from './db/chat-lines.ts';
import { PERSONA_ID } from './db/storage-keys.ts';
import type { StorageKind } from './db/storage-keys.ts';
import { listUnits, subjectOf } from './db/storage-units.ts';
import { isOperationalKind, operationalSubjects } from './db/operational.ts';
import type { Db } from './db/types.ts';

/** What the store knows of a chat it names. */
type ChatNames = Parameters<typeof chatPlaceKey>[0] & {
  iface?: string | null;
  authorityId?: string | null;
  rootId?: string | null;
  id?: string | null;
};

type Seam = { db(): Db; run<TResult>(fn: () => TResult): TResult };

type AddressedDb = { readHandle?(): unknown; namespace?(): unknown } | null | undefined;

/** The most places the addressing remembers it named from a chat; the oldest goes first. */
const NAMED_MAX = 2000;

function buildAddressing({ memoryDb, seam }: { memoryDb: AddressedDb; seam: Seam }) {
  const readable = (): boolean => Boolean(memoryDb?.readHandle?.());
  // The places named from a chat or a root the interface described: its native id and the top of its tree, for a place
  // the database holds no row of yet (no message of it observed, the hello's roots not yet written) or a store with no
  // database. `root` marks a place named as a root.
  const named = new Map<string, { chat: string; top: string; root: boolean }>();
  const remember = (placeId: string, chat: string, top: string, root = false): void => {
    named.delete(placeId);
    named.set(placeId, { chat, top, root });
    if (named.size > NAMED_MAX) named.delete(named.keys().next().value ?? placeId);
  };
  // The accounts this store minted an id for, by the native id it was minted from, for an account no row holds yet.
  const minted = new Map<string, string>();
  const rememberAccount = (accountId: string, nativeId: string): void => {
    minted.delete(accountId);
    minted.set(accountId, nativeId);
    if (minted.size > NAMED_MAX) minted.delete(minted.keys().next().value ?? accountId);
  };
  const ifaceNow = (): string | null => {
    const named: unknown = typeof memoryDb?.namespace === 'function' ? memoryDb.namespace() : null;
    return currentIface() ?? (typeof named === 'string' && named ? named : null);
  };

  function rootPlaceOf(placeId: string): string | null {
    const stored = readable() ? seam.run(() => rootPlaceInDb(seam.db(), placeId)) : null;
    return stored ?? named.get(placeId)?.top ?? null;
  }

  /** The account a stored DM place is with, or null. */
  function partnerOfPlace(placeId: unknown): string | null {
    if (typeof placeId !== 'string' || !readable()) return null;
    const found: unknown = seam.run(
      () => seam.db().prepare('SELECT partner_account FROM places WHERE id = ?').get(placeId)?.partner_account
    );
    return typeof found === 'string' ? found : null;
  }

  function storedPersonOfAccount(accountId: string): string | null {
    const stored: unknown = readable()
      ? seam.run(() => seam.db().prepare('SELECT person_id FROM accounts WHERE id = ?').get(accountId)?.person_id)
      : null;
    return typeof stored === 'string' && stored ? stored : null;
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

  /**
   * The native id an account or a place holds, for the stored value's own `id`: its row's, else the one this store
   * named it from, else null. Without a database the id as given (already native).
   */
  function nativeOfRow(table: 'accounts' | 'places', id: string): string | null {
    if (!memoryDb) return id;
    const native: unknown = readable()
      ? seam.run(() => seam.db().prepare(`SELECT native_id FROM ${table} WHERE id = ?`).get(id)?.native_id)
      : null;
    if (typeof native === 'string' && native) return native;
    return (table === 'accounts' ? minted.get(id) : named.get(id)?.chat) ?? null;
  }

  function placeOfRoot(nativeId: string, iface?: string): string {
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
    if (typeof found === 'string') return found;
    const spelled = topPlaceSpelled(name, nativeId);
    remember(spelled, String(nativeId), spelled, true);
    return spelled;
  }

  function placeOfChat(chat: ChatNames, iface?: string): string {
    const placeId = placeIdOf(chat, iface);
    const native = chat?.id;
    if (typeof native === 'string' && native) {
      const root = chat.rootId;
      const top =
        typeof root === 'string' && root ? (memoryDb ? placeOfRoot(root, chat.iface ?? iface) : root) : placeId;
      remember(placeId, native, top);
    }
    return placeId;
  }

  function placeIdOf(chat: ChatNames, iface?: string): string {
    if (!memoryDb) return String(chat?.id ?? '');
    const name = String(chat?.iface ?? iface ?? ifaceNow());
    const authority = String(chat?.authorityId ?? nativeAuthorityOf(name));
    const key = chatPlaceKey(chat);
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
    placeOfChat,
    placeOfRoot,

    /**
     * Whether a stored place holds this native chat as a channel, a thread or a group DM. A DM is keyed by its
     * partner, so its chat id is never held: a caller with no partner in hand reads `false` as "not a group's".
     */
    holdsSharedChat(chatId: string, iface?: string): boolean {
      if (!readable()) return false;
      const authority = nativeAuthorityOf(String(iface ?? ifaceNow()));
      return seam.run(() =>
        ['channel', 'thread', 'group_dm'].some((kind) =>
          seam
            .db()
            .prepare('SELECT 1 FROM places WHERE authority_id = ? AND native_key = ?')
            .get(authority, `${kind}:${chatId}`)
        )
      );
    },

    /** The place that holds what a chat shares with its tree: the top of it; a DM is its own. */
    sharedPlaceOf(chat: ChatNames, iface?: string): string {
      if (!memoryDb) return String(chat?.rootId ?? chat?.id ?? '');
      const name = chat?.iface ?? iface;
      if (typeof chat?.rootId === 'string' && chat.rootId) return placeOfRoot(chat.rootId, name);
      const own = placeOfChat(chat, name);
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
      if (found) return found;
      const account = interfaceAccountId(authority, String(nativeId));
      rememberAccount(account, String(nativeId));
      return account;
    },

    /** The person an account is linked to (`accounts.person_id`), null when no stored row links one. */
    personOfAccount: storedPersonOfAccount,

    /** The person an account is linked to, null when no stored row links one. */
    storedPersonOfAccount,

    /**
     * The native id an interface knows a root by, from its place: the row's native id, else the native id this store
     * named a root without a row from, else the id as given (a caller that holds a root's native id passes it on, and a
     * store without a database holds native ids). Null for a place no root read can name (a DM, a place with no native
     * id).
     */
    nativeRootOf(placeId: string): string | null {
      const row = readable()
        ? seam.run(() => seam.db().prepare('SELECT native_id, kind, chat FROM places WHERE id = ?').get(placeId))
        : undefined;
      if (!row) {
        const known = named.get(placeId);
        return known?.root ? known.chat : placeId;
      }
      if (row.kind === 'dm' || row.chat === 'dm') return null;
      return typeof row.native_id === 'string' ? row.native_id : null;
    },

    /**
     * The top of a place's stored tree: the place itself when it has no parent, the last stored place when a parent is
     * missing, null for a cycle. A DM is its own root. A place with no row answers the top of the chat it was
     * named from (`placeOfChat`); an unknown id answers null.
     */
    rootPlaceOf,

    /** The stored chain from a place up to the top of its tree, the place first (placeChainInDb); empty without a row. */
    placeChainOf(placeId: string): Array<PlaceChainLink> {
      return readable() ? seam.run(() => placeChainInDb(seam.db(), placeId)) : [];
    },

    /**
     * The native chat of a place, for a call that speaks to its interface: the address its row holds, the chat id its
     * interface gave, for a direct chat as for a channel, else the chat this store named the place from (a message the
     * writer has not stored yet); null when neither holds one. With no row: the chat the place was named from, else the
     * id as given (a caller that holds a native chat passes it on, and a store without a database holds native ids).
     */
    chatOfPlace(placeId: string): string | null {
      const known = named.get(placeId)?.chat ?? null;
      const row = readable()
        ? seam.run(() => seam.db().prepare('SELECT native_id FROM places WHERE id = ?').get(placeId))
        : undefined;
      if (!row) return known ?? placeId;
      return typeof row.native_id === 'string' && row.native_id ? row.native_id : known;
    },

    /** A stored place as its interface knows it (frame-reads.ts#placeRefOf), null without a row or a database. */
    placeRefOf(placeId: string): PlaceRef | null {
      return readable() ? seam.run(() => placeRefOf(seam.db(), placeId)) : null;
    },

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

    /** The top of every tree that holds chats of many people, in id order. */
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
      if (isOperationalKind(kind)) return seam.run(() => operationalSubjects(seam.db(), kind));
      return seam.run(() => [...new Set(listUnits(seam.db(), { kind }).map((unit) => subjectOf(unit).id))]);
    },

    placeHolding(kind: StorageKind): string | null {
      if (!readable()) return null;
      return seam.run(() => {
        const first = listUnits(seam.db(), { kind })[0];
        return first ? subjectOf(first).id : null;
      });
    },

    /** The number the owner's chat draws on the stored line of a place by its message id (chat-lines.ts), or null. */
    lineNumberOf(placeId: string, nativeId: string): number | null {
      return readable() ? seam.run(() => lineNumberOf(seam.db(), placeId, nativeId)) : null;
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
