// The owner's merge of one person into another (`applyMemoryWrite` kind `person-merge`, `MemoryDbService.personMerge`,
// `/memory users merge`). Everything stored about the person who goes, and every account and conversation of theirs,
// moves to the person who stays at the end of the merge chain (ids.ts#survivorOf). No row changes its `audience_id`:
// a line, a fact or a feeling keeps the conversation it came from, and only the person it names moves. One
// `people_merges` row records the merge, and the person who went keeps `status` `merged_into:<survivor>`. A repeat of a
// recorded merge moves what is left behind and writes nothing more, so it is idempotent and it finishes a merge the
// record-only writer (session-write.ts#mergePeople) left half done. Only the owner merges; her own person is never
// merged in or out. Called by session-write.ts (the write) and identity-links.ts (the merges the owner's command line
// implies). Counts and codes only.

import { projectRow } from './graph.ts';
import { SELF_PERSON, survivorOf } from './ids.ts';
import { linkAccount } from './person-links.ts';
import { dbOf } from './types.ts';
import type { Db, MemoryHandle, Row } from './types.ts';

/** What a merge answers: its record, the survivor and how many rows of each kind moved. */
export type PersonMerge = { ok: true; id: string; survivor: string; moved: Record<string, number> };

/** The tables whose `scope_dm` names the partner person of a DM row. Their `audience_id` never changes. */
const SCOPE_TABLES = [
  'claims',
  'episodes',
  'descriptions',
  'affinity_events',
  'sources',
  'vectors',
  'day',
  'diary',
  'intentions',
  'work',
  'media',
  'session_runs',
] as const;

/** The rows that name a person as their subject, and the unit the graph projects each of them under. */
const SUBJECT_MOVES = [
  { key: 'claims', table: 'claims', column: 'subject_id', where: "subject_kind = 'person'" },
  { key: 'claimAuthors', table: 'claims', column: 'from_person', where: '1 = 1' },
  { key: 'descriptions', table: 'descriptions', column: 'subject_id', where: "subject_kind = 'person'" },
  { key: 'episodes', table: 'episodes', column: 'subject_id', where: '1 = 1' },
  { key: 'affinity', table: 'affinity_events', column: 'person_id', where: '1 = 1' },
] as const;

function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';

const hasColumn = (db: Db, table: string, column: string): boolean =>
  db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .some((row) => row.name === column);

/** The ids a statement is about to move, so the graph can project each of them again. */
const idsWhere = (db: Db, table: string, where: string, person: string): Array<string> =>
  db
    .prepare(`SELECT id FROM "${table}" WHERE ${where}`)
    .all(person)
    .map((row) => String(row.id));

/** The person's accounts and their live links move to the survivor; each old link stays, closed, as history. */
function moveAccounts(db: Db, from: string, survivor: string, by: string, at: string): Array<string> {
  const links = db
    .prepare(
      `SELECT account_id, state, by FROM account_person_links WHERE person_id = ? AND valid_to_at IS NULL
       AND state IN ('verified', 'proposed') ORDER BY account_id`
    )
    .all(from);
  const moved = new Set<string>();
  for (const one of links) {
    const accountId = String(one.account_id);
    const verified = one.state === 'verified';
    linkAccount(db, accountId, survivor, at, {
      by: verified ? by : String(one.by),
      reason: 'merge',
      state: verified ? 'verified' : 'proposed',
    });
    moved.add(accountId);
  }
  // An account whose column names the person with no live link (a unit write's copy) follows it as well.
  for (const row of db.prepare('SELECT id FROM accounts WHERE person_id = ?').all(from)) {
    const accountId = String(row.id);
    if (moved.has(accountId)) continue;
    linkAccount(db, accountId, survivor, at, { by, reason: 'merge' });
    moved.add(accountId);
  }
  return [...moved];
}

/** The live links of anonymous participants move the same way. */
function moveParticipantLinks(db: Db, from: string, survivor: string, at: string): number {
  const links = db
    .prepare('SELECT * FROM participant_links WHERE person_id = ? AND valid_to_at IS NULL ORDER BY id')
    .all(from);
  for (const one of links) {
    db.prepare('UPDATE participant_links SET valid_to_at = ? WHERE id = ?').run(at, one.id);
    db.prepare(
      `INSERT INTO participant_links (id, participant_id, account_id, person_id, state, by, reason, evidence_id,
         valid_from_at, valid_to_at, recorded_at) VALUES (?, ?, ?, ?, ?, ?, 'merge', ?, ?, NULL, ?)`
    ).run(
      `${String(one.id)}:merged:${at}`,
      one.participant_id,
      one.account_id,
      survivor,
      one.state,
      one.by,
      one.evidence_id,
      at,
      at
    );
  }
  return links.length;
}

/** The daily relationship counts of the two add up, day by day and audience by audience. */
function moveRelationship(db: Db, from: string, survivor: string): number {
  const rows = db.prepare('SELECT COUNT(*) AS n FROM relationship_daily WHERE person_id = ?').get(from)?.n;
  if (!rows) return 0;
  db.prepare(
    `INSERT INTO relationship_daily (person_id, day, audience_id, addressed_by_them, addressed_by_her, meaningful, last_contact_at)
     SELECT ?, day, audience_id, addressed_by_them, addressed_by_her, meaningful, last_contact_at
     FROM relationship_daily WHERE person_id = ? AND true
     ON CONFLICT(person_id, day, audience_id) DO UPDATE SET
       addressed_by_them = addressed_by_them + excluded.addressed_by_them,
       addressed_by_her = addressed_by_her + excluded.addressed_by_her,
       meaningful = MAX(meaningful, excluded.meaningful),
       last_contact_at = MAX(COALESCE(last_contact_at, ''), COALESCE(excluded.last_contact_at, ''))`
  ).run(survivor, from);
  db.prepare('DELETE FROM relationship_daily WHERE person_id = ?').run(from);
  return Number(rows);
}

/** A focus membership or override of the person who went is dropped when the survivor holds one, else moved. */
function moveFocus(db: Db, from: string, survivor: string): number {
  let moved = 0;
  for (const table of ['focus_members', 'focus_overrides']) {
    moved += Number(
      db.prepare(`UPDATE OR IGNORE "${table}" SET person_id = ? WHERE person_id = ?`).run(survivor, from).changes
    );
    moved += Number(db.prepare(`DELETE FROM "${table}" WHERE person_id = ?`).run(from).changes);
  }
  return moved;
}

/** Moves every row of `from` to `survivor`; returns the counts and the rows the graph projects again. */
function moveRows(
  db: Db,
  { from, survivor, by, at }: { from: string; survivor: string; by: string; at: string }
): { moved: Record<string, number>; project: Array<[string, string]> } {
  const moved: Record<string, number> = {};
  const project: Array<[string, string]> = [];
  for (const { key, table, column, where } of SUBJECT_MOVES) {
    const ids = idsWhere(db, table, `${where} AND ${column} = ?`, from);
    if (ids.length > 0)
      db.prepare(`UPDATE "${table}" SET ${column} = ? WHERE ${where} AND ${column} = ?`).run(survivor, from);
    moved[key] = ids.length;
    for (const id of ids) project.push([table, id]);
  }
  const accounts = moveAccounts(db, from, survivor, by, at);
  moved.accounts = accounts.length;
  for (const id of accounts) project.push(['accounts', id]);
  moved.participants = moveParticipantLinks(db, from, survivor, at);
  const places = idsWhere(db, 'places', 'partner_person = ?', from);
  db.prepare('UPDATE places SET partner_person = ? WHERE partner_person = ?').run(survivor, from);
  moved.places = places.length;
  for (const id of places) project.push(['places', id]);
  for (const table of SCOPE_TABLES) {
    if (!hasColumn(db, table, 'scope_dm')) continue;
    const changed = db.prepare(`UPDATE "${table}" SET scope_dm = ? WHERE scope_dm = ?`).run(survivor, from).changes;
    moved[`scope:${table}`] = Number(changed);
  }
  moved.relationship = moveRelationship(db, from, survivor);
  moved.focus = moveFocus(db, from, survivor);
  return { moved, project };
}

/**
 * The merge itself, inside the caller's transaction: `from` into the survivor of `into`, by `by` (the owner). Throws a
 * coded error, before anything is written, for a merge that is not the owner's (`OWNER_ONLY`), her own person
 * (`SELF_PERSON`), a person nobody stored (`UNKNOWN_PERSON`), one person (`SAME_PERSON`), a chain that leads back to
 * `from` (`MERGE_CYCLE`) and a person already merged into somebody else (`ALREADY_MERGED`).
 */
export function mergePersonInto(
  db: Db,
  { from, into, by, reason, at }: { from: string; into: string; by: string; reason: string | null; at: string }
): PersonMerge {
  if (!filled(from) || !filled(into)) throw coded('BAD_MERGE');
  if (by !== 'owner') throw coded('OWNER_ONLY');
  if (from === SELF_PERSON || into === SELF_PERSON) throw coded('SELF_PERSON');
  const exists = db.prepare('SELECT 1 AS ok FROM people WHERE id = ?');
  if (!exists.get(from) || !exists.get(into)) throw coded('UNKNOWN_PERSON');
  if (from === into) throw coded('SAME_PERSON');
  const survivor = survivorOf(db, into);
  if (survivor === from) throw coded('MERGE_CYCLE');
  if (survivor === SELF_PERSON) throw coded('SELF_PERSON');
  const recorded = db.prepare('SELECT id, into_person FROM people_merges WHERE from_person = ?').get(from);
  if (recorded && survivorOf(db, recorded.into_person) !== survivor) throw coded('ALREADY_MERGED');
  const id = recorded ? String(recorded.id) : `merge:${from}`;
  const { moved, project } = moveRows(db, { from, survivor, by, at });
  if (!recorded)
    db.prepare(
      'INSERT INTO people_merges (id, from_person, into_person, at, by, reason) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, from, survivor, at, by, reason);
  const status = `merged_into:${survivor}`;
  const person = db.prepare('SELECT status FROM people WHERE id = ?').get(from);
  if (person?.status !== status) {
    db.prepare('UPDATE people SET status = ? WHERE id = ?').run(status, from);
    project.push(['people', from]);
  }
  for (const [table, rowId] of project) projectRow(db, table, { id: rowId }, { at });
  return { ok: true, id, survivor, moved };
}

/** The write of `applyMemoryWrite` kind `person-merge`: `{ from, into, by, reason?, now? }`, one transaction. */
export function applyPersonMergeWrite(handle: MemoryHandle, update: Row): PersonMerge {
  const at = new Date(typeof update.now === 'number' ? update.now : Date.now()).toISOString();
  return handle.transaction(() =>
    mergePersonInto(dbOf(handle), {
      from: typeof update.from === 'string' ? update.from : '',
      into: typeof update.into === 'string' ? update.into : '',
      by: typeof update.by === 'string' ? update.by : '',
      reason: filled(update.reason) ? update.reason : null,
      at,
    })
  );
}
