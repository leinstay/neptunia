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
//   markSent / markFailed / markUnknown   the send's outcome. `unknown` is a send whose outcome a crash or a timeout
//       hid; a later `markSent` or `markFailed` settles it.
//   grantFor   reads the owner's exceptions (`publication_grants`). No code of the engine writes or revokes a grant.
// The diary's mirrors (`diary_mirrors`, written with her entries, diary-entries.ts) derive their publication rows here too
// (`deriveMirrorPublication`), on the one path every mirror write takes (the sync, rows.ts#insertRows, the v10
// migration), so a remap keeps the row and never makes a second one.
//
// `assignDiaryDestination` gives the diary's publications that name no destination the deployment's diary channel (the
// v12 data step for the legacy mirrors, and her diary's writer, diary-entries.ts).
// Every write projects the publication into the graph in the same transaction (graph.ts#projectRow). No live writer
// uses preparePublication but the diary's mirrors (src/behavior/mirror.ts); the legacy diary posts derive their
// `sent` publications on the diary's own write (diary-entries.ts). Logs: none; a caller logs codes.

import { createHash } from 'node:crypto';

import { diaryMetadataOf, diaryPublicationRefusal } from '../../tools/publication.ts';

import { audienceRefusal } from './diary-audience.ts';
import { legacyNativeKind, nativeAuthorityOf } from './ids.ts';
import { parseExtra } from './row-columns.ts';
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
      chatId: typeof place?.native_id === 'string' ? place.native_id : '',
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
        `INSERT INTO publications (id, row_kind, row_id, content_hash, rendered, destination_place_id, context_id, grant_id, status, idempotency_key, receipts, created_at, sent_at, retired_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, ?, NULL, NULL)`
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
 * mirror's message ids as receipts, the key `diary:<entry>:<place>`, the mirror's owner (its unit and its owner
 * columns, place-owner.ts) and retirement.
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
    ...(Object.hasOwn(mirror, 'holder_id')
      ? { writer: mirror.writer ?? null, holder_id: mirror.holder_id ?? null }
      : {}),
    retired_at: mirror.retired_at ?? null,
  };
}

/** The stored mirror a mirror names: by its rowid, its id, or its entry, interface and place as the sync keys it. */
function storedMirror(db: Db, mirror: Row | undefined): Row | undefined {
  const direct = Number.isInteger(mirror?.rowid)
    ? db.prepare('SELECT * FROM diary_mirrors WHERE rowid = ?').get(mirror?.rowid)
    : filled(mirror?.id)
      ? db.prepare('SELECT * FROM diary_mirrors WHERE id = ?').get(mirror.id)
      : undefined;
  if (direct || !filled(mirror?.diary_id)) return direct;
  return db
    .prepare(
      "SELECT * FROM diary_mirrors WHERE diary_id = ? AND iface IS ? AND COALESCE(place_id, '') = ? ORDER BY writer IS NULL DESC, rowid LIMIT 1"
    )
    .get(mirror.diary_id, mirror.iface ?? null, mirror.place_id ?? '');
}

/**
 * The mirror's own publication follows its mirror: receipts, owner and retirement, a destination or a text that was not
 * known before. The content is filled once, never rewritten (a trigger guards it).
 */
function followMirror(db: Db, row: Row, id: unknown): void {
  const owned = Object.hasOwn(row, 'holder_id');
  db.prepare(
    `UPDATE publications SET receipts = ?, retired_at = ?,${owned ? ' writer = ?, holder_id = ?,' : ''}
      destination_place_id = COALESCE(destination_place_id, ?),
      rendered = CASE WHEN content_hash IS NULL THEN ? ELSE rendered END,
      content_hash = CASE WHEN content_hash IS NULL THEN ? ELSE content_hash END
    WHERE id = ?`
  ).run(
    row.receipts,
    row.retired_at,
    ...(owned ? [row.writer, row.holder_id] : []),
    row.destination_place_id,
    row.rendered,
    row.content_hash,
    id
  );
}

/**
 * Writes the publication of a diary mirror (found by its id, or by its entry, interface and place as the sync keys it):
 * inserted once by its key; on a later write of the mirror the row follows it (receipts, owner, retirement, a
 * destination or a text that was not known before) and keeps its id, its content once known, and its state. A
 * publication the database wrote itself (no writer) is never touched. `project: false` leaves the graph to the
 * caller (the migration). Returns the publication id, or null when there is no such mirror.
 */
export function deriveMirrorPublication(
  handle: Connection,
  mirror: Row | undefined,
  { at, project = true }: { at?: string; project?: boolean } = {}
): unknown {
  const db = dbOf(handle);
  if (!hasPublications(db)) return null;
  const found = storedMirror(db, mirror);
  if (!found || !filled(found.id) || !filled(found.diary_id)) return null;
  const text =
    (db.prepare('SELECT text FROM diary WHERE id = ?').get(found.diary_id)?.text as string | null | undefined) ?? null;
  const placeExists =
    filled(found.place_id) && db.prepare('SELECT 1 AS ok FROM places WHERE id = ?').get(found.place_id) !== undefined;
  const stamp = filled(at) ? at : new Date().toISOString();
  const row = mirrorPublicationRow(found, {
    text,
    placeExists,
    at: stamp,
  });
  const owned = Object.hasOwn(row, 'holder_id');
  const existing = db
    .prepare(`SELECT id${owned ? ', writer' : ''} FROM publications WHERE idempotency_key = ?`)
    .get(row.idempotency_key);
  if (!existing) {
    const stored = row;
    const cols = Object.keys(stored);
    db.prepare(
      `INSERT INTO publications (${cols.map((col) => `"${col}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    ).run(...cols.map((col) => stored[col]));
  } else if (existing.writer != null) {
    followMirror(db, row, existing.id);
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
 * is set on every `diary` publication without a destination (of the owner columns `holder` only, when given), when that place is
 * stored; nothing else of a publication changes. Returns how many were set.
 */
export function assignDiaryDestination(
  handle: Connection,
  placeId: string,
  {
    holder = null,
    at,
    project = true,
  }: { holder?: { writer: string; holder_id: string } | null; at?: string; project?: boolean } = {}
): number {
  const db = dbOf(handle);
  if (!hasPublications(db) || !filled(placeId)) return 0;
  if (db.prepare('SELECT 1 AS ok FROM places WHERE id = ?').get(placeId) === undefined) return 0;
  const ids = db
    .prepare(
      `UPDATE publications SET destination_place_id = ? WHERE row_kind = 'diary' AND destination_place_id IS NULL${holder ? ' AND writer = ? AND holder_id = ?' : ''} RETURNING id`
    )
    .all(...(holder ? [placeId, holder.writer, holder.holder_id] : [placeId]))
    .map((row) => row.id);
  if (project) for (const id of ids) projectRow(db, 'publications', { id }, { at });
  return ids.length;
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
  // A receipt names the message as the interface does; a line in a family holds the family's key.
  const needle = (key: unknown): string => `%"key":${JSON.stringify(asText(key))}%`;
  const messageId = (parseExtra(source.extra).$messageLocator as { messageId?: unknown } | undefined)?.messageId;
  const ids = db
    .prepare('SELECT id FROM publications WHERE receipts LIKE ? OR receipts LIKE ? ORDER BY id')
    .all(needle(source.native_id), needle(messageId ?? source.native_id))
    .map((row) => row.id);
  for (const id of ids) projectRow(db, 'publications', { id }, { at });
  return ids.length;
}
