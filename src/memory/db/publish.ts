// Publications (spec 2026-10-24-memory-schema-v7, sections 2 and 6; section 11 item 4 overrides them): every outward
// send of something she made in her memory (a diary entry first) is a `publications` row with its exact rendered text,
// the content hash of that text, the destination place, the execution context it is sent in, the grant that allowed it
// (if one was needed), its state (`queued` | `sending` | `sent` | `failed` | `incomplete` | `unknown`), an idempotency key
// and the interface's receipts. Schema v10 and v27; publication-delivery.ts holds the claim and the segments of a send.
//
// A `diary` row to a place with an enabled diary mirror (schema v15, `mirrors`) needs no grant row: the mirror the owner
// set up is his standing grant for every entry to that place.
//
// The rule (item 4): an outward act opens a destination context and publishes only what that context produced, or
// what the owner granted. A text produced in an internal context (an internal wake) is publishable only through an
// unrevoked `publication_grants` row that binds this very content hash to this very destination; an edit changes the
// hash and needs a new grant. Contexts are the core's own objects (scope.ts#issueContext), never tool arguments, and
// `recheck` checks a queued row again at send time.
//
//   preparePublication(handle, { context, rowKind, rowId, rendered, destination, producedIn, idempotencyKey?, pending?, now? })
//       refuses with a code and writes nothing when the context is not outward (`not-outward`), its destination is not
//       the publication's (`destination-mismatch`), a diary row refuses the place (storedDiaryPublicationRefusal), or the text was produced elsewhere (an internal context, or an
//       outward context of another destination) and no grant binds its hash to this destination (`no-grant`).
//       Otherwise writes one `queued` row. The idempotency key (by default `<row kind>:<row id>:<destination>`) is
//       unique: a second call with the same key returns the first row (`reused: true`) and writes nothing, so a crash
//       between queueing and sending never sends twice.
//       `pending` queues it with no content yet (an entry she is still writing): the `sent` write fills it once.
//   markSent / markFailed / markUnknown / reconcile   the send's outcome. `unknown` is a send whose outcome a crash
//       or a timeout hid; `reconcile(handle, id, found)` makes it `sent` with the receipts found, never sending again,
//       or `failed` when the interface has no trace of it.
//   grantPublication / revokeGrant   the owner's exceptions; a grant is immutable but for its revocation.
// The diary's mirrors (`diary_mirrors`, written by the sync from diary.json) derive their publication rows here too
// (`deriveMirrorPublication`), on the one path every mirror write takes (the sync, rows.ts#insertRows, the v10
// migration), so a remap keeps the row and never makes a second one.
//
// `assignDiaryDestination` gives the diary's publications that name no destination the deployment's diary channel (the
// v12 data step for the legacy mirrors, and the diary writer under authority `db`, unit-write.ts).
// Every write projects the publication into the graph in the same transaction (graph.ts#projectRow). No live writer
// uses preparePublication but the diary's mirrors (src/behavior/mirror.ts); the legacy diary posts derive their
// `sent` publications on the diary's own write like the sync (unit-write.ts). Logs: none; a caller logs codes.

import { createHash } from 'node:crypto';
import { ownershipRow, hasStorageUnits, ownershipSql } from './storage-units.ts';

import { diaryMetadataOf, diaryPublicationRefusal } from '../../tools/publication.ts';

import { audienceRefusal } from './diary-audience.ts';
import { legacyNativeKind, nativeAuthorityOf } from './ids.ts';
import { contextRow } from './scope.ts';
import { projectRow } from './graph.ts';
import { dbOf, transactionOf, asText, isFiniteNumber } from './types.ts';
import type { Connection, Db, Row } from './types.ts';
import type { Context } from './scope.ts';

const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isoOf = (now: (() => number) | number): string =>
  new Date(typeof now === 'function' ? now() : Number.isFinite(now) ? now : Date.now()).toISOString();
const refused = (code: string): { ok: false; code: string } => ({ ok: false, code });

/** The content hash of a rendered text: 64 hex digits of SHA-256 over its UTF-8 bytes. */
export const contentHash = (text: unknown): string => createHash('sha256').update(String(text), 'utf8').digest('hex');

/** The default idempotency key of a publication: `<row kind>:<row id>:<destination>` (the diary's mirrors use the same). */
export const publicationKey = (rowKind: unknown, rowId: unknown, destination: unknown): string =>
  `${asText(rowKind)}:${asText(rowId)}:${asText(destination ?? '')}`;

/** A publication id from its idempotency key (a mirror's publication keeps the mirror's id). */
export const idOfKey = (key: string): string =>
  `pub:${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32)}`;

const hasTable = new WeakMap<Db, boolean>();
/** Whether the database has the publication tables (schema v10). */
export function hasPublications(handle: Connection): boolean {
  const db = dbOf(handle);
  let has = hasTable.get(db);
  if (has === undefined) {
    has =
      db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'publications'").get() !==
      undefined;
    hasTable.set(db, has);
  }
  return has;
}

/** A publication row as stored (receipts parsed). */
/** A publication row as stored, its receipts parsed. */
export type Publication = Row & { id: string };

function rowOf(row: Row | undefined): Publication | null {
  if (!row) return null;
  let receipts: unknown = null;
  try {
    receipts = row.receipts === null || row.receipts === undefined ? null : JSON.parse(asText(row.receipts));
  } catch {
    receipts = null;
  }
  return { ...row, id: row.id as string, receipts };
}

/** The publication of an id, or null. */
export function publicationOf(handle: Connection, id: string): Publication | null {
  return rowOf(dbOf(handle).prepare('SELECT * FROM publications WHERE id = ?').get(String(id)));
}

/** The publication of an idempotency key, or null. */
export function publicationByKey(handle: Connection, key: string): Publication | null {
  return rowOf(dbOf(handle).prepare('SELECT * FROM publications WHERE idempotency_key = ?').get(String(key)));
}

/**
 * The unrevoked grant that binds `hash` of the row to `destination`, or null. A grant for another destination, another
 * hash (an edited text) or a revoked one does not count.
 */
export function grantFor(
  handle: Connection,
  { rowKind, rowId, hash, destination }: { rowKind: unknown; rowId: unknown; hash: unknown; destination: unknown }
): unknown {
  return (
    dbOf(handle)
      .prepare(
        `SELECT g.id FROM publication_grants g
     WHERE g.row_kind = ? AND g.row_id = ? AND g.content_hash = ? AND g.revoked_at IS NULL
       AND EXISTS (SELECT 1 FROM json_each(g.destinations) d WHERE d.value = ?)
     ORDER BY g.approved_at, g.id LIMIT 1`
      )
      .get(String(rowKind), String(rowId), String(hash), String(destination))?.id ?? null
  );
}

/**
 * What the stored row says against sending a diary entry to a place, whatever a caller carries and whatever grant
 * exists: its saved restriction (`not-allowed`), then the audience she chose or what an old row reads as
 * (`audience-excluded`, `audience-invalid`, diary-audience.ts). Null when it may go.
 */
export function storedDiaryPublicationRefusal(handle: Connection, rowId: unknown, destination: unknown): string | null {
  const db = dbOf(handle);
  const row = db.prepare('SELECT extra, scope_kind, scope_iface FROM diary WHERE id = ?').get(String(rowId));
  const boundary = diaryMetadataOf(row?.extra).publicationBoundary;
  if (boundary !== undefined) {
    const place = db.prepare('SELECT iface, native_id FROM places WHERE id = ?').get(String(destination));
    const refusal = diaryPublicationRefusal(boundary, {
      iface: typeof place?.iface === 'string' ? place.iface : '',
      conversationId: typeof place?.native_id === 'string' ? place.native_id : '',
    });
    if (refusal) return refusal.code;
  }
  return audienceRefusal(db, row, String(destination));
}

/**
 * Whether the owner set up an enabled `diary` mirror of `destination` (schema v15): his standing grant for every diary
 * entry to that place. A disabled mirror, or a database before v15, grants nothing.
 */
function mirroredTo(db: Db, destination: unknown): boolean {
  const table = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'mirrors'").get();
  if (table === undefined) return false;
  return (
    db
      .prepare("SELECT 1 AS ok FROM mirrors WHERE row_kind = 'diary' AND place_id = ? AND enabled = 1 LIMIT 1")
      .get(String(destination)) !== undefined
  );
}

/** Where the text came from: `internal` (an internal context, or none named: fail closed) or the outward destination. */
function producedOf(producedIn: unknown): { outward?: string; internal?: true } {
  if (producedIn && typeof producedIn === 'object') {
    const given = producedIn as Row;
    return given.mode === 'outward' && filled(given.destination) ? { outward: given.destination } : { internal: true };
  }
  return { internal: true };
}

/**
 * The checks of an outward send in a context (see the head of this file); null when it may go, else the refusal code.
 * `producedIn` is the context the text was generated in (an issued context object; anything else counts as internal).
 */
function sendRefusal(
  db: Db,
  {
    context,
    rowKind,
    rowId,
    hash,
    destination,
    producedIn,
  }: { context: unknown; rowKind: unknown; rowId: unknown; hash: unknown; destination: unknown; producedIn: unknown }
): { code: string | null; grant?: unknown } {
  if (
    !context ||
    typeof context !== 'object' ||
    (context as Context).mode !== 'outward' ||
    (context as Context).internal === true ||
    !filled((context as Context).id)
  )
    return { code: 'not-outward' };
  if (!filled(destination) || (context as Context).destination !== destination) return { code: 'destination-mismatch' };
  if (rowKind === 'diary') {
    const restriction = storedDiaryPublicationRefusal(db, rowId, destination);
    if (restriction) return { code: restriction };
  }
  const produced = producedOf(producedIn);
  if (produced.outward === destination) return { code: null, grant: null };
  if (rowKind === 'diary' && mirroredTo(db, destination)) return { code: null, grant: null };
  const grant = grantFor(db, { rowKind, rowId, hash, destination });
  return grant ? { code: null, grant } : { code: 'no-grant' };
}

/** The `execution_contexts` row of an issued context, when missing (the service records contexts deferred). */
function ensureContext(db: Db, ctx: Context): void {
  const row = contextRow(ctx);
  db.prepare(
    `INSERT OR IGNORE INTO execution_contexts (id, mode, iface, destination_place_id, partner_person_id, policy_version, issued_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.mode,
    row.iface,
    row.destination_place_id,
    row.partner_person_id,
    row.policy_version,
    row.issued_at ?? new Date(0).toISOString()
  );
}

/**
 * Queues one outward publication, or refuses (see the head of this file). Returns `{ ok: true, publication, reused }`
 * or `{ ok: false, code }` (`bad-input`, `not-outward`, `destination-mismatch`, `no-grant`, `no-place`). `handle` is an
 * `openMemoryDb` handle (the writer).
 */
/** What `preparePublication` takes: the context the send is made in, the row, its rendered text and the destination. */
export type PublicationInput = {
  context?: unknown;
  rowKind?: unknown;
  rowId?: unknown;
  rendered?: unknown;
  destination?: unknown;
  producedIn?: unknown;
  idempotencyKey?: unknown;
  pending?: boolean;
  now?: (() => number) | number;
};

export function preparePublication(
  handle: Connection,
  {
    context,
    rowKind,
    rowId,
    rendered,
    destination,
    producedIn = null,
    idempotencyKey = null,
    pending = false,
    now = Date.now,
  }: PublicationInput = {}
): { ok: true; publication: Publication | null; reused: boolean } | { ok: false; code: string } {
  const db = dbOf(handle);
  if (!filled(rowKind) || !filled(rowId) || (typeof rendered !== 'string' && !pending)) return refused('bad-input');
  // A pending publication (an entry she is still writing) has no content yet: its send fills it (fillContent).
  const hash = pending ? null : contentHash(rendered);
  const check = sendRefusal(db, { context, rowKind, rowId, hash, destination, producedIn });
  if (check.code) return refused(check.code);
  const key = filled(idempotencyKey) ? idempotencyKey : publicationKey(rowKind, rowId, destination);
  return transactionOf(handle)(
    (): { ok: true; publication: Publication | null; reused: boolean } | { ok: false; code: string } => {
      const existing = publicationByKey(db, key);
      if (existing) return { ok: true, publication: existing, reused: true };
      if (!db.prepare('SELECT 1 AS ok FROM places WHERE id = ?').get(destination)) return refused('no-place');
      ensureContext(db, context as Context);
      const id = idOfKey(key);
      db.prepare(
        ownershipSql(
          db,
          `INSERT INTO publications (id, row_kind, row_id, content_hash, rendered, destination_place_id, context_id, grant_id, status, idempotency_key, receipts, created_at, sent_at, owner_key, retired_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, ?, NULL, NULL, NULL)`
        )
      ).run(
        id,
        rowKind,
        rowId,
        hash,
        pending ? null : rendered,
        destination,
        (context as Context).id,
        check.grant ?? null,
        key,
        isoOf(now)
      );
      projectRow(db, 'publications', { id });
      return { ok: true, publication: publicationOf(db, id), reused: false };
    }
  );
}

const STILL_TO_SEND: ReadonlyArray<string> = ['queued', 'unknown', 'failed', 'incomplete'];

/**
 * The checks of a publication still to send (queued, unknown, or failed or incomplete and due again) again, at send time, in the context the sender holds now: the context
 * must still be outward for this destination, and a grant the row was queued under must still be unrevoked. Returns
 * `{ ok: true }` or `{ ok: false, code }` (`missing`, `not-pending`, `not-outward`, `destination-mismatch`, `grant-revoked`).
 */
export function recheck(
  handle: Connection,
  id: string,
  contextGiven: unknown
): { ok: true } | { ok: false; code: string } {
  const context = contextGiven as Row | null | undefined;
  const row = publicationOf(handle, id);
  if (!row) return refused('missing');
  if (!STILL_TO_SEND.includes(row.status as string)) return refused('not-pending');
  if (!context || context.mode !== 'outward' || context.internal === true || !filled(context.id))
    return refused('not-outward');
  if (context.destination !== row.destination_place_id) return refused('destination-mismatch');
  if (row.row_kind === 'diary') {
    const restriction = storedDiaryPublicationRefusal(handle, row.row_id, row.destination_place_id);
    if (restriction) return refused(restriction);
  }
  if (row.grant_id) {
    const grant = dbOf(handle)
      .prepare('SELECT revoked_at, content_hash FROM publication_grants WHERE id = ?')
      .get(row.grant_id);
    if (!grant || grant.revoked_at !== null || grant.content_hash !== row.content_hash) return refused('grant-revoked');
  }
  return { ok: true };
}

/** Moves a publication to `status` from one of `from`; returns the row after it (unchanged when it was not in `from`). */
function move(
  handle: Connection,
  id: string,
  status: string,
  from: ReadonlyArray<string>,
  fields: Row = {}
): Publication | null {
  const db = dbOf(handle);
  return transactionOf(handle)(() => {
    const row = publicationOf(db, id);
    if (!row) return null;
    if (!from.includes(row.status as string)) return row;
    const cols = Object.keys(fields);
    db.prepare(`UPDATE publications SET status = ?${cols.map((col) => `, "${col}" = ?`).join('')} WHERE id = ?`).run(
      status,
      ...cols.map((col) => fields[col]),
      row.id
    );
    projectRow(db, 'publications', { id: row.id });
    return publicationOf(db, String(row.id));
  });
}

const receiptsText = (receipts: unknown): string =>
  JSON.stringify(Array.isArray(receipts) ? receipts : receipts === null || receipts === undefined ? [] : [receipts]);

/**
 * The content of a publication queued `pending`, set once as it is sent; a publication with content keeps it.
 */
function fillContent(handle: Connection, id: string, rendered: string): void {
  const db = dbOf(handle);
  const sql = 'UPDATE publications SET rendered = ?, content_hash = ? WHERE id = ? AND content_hash IS NULL';
  db.prepare(sql).run(rendered, contentHash(rendered), String(id));
}

/**
 * The send went out: `sent` with the interface's receipts (`[{ authority, kind, key }]`, the native objects it became)
 * and the time. A row already sent stays as it is (a repeat changes nothing).
 */
export const markSent = (
  handle: Connection,
  id: string,
  receipts: unknown,
  { now = Date.now }: { now?: (() => number) | number } = {}
): Publication | null =>
  move(handle, id, 'sent', ['queued', 'unknown', 'failed'], { receipts: receiptsText(receipts), sent_at: isoOf(now) });
/** The send failed for certain (the interface said no): `failed`. */
export const markFailed = (handle: Connection, id: string): Publication | null =>
  move(handle, id, 'failed', ['queued', 'unknown']);
/** The send's outcome is not known (a crash, a timeout): `unknown`, to reconcile before anything is sent again. */
export const markUnknown = (handle: Connection, idGiven: unknown): Row | null => {
  const id = idGiven as string;
  return move(handle, id, 'unknown', ['queued']);
};

/**
 * An `unknown` publication looked up at the interface: `found` (its receipts, or null / an empty list when nothing was
 * found). Found: `sent` with those receipts, never sent again. Not found: `failed`. Any other state is left alone.
 */
export function reconcile(
  handle: Connection,
  idGiven: unknown,
  found: unknown,
  { now = Date.now }: { now?: (() => number) | number } = {}
): Row | null {
  const id = idGiven as string;
  const any = Array.isArray(found) ? found.length > 0 : found !== null && found !== undefined;
  return any
    ? move(handle, id, 'sent', ['unknown'], { receipts: receiptsText(found), sent_at: isoOf(now) })
    : move(handle, id, 'failed', ['unknown']);
}

/** The publications not settled yet (`queued` or `unknown`), oldest first: what a restart reconciles before sending. */
export function unsettled(handle: Connection): Array<Publication | null> {
  return dbOf(handle)
    .prepare(
      "SELECT * FROM publications WHERE status IN ('queued', 'unknown') AND retired_at IS NULL ORDER BY created_at, id"
    )
    .all()
    .map(rowOf);
}

/**
 * The owner's grant: this content hash of this row may be published to these destinations (place ids). Returns the
 * grant id. `approvedBy` is required (the owner's account or person).
 */
export function grantPublication(
  handle: Connection,
  {
    rowKind,
    rowId,
    hash,
    destinations,
    approvedBy,
    reason = null,
    now = Date.now,
    id = null,
  }: {
    rowKind: unknown;
    rowId: unknown;
    hash: unknown;
    destinations: unknown;
    approvedBy: unknown;
    reason?: string | null;
    now?: (() => number) | number;
    id?: string | null;
  }
): string {
  const db = dbOf(handle);
  const places = [...new Set((Array.isArray(destinations) ? destinations : []).filter(filled))].sort();
  if (!filled(rowKind) || !filled(rowId) || !filled(hash) || places.length === 0 || !filled(approvedBy))
    throw Object.assign(new Error('memory db: a grant needs a row, a hash, destinations and who approved it'), {
      code: 'BAD_GRANT',
    });
  const at = isoOf(now);
  const grantId = filled(id)
    ? id
    : `grant:${createHash('sha256')
        .update(JSON.stringify([rowKind, rowId, hash, places, approvedBy, at]), 'utf8')
        .digest('hex')
        .slice(0, 32)}`;
  transactionOf(handle)(() => {
    db.prepare(
      `INSERT INTO publication_grants (id, row_kind, row_id, content_hash, destinations, approved_by, approved_at, reason, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    ).run(grantId, rowKind, rowId, hash, JSON.stringify(places), approvedBy, at, reason);
  });
  return grantId;
}

/** Revokes a grant (once; a revoked grant stays revoked). Returns true when it was revoked now. */
export function revokeGrant(
  handle: Connection,
  id: string,
  { now = Date.now }: { now?: (() => number) | number } = {}
): boolean {
  const db = dbOf(handle);
  return transactionOf(handle)(
    () =>
      Number(
        db
          .prepare('UPDATE publication_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
          .run(isoOf(now), String(id)).changes
      ) > 0
  );
}

/**
 * One write of the diary's mirrors on the writer connection (session-write.ts, kind `publication`): `prepare` queues
 * a publication (`input`: preparePublication's), `sent` marks it with its `receipts`, `failed` and `unknown` mark it.
 * Returns what the call it names returns. `handle` is an `openMemoryDb` handle (the writer) and `given` is
 * `{ op, id?, input?, receipts?, now? }`.
 */
export function applyPublicationWrite(handle: Connection, given: unknown): unknown {
  const update = (given ?? {}) as {
    op?: unknown;
    id?: unknown;
    input?: PublicationInput;
    receipts?: Array<object>;
    rendered?: unknown;
    now?: unknown;
  };
  const now = isFiniteNumber(update.now) ? update.now : Date.now();
  const id = String(update.id);
  if (update.op === 'prepare') return preparePublication(handle, { ...(update.input ?? {}), now });
  if (update.op === 'sent') {
    // A publication queued while its entry was still being written gets its content as it was sent (`pending`).
    if (typeof update.rendered === 'string') fillContent(handle, id, update.rendered);
    return markSent(handle, id, update.receipts ?? [], { now });
  }
  if (update.op === 'failed') return markFailed(handle, id);
  if (update.op === 'unknown') return markUnknown(handle, id);
  throw Object.assign(new Error('memory db: a publication write names prepare, sent, failed or unknown'), {
    code: 'BAD_UPDATE',
  });
}

// ---------- the diary's mirrors ----------

/** The receipts of a mirror: one `{ authority, kind, key }` per native message id it names. */
export function mirrorReceipts(
  iface: string,
  nativeIds: unknown
): Array<{ authority: string; kind: 'message' | null; key: string }> {
  let ids = nativeIds;
  if (typeof ids === 'string') {
    try {
      ids = JSON.parse(ids);
    } catch {
      ids = [];
    }
  }
  const authority = nativeAuthorityOf(iface);
  const kind = legacyNativeKind(iface);
  return (Array.isArray(ids) ? ids : [])
    .filter((key): key is string => typeof key === 'string' && key !== '')
    .map((key) => ({ authority, kind, key }));
}

/**
 * The publication row a diary mirror derives (pure): the mirror's id, the diary entry, the entry's text and its hash
 * (null until the text is known), the mirror's place as the destination when that place exists, `sent` with the
 * mirror's message ids as receipts, the key `diary:<entry>:<place>`, the mirror's owner and retirement.
 */
export function mirrorPublicationRow(
  mirror: Row,
  { text = null, placeExists = false, at }: { text?: string | null; placeExists?: boolean; at: string }
): Row {
  const rendered = typeof text === 'string' ? text : null;
  return {
    id: mirror.id,
    row_kind: 'diary',
    row_id: mirror.diary_id,
    content_hash: rendered === null ? null : contentHash(rendered),
    rendered,
    destination_place_id: placeExists && filled(mirror.place_id) ? mirror.place_id : null,
    context_id: null,
    grant_id: null,
    status: 'sent',
    idempotency_key: publicationKey('diary', mirror.diary_id, mirror.place_id ?? ''),
    receipts: JSON.stringify(mirrorReceipts(String(mirror.iface), mirror.native_ids)),
    created_at: filled(mirror.posted_at) ? mirror.posted_at : at,
    sent_at: filled(mirror.posted_at) ? mirror.posted_at : null,
    owner_key: mirror.owner_key ?? null,
    retired_at: mirror.retired_at ?? null,
  };
}

/**
 * Writes the publication of a diary mirror (found by its id, or by its entry, interface and place as the sync keys it):
 * inserted once by its key; on a later write of the mirror the row follows it (receipts, owner, retirement, a
 * destination or a text that was not known before) and keeps its id, its content once known, and its state. A
 * publication the database wrote itself (no owner file) is never touched. `project: false` leaves the graph to the
 * caller (the migration). Returns the publication id, or null when there is no such mirror.
 */
export function deriveMirrorPublication(
  handle: Connection,
  mirror: Row | undefined,
  { at, project = true }: { at?: string; project?: boolean } = {}
): unknown {
  const db = dbOf(handle);
  if (!hasPublications(db)) return null;
  let found: Row | undefined;
  if (Number.isInteger(mirror?.rowid))
    found = db.prepare('SELECT * FROM diary_mirrors WHERE rowid = ?').get(mirror?.rowid);
  else if (filled(mirror?.id)) found = db.prepare('SELECT * FROM diary_mirrors WHERE id = ?').get(mirror.id);
  if (!found && filled(mirror?.diary_id)) {
    found = db
      .prepare(
        ownershipSql(
          db,
          "SELECT * FROM diary_mirrors WHERE diary_id = ? AND iface IS ? AND COALESCE(place_id, '') = ? ORDER BY owner_key IS NULL DESC, rowid LIMIT 1"
        )
      )
      .get(mirror.diary_id, mirror.iface ?? null, mirror.place_id ?? '');
  }
  if (!found || !filled(found.id) || !filled(found.diary_id)) return null;
  const text =
    (db.prepare('SELECT text FROM diary WHERE id = ?').get(found.diary_id)?.text as string | null | undefined) ?? null;
  const placeExists =
    filled(found.place_id) && db.prepare('SELECT 1 AS ok FROM places WHERE id = ?').get(found.place_id) !== undefined;
  const stamp = filled(at) ? at : new Date().toISOString();
  const row = mirrorPublicationRow(hasStorageUnits(db) ? found : { ...found, owner_key: found.owner_file }, {
    text,
    placeExists,
    at: stamp,
  });
  const existing = db
    .prepare(ownershipSql(db, 'SELECT id, owner_key FROM publications WHERE idempotency_key = ?'))
    .get(row.idempotency_key);
  if (!existing) {
    const stored = ownershipRow(db, row);
    const cols = Object.keys(stored);
    db.prepare(
      `INSERT INTO publications (${cols.map((col) => `"${col}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    ).run(...cols.map((col) => stored[col]));
  } else if ((hasStorageUnits(db) ? existing.owner_key : existing.owner_file) != null) {
    // Only the mirror's own publication follows it; the content is filled once, never rewritten (a trigger guards it).
    db.prepare(
      ownershipSql(
        db,
        `UPDATE publications SET receipts = ?, owner_key = ?, retired_at = ?,
        destination_place_id = COALESCE(destination_place_id, ?),
        rendered = CASE WHEN content_hash IS NULL THEN ? ELSE rendered END,
        content_hash = CASE WHEN content_hash IS NULL THEN ? ELSE content_hash END
      WHERE id = ?`
      )
    ).run(
      row.receipts,
      row.owner_key,
      row.retired_at,
      row.destination_place_id,
      row.rendered,
      row.content_hash,
      existing.id
    );
  } else {
    return existing.id;
  }
  const id = existing?.id ?? row.id;
  if (project) projectRow(db, 'publications', { id });
  return id;
}

/**
 * The deployment's diary channel as the destination of the diary's publications that name none (schema v12's data
 * step for the legacy mirrors, and every diary write under authority `db`, stage W2a): `placeId` (the channel's place)
 * is set on every `diary` publication without a destination (of the unit `owner` only, when given), when that place is
 * stored; nothing else of a publication changes. Returns how many were set.
 */
export function assignDiaryDestination(
  handle: Connection,
  placeId: string,
  { owner = null, at, project = true }: { owner?: string | null; at?: string; project?: boolean } = {}
): number {
  const db = dbOf(handle);
  if (!hasPublications(db) || !filled(placeId)) return 0;
  if (db.prepare('SELECT 1 AS ok FROM places WHERE id = ?').get(placeId) === undefined) return 0;
  const ids = db
    .prepare(
      ownershipSql(
        db,
        `UPDATE publications SET destination_place_id = ? WHERE row_kind = 'diary' AND destination_place_id IS NULL${filled(owner) ? ' AND owner_key = ?' : ''} RETURNING id`
      )
    )
    .all(...(filled(owner) ? [placeId, owner] : [placeId]))
    .map((row) => row.id);
  if (project) for (const id of ids) projectRow(db, 'publications', { id }, { at });
  return ids.length;
}

/** Every mirror's publication (the v10 migration; idempotent). Returns how many mirrors were looked at. */
export function deriveAllMirrorPublications(
  handle: Connection,
  { at, project = true }: { at?: string; project?: boolean } = {}
): number {
  const db = dbOf(handle);
  const rows = db
    .prepare('SELECT rowid AS rowid FROM diary_mirrors WHERE id IS NOT NULL AND diary_id IS NOT NULL ORDER BY rowid')
    .all();
  for (const row of rows) deriveMirrorPublication(db, { rowid: row.rowid }, { at, project });
  return rows.length;
}

/**
 * The publications whose receipts name a line of hers that was just stored (a mirror written before its line), projected
 * again so their `publication_source` edge reaches it. Cheap: only her own lines with a native id, over a small table.
 */
export function projectPublicationsNaming(
  handle: Connection,
  source: Row | undefined,
  { at }: { at?: string } = {}
): number {
  const db = dbOf(handle);
  if (!hasPublications(db) || source?.kind !== 'said' || source.native_id === null || source.native_id === undefined)
    return 0;
  const needle = `%"key":${JSON.stringify(asText(source.native_id))}%`;
  const ids = db
    .prepare('SELECT id FROM publications WHERE receipts LIKE ? ORDER BY id')
    .all(needle)
    .map((row) => row.id);
  for (const id of ids) projectRow(db, 'publications', { id }, { at });
  return ids.length;
}
