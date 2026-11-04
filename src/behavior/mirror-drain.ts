// One drain of the diary's mirrors, run by the scheduler's tick and when an interface connects. In order: a claim past its
// lease becomes `unknown` (`mirrors.claimLeaseMs`), since its publisher is gone and may have sent; an adapter that can
// look a send up by its idempotency key settles an `unknown` row; an entry stored after a mirror's registration with no
// publication there, lost to a crash between its storing and its publish, is queued; what is queued, retryable or
// waiting for a lost file goes out, each row claimed through the writer, so overlapping drains send it once; and each
// mirror's backfill takes its one historical slot when it is due. One mirror's trouble stops none of the others.
//
// A row that failed for certain with no retry in sight stays as it is until the owner acts or a backfill slot reaches it.
// A row a historical slot sent (`paced`) is retried at its mirror's next slot alone.

import { log } from '../log.ts';
import { deliveryOf } from '../memory/db/publication-delivery.ts';
import { historyOf, mirrorRows, unpublishedSince } from '../memory/db/mirror-config.ts';
import type { MirrorRow, ScannedEntry } from '../memory/db/mirror-config.ts';
import { reconcileUnknown } from '../interface/reconcile.ts';
import { diaryMetadataOf, isPublicationBoundary } from '../tools/publication.ts';
import { errorCode, scannedMessages, storedEntry } from './mirror-stored.ts';
import type { DiaryPlace } from '../memory/db/mirrors.ts';
import type { Db } from '../memory/db/types.ts';
import type { Adapter } from '../protocol/adapter.ts';
import type { DiaryEntry, MirrorMemory, MirrorPort, Publication, PublishOutcome } from './mirror.ts';

type Prepared = { ok: true; publication: Publication; reused: boolean } | { ok: false; code: string };

/** A claim's row as a drain reads it. */
type Claimed = Publication & { claimed_at?: number | null };

const SENDABLE_SQL = `SELECT * FROM publications WHERE row_kind = 'diary' AND retired_at IS NULL
  AND (status = 'queued' OR (paced = 0 AND (status = 'incomplete' OR (status = 'failed' AND retryable = 1))))
  ORDER BY created_at, id`;

const codeOf = (err: unknown): string => errorCode(err, 'ERROR');

export function createMirrorDrain({
  database,
  memoryDb,
  port,
  now,
  dataDir,
  leaseMs,
  mirroredPlace,
  prepareFor,
  send,
  entriesBeingWritten,
}: {
  database: () => Db | null;
  memoryDb: MirrorMemory;
  port: (iface: string) => MirrorPort | null;
  now: () => number;
  dataDir: string | null;
  leaseMs: () => number;
  mirroredPlace: (db: Db, placeId: string) => DiaryPlace | null;
  prepareFor: (db: Db, entry: DiaryEntry, place: DiaryPlace, pending: boolean) => Promise<Prepared>;
  send: (
    publication: Publication,
    place: DiaryPlace,
    entry: DiaryEntry,
    options?: { paced?: boolean; missing?: boolean }
  ) => Promise<PublishOutcome>;
  entriesBeingWritten: () => number;
}): () => Promise<number> {
  const publicationWrite = (update: Record<string, unknown>): Promise<unknown> =>
    memoryDb.memoryWrite({ kind: 'publication', ...update });
  const mirrorWrite = (update: Record<string, unknown>): Promise<unknown> =>
    memoryDb.memoryWrite({ kind: 'mirror', ...update });

  const rowsWith = (db: Db, status: string): Array<Claimed> =>
    db
      .prepare(
        "SELECT * FROM publications WHERE row_kind = 'diary' AND status = ? AND retired_at IS NULL ORDER BY created_at, id"
      )
      .all(status) as Array<Claimed>; // the columns of the table

  /** Every claim past its lease to `unknown`. A clock that moved back leaves it standing (the writer checks). */
  async function expireClaims(db: Db): Promise<void> {
    const lease = leaseMs();
    const at = now();
    for (const row of rowsWith(db, 'sending'))
      if (at - Number(row.claimed_at) > lease)
        await publicationWrite({ op: 'expire', id: row.id, now: at, leaseMs: lease });
  }

  /** One `unknown` row looked up at its adapter, when the adapter can: found, absent, or left as it is. */
  async function lookUp(db: Db, row: Publication): Promise<void> {
    const place = mirroredPlace(db, row.destination_place_id);
    const uncertain = deliveryOf(row).segments.find((one) => one.status === 'uncertain');
    if (!place || !uncertain) return;
    const adapter = port(place.iface);
    if (adapter?.capabilities?.().reconcile !== true || !adapter.fetchMessages) return;
    const answer = await reconcileUnknown(adapter as Pick<Adapter, 'capabilities' | 'fetchMessages'>, {
      conversation: { iface: place.iface, conversationId: place.conversationId },
      idempotencyKey: uncertain.key,
    });
    if (answer.status === 'unknown') return;
    const found = answer.status === 'ok' ? answer.parts.map((part) => part.messageId) : [];
    await publicationWrite({ op: 'lookup', id: row.id, found, now: now() });
  }

  async function lookUpUncertain(db: Db): Promise<void> {
    for (const row of rowsWith(db, 'unknown'))
      await lookUp(db, row).catch((err: unknown) => log.warn('mirror: lookup failed', { code: codeOf(err) }));
  }

  /** A scanned entry as `prepareFor` takes it. */
  function scannedEntry(entry: ScannedEntry): DiaryEntry {
    const boundary = diaryMetadataOf(entry.extra).publicationBoundary;
    return {
      id: entry.id,
      messages: scannedMessages(entry.extra, entry.text),
      ...(isPublicationBoundary(boundary) ? { publicationBoundary: boundary } : {}),
    };
  }

  /** The entries a crash left with no publication on a mirror they belong to, queued. None while a diary turn runs. */
  async function queueUnpublished(db: Db, mirrors: ReadonlyArray<MirrorRow>): Promise<void> {
    if (entriesBeingWritten() > 0) return;
    for (const mirror of mirrors.filter((one) => one.enabled)) {
      const place = mirroredPlace(db, mirror.placeId);
      if (!place) continue;
      for (const entry of unpublishedSince(db, mirror)) {
        const prepared = await prepareFor(db, scannedEntry(entry), place, false);
        if (!prepared.ok) log.warn('mirror: not published', { code: prepared.code });
      }
    }
  }

  /** One row's send from what memory holds; whether it ended sent. A pending row with no content yet waits for its turn. */
  async function sendStored(db: Db, row: Publication, place: DiaryPlace, paced: boolean): Promise<boolean> {
    const { entry, missing, hasContent } = storedEntry(db, row, dataDir);
    if (!hasContent) return false;
    return (await send(row, place, entry, { paced, missing })).status === 'sent';
  }

  async function sendQueued(db: Db): Promise<number> {
    let sent = 0;
    for (const row of db.prepare(SENDABLE_SQL).all() as Array<Publication>) {
      const place = mirroredPlace(db, row.destination_place_id);
      if (!place) continue;
      try {
        if (await sendStored(db, row, place, false)) sent += 1;
      } catch (err) {
        log.warn('mirror: send stopped', { code: codeOf(err) });
      }
    }
    return sent;
  }

  /** The due time of a backfill on a clock that moved back: never more than one interval away. */
  async function dueAt(mirror: MirrorRow, at: number, interval: number): Promise<number | null> {
    const due = mirror.backfill.nextDueAt;
    if (due === null || due <= at + interval) return due;
    const next = at + interval;
    const { taken } = (await mirrorWrite({ op: 'slot', id: mirror.id, expected: due, next })) as { taken: boolean };
    return taken ? next : null;
  }

  /** The mirror's one historical entry when its slot is due: the slot is taken through the writer, then the entry sent. */
  async function backfillSlot(db: Db, mirror: MirrorRow): Promise<number> {
    const place = mirroredPlace(db, mirror.placeId);
    const interval = mirror.backfill.intervalMs;
    if (!place || !mirror.backfill.enabled || interval === null || !port(place.iface)) return 0;
    const at = now();
    const due = await dueAt(mirror, at, interval);
    if (due === null || due > at) return 0;
    const { next } = historyOf(db, mirror);
    if (!next) {
      await mirrorWrite({ op: 'complete', id: mirror.id, now: at });
      return 0;
    }
    const taken = (await mirrorWrite({ op: 'slot', id: mirror.id, expected: due, next: at + interval })) as {
      taken: boolean;
    };
    if (!taken.taken) return 0;
    let row = next.publication as Publication | null; // the columns of the table
    if (!row) {
      const prepared = await prepareFor(db, scannedEntry(next.entry), place, false);
      if (!prepared.ok) return 0;
      row = prepared.publication;
    }
    const sent = await sendStored(db, row, place, true);
    if (historyOf(db, mirror).remaining === 0) await mirrorWrite({ op: 'complete', id: mirror.id, now: now() });
    return sent ? 1 : 0;
  }

  async function backfillSlots(db: Db, mirrors: ReadonlyArray<MirrorRow>): Promise<number> {
    let sent = 0;
    for (const mirror of mirrors) {
      try {
        sent += await backfillSlot(db, mirror);
      } catch (err) {
        log.warn('mirror: backfill stopped', { code: codeOf(err) });
      }
    }
    return sent;
  }

  return async function drainQueued(): Promise<number> {
    const db = database();
    if (!db) return 0;
    await expireClaims(db);
    await lookUpUncertain(db);
    const mirrors = mirrorRows(db);
    await queueUnpublished(db, mirrors);
    return (await sendQueued(db)) + (await backfillSlots(db, mirrors));
  };
}
