// Her past messages in a diary mirror's place as entries (schema v15's data step, stage 3 design, section 10, "The
// past"): every message of hers there that no entry names becomes part of an entry, so her diary in memory holds all
// she wrote to it. An entry names a message by its `diary_mirrors` ids or by a receipt of its diary publication. The
// messages of one turn are one entry. A message with no turn joins the entry nearest to it in time when one of that
// entry's messages is within two minutes of it (JOIN_MS, frozen with the step), an entry already held included, and
// otherwise is an entry of its own. A new entry's text is its messages' texts, the empty ones left out, joined with a
// line break; its publication to the place is `sent`, with its messages as receipts: nothing is posted again. A held
// entry keeps its text, and its mirror and its publication gain the joined message. Her messages are those she has a
// `said` line of and those seen from her own account (a message of files only is recorded as seen). The record keeps
// no attachments of hers, so every entry the step writes or extends is marked `mediaPending` in its extra, and the
// diary media job (diary-media.js) reads its files and their descriptions once. A message she deleted is left out. Runs inside the migration's transaction; a second run finds every message named
// and writes nothing.

import { createHash } from 'node:crypto';
import { contentHash, deriveMirrorPublication, mirrorReceipts, publicationKey } from './publish.js';
import { projectRow } from './graph.js';
import { audienceOf, groupScope } from './scope.ts';

/** How near in time a message with no turn must be to an entry's message to join it. */
const JOIN_MS = 2 * 60 * 1000;
/** The characters of a new entry's gist (`diary.gistChars`' default). */
const GIST_CHARS = 200;

type Row = Record<string, unknown>;
type Db = {
  prepare(sql: string): {
    all(...params: Array<unknown>): Array<Row>;
    get(...params: Array<unknown>): Row | undefined;
    run(...params: Array<unknown>): unknown;
  };
};

/** One message of hers in the place: its id, time, newest text and turn. */
type Line = { id: string; at: number; text: string; turnId: string | null; joined?: boolean };
/** An entry the step builds or extends: the held entry's id (null for a new one) and its messages. */
type Group = { heldId: string | null; lines: Array<Line> };

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const isJoined = (line: Line): boolean => line.joined === true;

/** The JSON array a column holds, or none. */
function arrayOf(json: unknown): Array<unknown> {
  try {
    const parsed: unknown = typeof json === 'string' ? JSON.parse(json) : null;
    return Array.isArray(parsed) ? (parsed as Array<unknown>) : [];
  } catch {
    return [];
  }
}

/**
 * Her messages in `placeId`, oldest first, each once: the first revision's time, the newest revision's text. Hers are
 * the messages she has a `said` line of, and those seen from her own account (the account of her `said` lines): a
 * message of files only is recorded as seen.
 */
function linesOf(db: Db, placeId: string): Array<Line> {
  const rows = db
    .prepare(
      `SELECT native_id, revision, occurred_at, text, turn_id, kind, author_account FROM sources
        WHERE place_id = ? AND kind IN ('said', 'seen', 'deleted') AND retired_at IS NULL AND native_id IS NOT NULL
        ORDER BY native_id, revision`
    )
    .all(placeId);
  const accounts = new Set(
    db
      .prepare("SELECT DISTINCT author_account FROM sources WHERE kind = 'said' AND author_account IS NOT NULL")
      .all()
      .map((row) => text(row.author_account))
  );
  const said = new Set(
    rows
      .filter((row) => row.kind === 'said' || (row.kind === 'seen' && accounts.has(text(row.author_account))))
      .map((row) => text(row.native_id))
  );
  const gone = new Set(rows.filter((row) => row.kind === 'deleted').map((row) => text(row.native_id)));
  const byId = new Map<string, Line>();
  for (const row of rows) {
    const id = text(row.native_id);
    if (!said.has(id) || gone.has(id) || row.kind === 'deleted') continue;
    const at = Date.parse(text(row.occurred_at));
    const known = byId.get(id);
    if (!known) {
      if (!Number.isFinite(at)) continue;
      byId.set(id, { id, at, text: text(row.text), turnId: text(row.turn_id) || null });
    } else {
      known.text = text(row.text);
      known.turnId ??= text(row.turn_id) || null;
    }
  }
  return [...byId.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

/** Every entry by the messages that name it: its `diary_mirrors` ids and its diary publications' receipts. */
function heldMessages(db: Db): Map<string, string> {
  const held = new Map<string, string>();
  for (const row of db.prepare('SELECT diary_id, native_ids FROM diary_mirrors WHERE retired_at IS NULL').all())
    for (const id of arrayOf(row.native_ids)) if (typeof id === 'string' && id) held.set(id, text(row.diary_id));
  for (const row of db
    .prepare("SELECT row_id, receipts FROM publications WHERE row_kind = 'diary' AND retired_at IS NULL")
    .all())
    for (const receipt of arrayOf(row.receipts) as Array<{ key?: unknown; kind?: unknown }>)
      if (typeof receipt?.key === 'string' && receipt.key && receipt.kind !== 'attachment')
        held.set(receipt.key, text(row.row_id));
  return held;
}

/** The group nearest to `line` within JOIN_MS of one of its messages, or null. */
function nearest(groups: ReadonlyArray<Group>, line: Line): Group | null {
  let best: Group | null = null;
  let gap = JOIN_MS + 1;
  for (const group of groups)
    for (const other of group.lines) {
      const distance = Math.abs(other.at - line.at);
      if (distance < gap) {
        gap = distance;
        best = group;
      }
    }
  return best;
}

/** The entries her unnamed `lines` make, the held entries they join included (see the head of this file). */
function groupsOf(lines: ReadonlyArray<Line>, held: Map<string, string>): Array<Group> {
  const groups: Array<Group> = [];
  const heldGroups = new Map<string, Group>();
  const byTurn = new Map<string, Group>();
  for (const line of lines) {
    const entryId = held.get(line.id);
    if (entryId) {
      const group = heldGroups.get(entryId) ?? { heldId: entryId, lines: [] };
      heldGroups.set(entryId, group);
      group.lines.push(line);
    } else if (line.turnId) {
      const group = byTurn.get(line.turnId) ?? { heldId: null, lines: [] };
      if (!byTurn.has(line.turnId)) groups.push(group);
      byTurn.set(line.turnId, group);
      group.lines.push(line);
    }
  }
  const candidates = [...heldGroups.values(), ...groups];
  for (const line of lines) {
    if (held.has(line.id) || line.turnId) continue;
    const joined = nearest(candidates, line);
    if (joined) joined.lines.push({ ...line, joined: true });
    else {
      const alone: Group = { heldId: null, lines: [line] };
      groups.push(alone);
      candidates.push(alone);
    }
  }
  const extended = [...heldGroups.values()].filter((group) => group.lines.some((line) => isJoined(line)));
  return [...groups, ...extended];
}

/** A held entry gains the messages that joined it: on its mirror (its publication follows), else on its publication. */
function extendHeld(db: Db, group: Group, place: { id: string; iface: string }, at: string): void {
  const joined = group.lines.filter(isJoined).map((line) => line.id);
  const mirror = db
    .prepare('SELECT rowid, native_ids FROM diary_mirrors WHERE diary_id = ? AND retired_at IS NULL ORDER BY rowid')
    .get(group.heldId);
  if (mirror) {
    const ids = [...arrayOf(mirror.native_ids), ...joined];
    db.prepare('UPDATE diary_mirrors SET native_ids = ? WHERE rowid = ?').run(JSON.stringify(ids), mirror.rowid);
    deriveMirrorPublication(db, { rowid: Number(mirror.rowid) }, { at });
  } else {
    const publication = db
      .prepare(
        "SELECT id, receipts FROM publications WHERE row_kind = 'diary' AND row_id = ? AND destination_place_id = ? AND retired_at IS NULL"
      )
      .get(group.heldId, place.id);
    if (!publication) return;
    const receipts = [...arrayOf(publication.receipts), ...mirrorReceipts(place.iface, joined)];
    db.prepare('UPDATE publications SET receipts = ? WHERE id = ?').run(JSON.stringify(receipts), publication.id);
    projectRow(db, 'publications', { id: publication.id }, { at });
  }
  // The record keeps no attachments of hers: the media job reads the joined messages' files once.
  db.prepare(
    "UPDATE diary SET extra = json_set(COALESCE(extra, '{}'), '$.mediaPending', json('true')) WHERE id = ?"
  ).run(group.heldId);
}

/** A new entry of `group` and its `sent` publication to the place. */
function writeEntry(db: Db, group: Group, place: { id: string; iface: string }, at: string): void {
  const lines = [...group.lines].sort((a, b) => a.at - b.at);
  const first = lines[0];
  if (!first) return;
  const body = lines
    .map((line) => line.text)
    .filter((part) => part !== '')
    .join('\n');
  const id = `diary:past-${first.id}`;
  // The diary is public: the group audience of the place's interface (the place's own lines hold it already).
  const row: Row = {
    id,
    at_ms: first.at,
    kind: null,
    gist: body.replace(/\s+/g, ' ').trim().slice(0, GIST_CHARS),
    text: body,
    ...audienceOf(groupScope(place.iface)),
    extra: JSON.stringify({ mediaPending: true }),
    owner_file: null,
  };
  const cols = Object.keys(row);
  db.prepare(
    `INSERT OR IGNORE INTO diary (${cols.map((col) => `"${col}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...cols.map((col) => row[col] ?? null));
  projectRow(db, 'diary', { id }, { at });
  const key = publicationKey('diary', id, place.id);
  const sentAt = new Date(first.at).toISOString();
  const publication = {
    id: `pub:${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32)}`,
    rendered: body,
    content_hash: contentHash(body),
    receipts: JSON.stringify(
      mirrorReceipts(
        place.iface,
        lines.map((line) => line.id)
      )
    ),
  };
  db.prepare(
    `INSERT OR IGNORE INTO publications (id, row_kind, row_id, content_hash, rendered, destination_place_id, context_id,
       grant_id, status, idempotency_key, receipts, created_at, sent_at, owner_file, retired_at)
     VALUES (?, 'diary', ?, ?, ?, ?, NULL, NULL, 'sent', ?, ?, ?, ?, NULL, NULL)`
  ).run(
    publication.id,
    id,
    publication.content_hash,
    publication.rendered,
    place.id,
    key,
    publication.receipts,
    sentAt,
    sentAt
  );
  projectRow(db, 'publications', { id: publication.id }, { at });
}

/**
 * Her messages in the enabled diary mirror's place `placeId` that no entry names, made entries (see the head of this
 * file). Returns how many entries were written or extended.
 */
export function pastEntries(connection: unknown, placeId: string, { at }: { at: string }): number {
  const db = connection as Db; // the migration's node:sqlite connection
  const place = db.prepare('SELECT id, iface FROM places WHERE id = ?').get(placeId);
  if (!place) return 0;
  const where = { id: placeId, iface: text(place.iface) };
  const groups = groupsOf(linesOf(db, placeId), heldMessages(db));
  for (const group of groups) {
    if (group.heldId) extendHeld(db, group, where, at);
    else writeEntry(db, group, where, at);
  }
  return groups.length;
}
