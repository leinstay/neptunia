// The owner's desk of the selfreflection's mirrors: what `/mirror` reads and changes (src/interface/commands/mirror.ts). A change of
// configuration goes through the writer (`memoryWrite`, kind `mirror`; src/memory/db/mirror-config.ts) and leaves the
// delivery history alone, so removing and adding a destination again keeps deduplication. Reconciliation records which
// entries already count as published on a mirror, named one by one or up to a boundary entry, with who said so. A number
// of remote messages never stands in for a receipt, since one entry can be several messages and a post can be deleted.
// `absent` is the owner's word that an uncertain send never arrived. Answers carry result codes; a refused change writes
// nothing.

import { hasMirrors } from '../memory/db/mirrors.ts';
import {
  entriesThrough,
  historyOf,
  mirrorNamed,
  mirrorRows,
  placeNamed,
  unknownEntry,
} from '../memory/db/mirror-config.ts';
import type { BackfillChange, MirrorRow } from '../memory/db/mirror-config.ts';
import { refusedEntries } from '../memory/db/selfreflection-audience.ts';
import { storedSelfreflectionPublicationRefusal } from '../memory/db/publish.ts';
import { publicationFor, stateOfRow } from '../memory/db/publication-delivery.ts';
import type { PublicationState } from '../memory/db/publication-delivery.ts';
import type { Db } from '../memory/db/types.ts';
import type { Mirror, MirrorMemory, MirrorPort } from './mirror.ts';

export type { BackfillChange, PublicationState };

/** What a change of a mirror answers. */
export type MirrorChange =
  | { ok: true; mirror: Mirror; reused: boolean }
  | { ok: false; code: 'unknown-place' | 'ambiguous-place' | 'unknown-mirror' | 'no-interval' };

/** What a reconciliation answers. */
export type ReconcileAnswer =
  | { ok: true; mirror: Mirror; recorded: number; kept: number; requeued: number }
  | { ok: false; code: 'unknown-entry' | 'unknown-mirror' | 'no-selection' | 'not-uncertain'; entryId?: string };

/** One mirror as `mirrorStatus` answers it. */
export type MirrorStatus = Mirror & {
  iface: string;
  chatId: string;
  interfaceConnected: boolean;
  queued: number;
  failed: Array<{ entryId: string; code: string | null; retryable: boolean }>;
  incomplete: Array<{ entryId: string; code: string | null }>;
  uncertain: Array<{ entryId: string }>;
  deliveredOutsideAudience: Array<{ entryId: string }>;
  /** Entries whose audience could not be read: on no mirror, each with why, until the owner changes the row. */
  audienceBlocked: Array<{ entryId: string; code: 'audience-invalid'; reason: string }>;
  backfill: {
    enabled: boolean;
    intervalMs: number | null;
    highWater: string | null;
    nextDueAt: number | null;
    completedAt: number | null;
    remaining: number;
    blocked: { entryId: string; code: string } | null;
  };
};

export type MirrorDesk = {
  listMirrors(): Array<Mirror>;
  mirrorStatus(): Array<MirrorStatus>;
  publicationState(entryId: string, placeId: string): PublicationState | null;
  addMirror(request: { destination: string; by: string; backfill?: BackfillChange }): Promise<MirrorChange>;
  configureMirror(request: {
    mirror: string;
    by: string;
    enabled?: boolean;
    backfill?: BackfillChange;
  }): Promise<MirrorChange>;
  removeMirror(request: { mirror: string; by: string }): Promise<MirrorChange>;
  reconcileReceipts(request: {
    mirror: string;
    by: string;
    through?: string;
    entries?: ReadonlyArray<string>;
    absent?: boolean;
  }): Promise<ReconcileAnswer>;
};

const brief = ({ id, placeId, enabled }: Pick<MirrorRow, 'id' | 'placeId' | 'enabled'>): Mirror => ({
  id,
  placeId,
  enabled,
});

export function createMirrorDesk({
  memoryDb,
  database,
  port,
  now,
}: {
  memoryDb: MirrorMemory;
  database: () => Db | null;
  port: (iface: string) => MirrorPort | null;
  now: () => number;
}): MirrorDesk {
  /** The connection when it holds the mirrors' table. */
  function open(): Db | null {
    const db = database();
    return db && hasMirrors(db) ? db : null;
  }

  const write = (update: Record<string, unknown>): Promise<unknown> =>
    memoryDb.memoryWrite({ kind: 'mirror', ...update });

  /** A configuration write's answer as a change. */
  function changed(answer: unknown): MirrorChange {
    const written = answer as { mirror: MirrorRow; reused: boolean } | null;
    return written
      ? { ok: true, mirror: brief(written.mirror), reused: written.reused }
      : { ok: false, code: 'unknown-mirror' };
  }

  const listMirrors = (): Array<Mirror> => {
    const db = open();
    return db ? mirrorRows(db).map(brief) : [];
  };

  /** Whether `entryId` went out to `placeId` and its audience has since left that place out: no edit takes the copy back. */
  const outsideAudience = (db: Db, status: unknown, entryId: unknown, placeId: unknown): boolean =>
    status === 'sent' && storedSelfreflectionPublicationRefusal(db, entryId, placeId) === 'audience-excluded';

  function statusOf(db: Db, mirror: MirrorRow): MirrorStatus {
    const rows = db
      .prepare(
        "SELECT row_id, status, code, retryable FROM publications WHERE row_kind = 'selfreflection' AND destination_place_id = ? AND retired_at IS NULL ORDER BY created_at, id"
      )
      .all(mirror.placeId);
    const having = (status: string) => rows.filter((row) => row.status === status);
    const code = (value: unknown): string | null => (typeof value === 'string' ? value : null);
    const { remaining, blocked } = historyOf(db, mirror);
    return {
      ...brief(mirror),
      iface: mirror.iface,
      chatId: mirror.chatId,
      interfaceConnected: port(mirror.iface) !== null,
      queued: having('queued').length,
      failed: having('failed').map((row) => ({
        entryId: String(row.row_id),
        code: code(row.code),
        retryable: row.retryable === 1,
      })),
      incomplete: having('incomplete').map((row) => ({ entryId: String(row.row_id), code: code(row.code) })),
      uncertain: having('unknown').map((row) => ({ entryId: String(row.row_id) })),
      deliveredOutsideAudience: rows
        .filter((row) => outsideAudience(db, row.status, row.row_id, mirror.placeId))
        .map((row) => ({ entryId: String(row.row_id) })),
      audienceBlocked: refusedEntries(db).map((one) => ({ ...one, code: 'audience-invalid' })),
      backfill: { ...mirror.backfill, remaining, blocked },
    };
  }

  /** The selection of a reconciliation, or what refuses it. */
  function selection(
    db: Db,
    through: string | undefined,
    entries: ReadonlyArray<string> | undefined
  ): { ids: Array<string> } | { code: 'unknown-entry' | 'no-selection'; entryId?: string } {
    const chosen = [...(entries ?? [])];
    if (through === undefined && chosen.length === 0) return { code: 'no-selection' };
    const upTo = through === undefined ? [] : entriesThrough(db, through);
    if (upTo === null) return { code: 'unknown-entry', entryId: through as string };
    const unknown = unknownEntry(db, chosen);
    if (unknown !== null) return { code: 'unknown-entry', entryId: unknown };
    return { ids: [...new Set([...upTo, ...chosen])] };
  }

  return {
    listMirrors,

    mirrorStatus() {
      const db = open();
      return db ? mirrorRows(db).map((mirror) => statusOf(db, mirror)) : [];
    },

    publicationState(entryId, placeId) {
      const db = database();
      const row = db ? publicationFor(db, entryId, placeId) : null;
      return db && row ? stateOfRow(row, outsideAudience(db, row.status, entryId, placeId)) : null;
    },

    async addMirror({ destination, by, backfill }) {
      const db = open();
      if (!db) return { ok: false, code: 'unknown-place' };
      const place = placeNamed(db, destination);
      if (!place.ok) return place;
      const known = mirrorNamed(db, place.placeId);
      if (backfill?.enabled === true && backfill.intervalMs === undefined && known?.backfill.intervalMs == null)
        return { ok: false, code: 'no-interval' };
      return changed(await write({ op: 'add', placeId: place.placeId, by, backfill, now: now() }));
    },

    async configureMirror({ mirror, by, enabled, backfill }) {
      const db = open();
      const known = db ? mirrorNamed(db, mirror) : null;
      if (!known) return { ok: false, code: 'unknown-mirror' };
      if (backfill?.enabled === true && backfill.intervalMs === undefined && known.backfill.intervalMs === null)
        return { ok: false, code: 'no-interval' };
      return changed(await write({ op: 'configure', id: known.id, by, enabled, backfill, now: now() }));
    },

    async removeMirror({ mirror, by }) {
      const db = open();
      const known = db ? mirrorNamed(db, mirror) : null;
      if (!known) return { ok: false, code: 'unknown-mirror' };
      return changed(await write({ op: 'remove', id: known.id, by, now: now() }));
    },

    async reconcileReceipts({ mirror, by, through, entries, absent = false }) {
      const db = open();
      const known = db ? mirrorNamed(db, mirror) : null;
      if (!db || !known) return { ok: false, code: 'unknown-mirror' };
      // Absence is said of named sends: a boundary would sweep in whatever else it covers.
      if (absent && through !== undefined) return { ok: false, code: 'no-selection' };
      const chosen = selection(db, through, entries);
      if ('code' in chosen) return { ok: false, ...chosen };
      const place = known.placeId;
      if (absent) {
        const settled = chosen.ids.find((id) => publicationFor(db, id, place)?.status !== 'unknown');
        if (settled !== undefined) return { ok: false, code: 'not-uncertain', entryId: settled };
      }
      const op = absent ? 'absent' : 'reconcile';
      const answer = (await memoryDb.memoryWrite({
        kind: 'publication',
        op,
        placeId: place,
        entries: chosen.ids,
        by,
        now: now(),
      })) as { recorded?: number; kept?: number; requeued?: number };
      return {
        ok: true,
        mirror: brief(known),
        recorded: answer.recorded ?? 0,
        kept: answer.kept ?? 0,
        requeued: answer.requeued ?? 0,
      };
    },
  };
}
