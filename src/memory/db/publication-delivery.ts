// The delivery state of a publication (schema v27), the writes and reads the diary's mirrors share. A publisher takes a
// row through the writer before anything goes out: `claim` moves it to `sending` with a claimant and a time, and only one
// claimant wins. An entry goes out as segments (one send each: the voice, each of her messages, each message of
// pictures), and `delivery` on the row keeps per segment its status, its idempotency key and the ids it became, so a
// retry resumes at the segment that stopped and a crash forgets nothing already posted.
//
//   claim      `queued`, `failed` or `incomplete` to `sending`; the segments keep what they already hold
//   segment    one segment went out; its receipt is kept and the claim is renewed
//   settle     the claimant's end: `sent` with the flat receipts every other reader takes, `failed` with its code and
//              whether a retry can help, or `unknown` when nobody knows what reached the platform
//   hold       `failed` or `incomplete` before any claim: nothing went out
//   expire     a claim past its lease becomes `unknown`: the publisher is gone and may have sent the segment it held
//   lookup     an adapter answered for the uncertain segment: found, it is sent; absent, it may go out again
//   reconcile  the owner: these entries already count as published on this place (a row without one is written)
//   absent     the owner: this uncertain send never arrived, so it is queued again
//
// A stored `unknown` is what `publicationState` calls `uncertain`. Every write is one transaction of the one writer
// (session-write.ts, kind `publication`).

import { projectRow } from './graph.ts';
import { contentHash, idOfKey, mirrorReceipts, publicationKey } from './publish.ts';
import { dbOf, isFiniteNumber, transactionOf } from './types.ts';
import type { Connection, Db, Row } from './types.ts';

export type SegmentStatus = 'sent' | 'failed' | 'uncertain' | 'pending';

/** One send of an entry to one place, as the row keeps it. */
export type StoredSegment = {
  segment: number;
  status: SegmentStatus;
  key: string;
  messageIds: Array<string>;
  attachmentIds: Array<string>;
};

/** What `delivery` holds: the entry's messages as first sent, so a retry cuts the same segments, and the segments. */
export type StoredDelivery = {
  messages?: ReadonlyArray<string>;
  mentions?: ReadonlyArray<ReadonlyArray<string>>;
  segments: Array<StoredSegment>;
};

/** A publication as `publicationState` answers it: `unknown` reads `uncertain`. */
export type PublicationState = {
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'incomplete' | 'uncertain';
  code: string | null;
  segments: Array<{ segment: number; status: SegmentStatus; messageIds: Array<string>; attachmentIds: Array<string> }>;
  reconciledBy: string | null;
  outsideAudience: boolean;
};

const CLAIMABLE: ReadonlyArray<string> = ['queued', 'failed', 'incomplete'];

const words = (value: unknown): Array<string> =>
  Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string' && one !== '') : [];

const isoOf = (ms: unknown): string => new Date(isFiniteNumber(ms) ? ms : Date.now()).toISOString();

/** The `delivery` of a row, with no segment when it has none or it cannot be read. */
export function deliveryOf(row: Row | null | undefined): StoredDelivery {
  try {
    const parsed: unknown = typeof row?.delivery === 'string' ? JSON.parse(row.delivery) : null;
    const delivery = parsed as Partial<StoredDelivery> | null;
    if (delivery && Array.isArray(delivery.segments)) return { ...delivery, segments: delivery.segments };
  } catch {
    // An unreadable delivery holds nothing a retry could trust.
  }
  return { segments: [] };
}

/** The row that publishes `entryId` to `placeId`: a sent one first, since a legacy key can leave a second row. */
export function publicationFor(handle: Connection, entryId: string, placeId: string): Row | null {
  return (
    dbOf(handle)
      .prepare(
        `SELECT * FROM publications WHERE row_kind = 'diary' AND row_id = ? AND destination_place_id = ?
          AND retired_at IS NULL ORDER BY status = 'sent' DESC, created_at, id LIMIT 1`
      )
      .get(entryId, placeId) ?? null
  );
}

/** The receipts of a row with no segments (a legacy mirror's) as one segment, split into messages and attachments. */
function segmentsOfReceipts(row: Row): PublicationState['segments'] {
  let receipts: Array<{ kind?: unknown; key?: unknown }> = [];
  try {
    const parsed: unknown = typeof row.receipts === 'string' ? JSON.parse(row.receipts) : [];
    if (Array.isArray(parsed)) receipts = parsed as typeof receipts;
  } catch {
    receipts = [];
  }
  if (receipts.length === 0) return [];
  const keysOf = (attachment: boolean): Array<string> =>
    words(receipts.filter((one) => (one.kind === 'attachment') === attachment).map((one) => one.key));
  return [{ segment: 0, status: 'sent', messageIds: keysOf(false), attachmentIds: keysOf(true) }];
}

/** A publication row as its state. `outsideAudience` is false until an entry carries an audience. */
export function stateOfRow(row: Row): PublicationState {
  const stored = deliveryOf(row).segments;
  return {
    status: (row.status === 'unknown' ? 'uncertain' : row.status) as PublicationState['status'],
    code: typeof row.code === 'string' ? row.code : null,
    segments:
      stored.length > 0
        ? stored.map(({ segment, status, messageIds, attachmentIds }) => ({
            segment,
            status,
            messageIds,
            attachmentIds,
          }))
        : segmentsOfReceipts(row),
    reconciledBy: typeof row.reconciled_by === 'string' ? row.reconciled_by : null,
    outsideAudience: false,
  };
}

const rowById = (db: Db, id: unknown): Row | undefined =>
  db.prepare('SELECT * FROM publications WHERE id = ?').get(String(id));

/** The flat receipts of the row's segments: every message, then every attachment. */
function receiptsOf(db: Db, row: Row, segments: ReadonlyArray<StoredSegment>): string {
  const place = db.prepare('SELECT iface FROM places WHERE id = ?').get(String(row.destination_place_id));
  const iface = typeof place?.iface === 'string' ? place.iface : '';
  const messages = mirrorReceipts(
    iface,
    segments.flatMap((one) => one.messageIds)
  );
  const authority = mirrorReceipts(iface, ['x'])[0]?.authority ?? iface;
  const attachments = segments.flatMap((one) =>
    one.attachmentIds.map((key) => ({ authority, kind: 'attachment', key }))
  );
  return JSON.stringify([...messages, ...attachments]);
}

/** The columns of `row` set to `fields`, in the caller's transaction, and the row projected when its status moved. */
function update(db: Db, row: Row, fields: Row): Row {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE publications SET ${cols.map((col) => `"${col}" = ?`).join(', ')} WHERE id = ?`).run(
    ...cols.map((col) => fields[col]),
    row.id
  );
  if (fields.status !== undefined && fields.status !== row.status)
    projectRow(db, 'publications', { id: String(row.id) });
  return rowById(db, row.id) ?? row;
}

/** The segments a claim leaves: as many as the plan has, each keeping what it holds, a failed one pending again. */
function claimedSegments(row: Row, count: number): Array<StoredSegment> {
  const stored = deliveryOf(row).segments;
  const key = typeof row.idempotency_key === 'string' ? row.idempotency_key : String(row.id);
  return Array.from({ length: count }, (_, segment): StoredSegment => {
    const held = stored[segment];
    if (held) return { ...held, status: held.status === 'sent' ? 'sent' : 'pending' };
    return { segment, status: 'pending', key: `${key}:${segment}`, messageIds: [], attachmentIds: [] };
  });
}

function claim(db: Db, update_: Row): { ok: true; delivery: StoredDelivery } | { ok: false } {
  const row = rowById(db, update_.id);
  if (!row || !CLAIMABLE.includes(String(row.status))) return { ok: false };
  const stored = deliveryOf(row);
  const delivery: StoredDelivery = {
    messages: stored.messages ?? (Array.isArray(update_.messages) ? (update_.messages as Array<string>) : []),
    ...(stored.mentions || Array.isArray(update_.mentions)
      ? { mentions: stored.mentions ?? (update_.mentions as Array<Array<string>>) }
      : {}),
    segments: claimedSegments(row, Number(update_.count)),
  };
  update(db, row, {
    status: 'sending',
    claimed_by: String(update_.claimant),
    claimed_at: Number(update_.now),
    code: null,
    retryable: null,
    delivery: JSON.stringify(delivery),
    ...(update_.paced === true ? { paced: 1 } : {}),
  });
  return { ok: true, delivery };
}

/** Whether `claimant` still holds the row. A publisher whose claim expired keeps no right to go on sending. */
const holds = (row: Row, claimant: unknown): boolean => row.status === 'sending' && row.claimed_by === claimant;

function segment(db: Db, given: Row): { held: boolean } {
  const row = rowById(db, given.id);
  // A late receipt of the claimant is a proof even after its claim expired, so it is kept, and the sending stops.
  if (!row || row.claimed_by !== given.claimant) return { held: false };
  const delivery = deliveryOf(row);
  const one = delivery.segments[Number(given.segment)];
  if (one) {
    one.status = 'sent';
    one.messageIds = words(given.messageIds);
    one.attachmentIds = words(given.attachmentIds);
  }
  const renewed = holds(row, given.claimant) ? { claimed_at: Number(given.now) } : {};
  update(db, row, { delivery: JSON.stringify(delivery), ...renewed });
  return { held: holds(row, given.claimant) };
}

function settle(db: Db, given: Row): Row | null {
  const row = rowById(db, given.id);
  if (!row || row.claimed_by !== given.claimant) return null;
  const delivery = deliveryOf(row);
  if (given.status === 'sent') {
    if (row.status !== 'sending' && row.status !== 'unknown') return row;
    if (row.content_hash === null && typeof given.rendered === 'string')
      update(db, row, { rendered: given.rendered, content_hash: contentHash(given.rendered) });
    return update(db, row, {
      status: 'sent',
      receipts: receiptsOf(db, row, delivery.segments),
      sent_at: isoOf(given.now),
      code: null,
      retryable: null,
    });
  }
  if (!holds(row, given.claimant)) return row;
  const stopped = delivery.segments[Number(given.segment)];
  if (stopped) {
    stopped.status = given.status === 'failed' ? 'failed' : 'uncertain';
    stopped.messageIds = words(given.messageIds);
  }
  return update(db, row, {
    status: given.status === 'failed' ? 'failed' : 'unknown',
    code: typeof given.code === 'string' ? given.code : null,
    retryable: given.status === 'failed' ? (given.retryable === true ? 1 : 0) : null,
    delivery: JSON.stringify(delivery),
  });
}

function hold(db: Db, given: Row): Row | null {
  const row = rowById(db, given.id);
  if (!row || !CLAIMABLE.includes(String(row.status))) return row ?? null;
  return update(db, row, {
    status: given.status === 'incomplete' ? 'incomplete' : 'failed',
    code: typeof given.code === 'string' ? given.code : null,
    retryable: given.retryable === true ? 1 : 0,
    ...(given.paced === true ? { paced: 1 } : {}),
  });
}

function expire(db: Db, given: Row): Row | null {
  const row = rowById(db, given.id);
  if (!row || row.status !== 'sending') return row ?? null;
  // A clock that moved back makes the age negative: the claim stands.
  if (Number(given.now) - Number(row.claimed_at) <= Number(given.leaseMs)) return row;
  const delivery = deliveryOf(row);
  const inFlight = delivery.segments.find((one) => one.status !== 'sent');
  if (inFlight) inFlight.status = 'uncertain';
  return update(db, row, { status: 'unknown', code: 'claim-expired', delivery: JSON.stringify(delivery) });
}

/** The uncertain segment of `row` back to pending and the row queued, or the row sent when nothing else is left. */
function lookup(db: Db, given: Row): Row | null {
  const row = rowById(db, given.id);
  if (!row || row.status !== 'unknown') return row ?? null;
  const delivery = deliveryOf(row);
  const uncertain = delivery.segments.find((one) => one.status === 'uncertain');
  if (!uncertain) return row;
  const found = words(given.found);
  uncertain.status = found.length > 0 ? 'sent' : 'pending';
  uncertain.messageIds = found;
  const stored = JSON.stringify(delivery);
  if (delivery.segments.every((one) => one.status === 'sent'))
    return update(db, row, {
      status: 'sent',
      receipts: receiptsOf(db, row, delivery.segments),
      sent_at: isoOf(given.now),
      code: null,
      delivery: stored,
    });
  return update(db, row, { status: 'queued', code: null, delivery: stored });
}

/** The owner's mark: every entry of `entries` counts as published on the place. A row already sent keeps its receipts. */
function reconcile(db: Db, given: Row): { recorded: number; kept: number } {
  const placeId = String(given.placeId);
  const by = String(given.by);
  const at = isoOf(given.now);
  let recorded = 0;
  let kept = 0;
  for (const entryId of words(given.entries)) {
    const row = publicationFor(db, entryId, placeId);
    if (row?.status === 'sent') {
      kept += 1;
      continue;
    }
    recorded += 1;
    const delivery = deliveryOf(row);
    if (row) {
      update(db, row, {
        status: 'sent',
        receipts: receiptsOf(db, row, delivery.segments),
        sent_at: at,
        code: null,
        retryable: null,
        reconciled_by: by,
        reconciled_at: at,
      });
      continue;
    }
    const text = db.prepare('SELECT text FROM diary WHERE id = ?').get(entryId)?.text;
    const rendered = typeof text === 'string' ? text : null;
    const key = publicationKey('diary', entryId, placeId);
    const id = idOfKey(key);
    db.prepare(
      `INSERT INTO publications (id, row_kind, row_id, content_hash, rendered, destination_place_id, status, idempotency_key,
         receipts, created_at, sent_at, reconciled_by, reconciled_at)
       VALUES (?, 'diary', ?, ?, ?, ?, 'sent', ?, '[]', ?, ?, ?, ?)`
    ).run(id, entryId, rendered === null ? null : contentHash(rendered), rendered, placeId, key, at, at, by, at);
    projectRow(db, 'publications', { id });
  }
  return { recorded, kept };
}

/** The owner's word that uncertain sends never arrived: each is queued again, its uncertain segment pending. */
function absent(db: Db, given: Row): { requeued: number } {
  const by = String(given.by);
  let requeued = 0;
  for (const entryId of words(given.entries)) {
    const row = publicationFor(db, entryId, String(given.placeId));
    if (row?.status !== 'unknown') continue;
    const delivery = deliveryOf(row);
    for (const one of delivery.segments) if (one.status === 'uncertain') one.status = 'pending';
    update(db, row, {
      status: 'queued',
      code: null,
      delivery: JSON.stringify(delivery),
      reconciled_by: by,
      reconciled_at: isoOf(given.now),
    });
    requeued += 1;
  }
  return { requeued };
}

const OPERATIONS: Readonly<Record<string, (db: Db, given: Row) => unknown>> = {
  claim,
  segment,
  settle,
  hold,
  expire,
  lookup,
  reconcile,
  absent,
};

/** Whether `op` is one of the delivery writes above. */
export const isDeliveryOp = (op: unknown): boolean => typeof op === 'string' && Object.hasOwn(OPERATIONS, op);

/** One delivery write on the writer connection (see the head of this file). Answers what the operation answers. */
export function applyDeliveryWrite(handle: Connection, given: unknown): unknown {
  const update_ = (given ?? {}) as Row;
  const operation = OPERATIONS[String(update_.op)];
  if (!operation)
    throw Object.assign(new Error('memory db: unknown publication delivery write'), { code: 'BAD_UPDATE' });
  const db = dbOf(handle);
  return transactionOf(handle)(() => operation(db, update_));
}
