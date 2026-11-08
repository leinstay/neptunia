// The name index of the graph reader: every name a person, a place or an interface goes by, one row per name, per node,
// per audience and per stored row it came from. The table `names` holds the label as stored, its folded form
// (`normalized`: its words in lower case with no accents, src/memory/record-index.ts#indexWords), the stems of its words under the learned stemmer
// (src/memory/db/stems.ts), the kind of name, the graph node it raises, the audience it may be read in and the row it
// came from. `names_tri` is a trigram index over `normalized`, kept by triggers.
//
// The rows come from:
//   places.name          kind `place`, the place's node, the place's own audience (graph.ts#placeAudience)
//   accounts.names       kind `account`, the person of a verified live link, else the account's node; the group of the
//                        account's interface
//   people.real_name     kind `real_name`, the person's node; the group of the interface of the person's first account
//   memberships.nick     kind `nick`, the person of the membership's account; the audience of the membership's place
//   claims of kind alias kind `alias`, the node of the claim's subject (a person or a place); the claim's audience
//   interfaces.name      kind `interface`, the interface's node; readable everywhere
//   interfaces.extra     kind `interface_noun`, the interface's word for each kind of place it has (`hello.names.nouns`)
// A retired row, a closed membership and a retired or superseded claim give no row. A public and a private name of one
// node are two rows, so a retired claim or a revoked link takes exactly its own rows with it.
//
//   touchNames(db, sourceTable, sourceId)   the rows of one stored row deleted and written again from the row as it is
//       now. graph.ts#projectRow calls it for every unit it projects, so every writer of those tables keeps the index. An
//       account's touch also touches its person and its memberships, since their names point through the account. It
//       returns the nodes whose rows it rewrote, whose name sets object-vectors.ts#touchNameVectors compares.
//   rebuildNames(db)   every row again from the stored rows; the migration that makes the table runs it.
//   namesOf(db, ctx, words)   the nodes each word names, read under `ctx` (scope.ts#audienceWhere). A word is matched by
//       its folded exact form first, then by its stems, then by trigrams; a weaker way is tried only when the stronger
//       found nothing, and one node is one hit per word, by its strongest match.
//   placesNamed(db, ctx, name)   the live places a name she wrote in a tool's `place` argument names under `ctx`, by
//       its exact folded form or its stems, each place once with its stored name (src/tools/executors.ts#resolveCall).
// Pure of the bot; works on an opened database.

import { indexWords } from '../record-index.ts';
import { AUD_INTERNAL, AUD_NONE, audienceWhere, dmAudienceId, groupAudienceId } from './scope.ts';
import { loadStemmer, stemsOf } from './stems.ts';
import type { Context } from './scope.ts';
import type { Db, Row } from './types.ts';

/** How a word matched a name. */
export type NameMatch = 'exact' | 'stem' | 'trigram';
/** One node a word names: the graph node, the kind of name, the name as stored, how it matched and its audience. */
export type NameHit = { nodeId: string; kind: string; label: string; match: NameMatch; audienceId: string };
/** A hit with the folded name it matched, for a reader that needs the form (an interface's noun). */
export type NameHitRow = NameHit & { normalized: string };

/** The tables the index reads names from. */
export const NAME_SOURCES: ReadonlySet<string> = new Set([
  'places',
  'accounts',
  'people',
  'memberships',
  'claims',
  'interfaces',
]);

/** The shortest folded word a trigram match is tried for, and the share of shared trigrams a match needs. */
const TRIGRAM_MIN_CHARS = 4;
const TRIGRAM_MIN_SIMILARITY = 0.6;
/** The most rows one trigram query reads before the similarity is measured. */
const TRIGRAM_CANDIDATES = 50;

/** The schema of the index: the table, its indexes, the trigram table and the triggers that keep it. */
export const NAMES_SCHEMA = `CREATE TABLE names (
  rowid INTEGER PRIMARY KEY,
  label TEXT NOT NULL, normalized TEXT NOT NULL, stem TEXT NOT NULL, kind TEXT NOT NULL, node_id TEXT NOT NULL,
  audience_id TEXT NOT NULL, source_table TEXT NOT NULL, source_id TEXT NOT NULL,
  UNIQUE (normalized, kind, node_id, source_table, source_id)
);
CREATE INDEX names_stem ON names(stem);
CREATE INDEX names_source ON names(source_table, source_id);
CREATE VIRTUAL TABLE names_tri USING fts5(normalized, content='names', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER names_tri_insert AFTER INSERT ON names BEGIN
  INSERT INTO names_tri(rowid, normalized) VALUES (new.rowid, new.normalized);
END;
CREATE TRIGGER names_tri_delete AFTER DELETE ON names BEGIN
  INSERT INTO names_tri(names_tri, rowid, normalized) VALUES ('delete', old.rowid, old.normalized);
END;`;

type NameRow = { label: string; kind: string; nodeId: string; audienceId: string };

const filled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
/** A name or a word as the index compares it: its words folded (src/memory/record-index.ts#indexWords), space-joined. */
export const normalName = (text: unknown): string => indexWords(text).join(' ');
const nodeOf = (kind: string, id: unknown): string => `${kind}:${String(id)}`;

/** The strings of a stored JSON name list, a stored real name object, or a plain string. */
export function namesIn(value: unknown): Array<string> {
  if (!filled(value)) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'string') return filled(parsed) ? [parsed] : [];
    if (Array.isArray(parsed)) return parsed.filter(filled);
    // A real name is stored as the people mapper writes it (map/user.ts): `{ name, from, to, itemId, recordedAt }`.
    const name: unknown = parsed && typeof parsed === 'object' ? (parsed as { name?: unknown }).name : null;
    return filled(name) ? [name] : [];
  } catch {
    return [value];
  }
}

/** The person an account's names point at: the person of its verified live link, else null. */
function verifiedPerson(db: Db, accountId: string): string | null {
  const link = db
    .prepare(
      `SELECT l.person_id FROM account_person_links l JOIN people p ON p.id = l.person_id
       WHERE l.account_id = ? AND l.state = 'verified' AND l.valid_to_at IS NULL AND p.retired_at IS NULL
       ORDER BY l.recorded_at DESC, l.id LIMIT 1`
    )
    .get(accountId);
  return filled(link?.person_id) ? link.person_id : null;
}

/** The node an account's names raise: its person while the link is verified, else the account itself. */
function accountNode(db: Db, accountId: string): string {
  const person = verifiedPerson(db, accountId);
  return person === null ? nodeOf('account', accountId) : nodeOf('person', person);
}

/** A place's own audience, as the graph gives it (graph.ts#placeAudience), from its stored row. */
function audienceOfPlace(place: Row | undefined): string {
  if (!place) return AUD_INTERNAL;
  if (place.chat === 'dm' || place.kind === 'dm') return dmAudienceId(place.id);
  if (filled(place.iface)) return groupAudienceId(place.iface);
  return AUD_INTERNAL;
}

function placeRows(db: Db, id: string): Array<NameRow> {
  const place = db.prepare('SELECT id, iface, kind, chat, name, retired_at FROM places WHERE id = ?').get(id);
  if (!place || place.retired_at !== null || !filled(place.name)) return [];
  return [{ label: place.name, kind: 'place', nodeId: nodeOf('place', id), audienceId: audienceOfPlace(place) }];
}

function accountRows(db: Db, id: string): Array<NameRow> {
  const account = db.prepare('SELECT id, iface, names, retired_at FROM accounts WHERE id = ?').get(id);
  if (!account || account.retired_at !== null || !filled(account.iface)) return [];
  const nodeId = accountNode(db, id);
  return namesIn(account.names).map((label) => ({
    label,
    kind: 'account',
    nodeId,
    audienceId: groupAudienceId(account.iface),
  }));
}

function personRows(db: Db, id: string): Array<NameRow> {
  const person = db.prepare('SELECT id, real_name, retired_at FROM people WHERE id = ?').get(id);
  if (!person || person.retired_at !== null) return [];
  const labels = namesIn(person.real_name);
  if (labels.length === 0) return [];
  const account = db
    .prepare(
      `SELECT a.iface FROM account_person_links l JOIN accounts a ON a.id = l.account_id
       WHERE l.person_id = ? AND l.valid_to_at IS NULL AND a.retired_at IS NULL AND a.iface IS NOT NULL
       ORDER BY a.id LIMIT 1`
    )
    .get(id);
  const audienceId = filled(account?.iface) ? groupAudienceId(account.iface) : AUD_INTERNAL;
  return labels.map((label) => ({ label, kind: 'real_name', nodeId: nodeOf('person', id), audienceId }));
}

function membershipRows(db: Db, id: string): Array<NameRow> {
  const membership = db
    .prepare('SELECT account_id, place_id, nick, valid_to_at, retired_at FROM memberships WHERE id = ?')
    .get(id);
  if (!membership || membership.retired_at !== null || membership.valid_to_at !== null) return [];
  if (!filled(membership.nick) || !filled(membership.account_id)) return [];
  const place = filled(membership.place_id)
    ? db.prepare('SELECT id, iface, kind, chat FROM places WHERE id = ?').get(membership.place_id)
    : undefined;
  return [
    {
      label: membership.nick,
      kind: 'nick',
      nodeId: accountNode(db, membership.account_id),
      audienceId: audienceOfPlace(place),
    },
  ];
}

function claimRows(db: Db, id: string): Array<NameRow> {
  const claim = db
    .prepare(
      'SELECT subject_kind, subject_id, kind, text, audience_id, retired_at, superseded_by FROM claims WHERE id = ?'
    )
    .get(id);
  if (!claim || claim.kind !== 'alias' || claim.retired_at !== null || filled(claim.superseded_by)) return [];
  if ((claim.subject_kind !== 'person' && claim.subject_kind !== 'place') || !filled(claim.subject_id)) return [];
  if (!filled(claim.text)) return [];
  return [
    {
      label: claim.text,
      kind: 'alias',
      nodeId: nodeOf(claim.subject_kind, claim.subject_id),
      audienceId: filled(claim.audience_id) ? claim.audience_id : AUD_INTERNAL,
    },
  ];
}

/** The nouns an interface named for its kinds of place, from `interfaces.extra` (`{ nouns: { kind: noun } }`). */
export function interfaceNouns(extra: unknown): Record<string, string> {
  if (!filled(extra)) return {};
  try {
    const parsed = JSON.parse(extra) as { nouns?: unknown };
    const nouns = parsed.nouns;
    if (nouns === null || typeof nouns !== 'object' || Array.isArray(nouns)) return {};
    return Object.fromEntries(Object.entries(nouns).filter((entry): entry is [string, string] => filled(entry[1])));
  } catch {
    return {};
  }
}

function interfaceRows(db: Db, id: string): Array<NameRow> {
  const row = db.prepare('SELECT id, name, extra FROM interfaces WHERE id = ?').get(id);
  if (!row) return [];
  const nodeId = nodeOf('interface', id);
  const out: Array<NameRow> = filled(row.name)
    ? [{ label: row.name, kind: 'interface', nodeId, audienceId: AUD_NONE }]
    : [];
  for (const noun of Object.values(interfaceNouns(row.extra)))
    out.push({ label: noun, kind: 'interface_noun', nodeId, audienceId: AUD_NONE });
  return out;
}

const ROWS_OF: Record<string, (db: Db, id: string) => Array<NameRow>> = {
  places: placeRows,
  accounts: accountRows,
  people: personRows,
  memberships: membershipRows,
  claims: claimRows,
  interfaces: interfaceRows,
};

const ready = new WeakMap<Db, true>();
/** Whether the database has the index yet: a migration before it projects rows too. */
function hasNames(db: Db): boolean {
  if (ready.has(db)) return true;
  const found = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'names'").get();
  if (found) ready.set(db, true);
  return found !== undefined;
}

/** Writes the rows of one stored row; returns the nodes it wrote rows for. */
function writeRows(db: Db, sourceTable: string, sourceId: string, stem: (word: string) => string): Array<string> {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO names (label, normalized, stem, kind, node_id, audience_id, source_table, source_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const nodes: Array<string> = [];
  for (const row of ROWS_OF[sourceTable]?.(db, sourceId) ?? []) {
    const normalized = normalName(row.label);
    if (normalized === '') continue;
    nodes.push(row.nodeId);
    insert.run(
      row.label,
      normalized,
      stemsOf(stem, normalized),
      row.kind,
      row.nodeId,
      row.audienceId,
      sourceTable,
      sourceId
    );
  }
  return nodes;
}

/**
 * The rows of one stored row, deleted and written again from the row as it is now. Returns the nodes whose rows it
 * deleted or wrote, for the name sets of object-vectors.ts.
 */
export function touchNames(db: Db, sourceTable: string, sourceId: string, nodes = new Set<string>()): Set<string> {
  if (!NAME_SOURCES.has(sourceTable) || !hasNames(db)) return nodes;
  const stem = loadStemmer(db).stem;
  const deleted = db.prepare('DELETE FROM names WHERE source_table = ? AND source_id = ? RETURNING node_id');
  for (const row of deleted.all(sourceTable, sourceId)) nodes.add(String(row.node_id));
  for (const nodeId of writeRows(db, sourceTable, sourceId, stem)) nodes.add(nodeId);
  if (sourceTable !== 'accounts') return nodes;
  // An account's person and its memberships name through it: a link that changed moves their rows too.
  for (const row of db.prepare('SELECT id FROM memberships WHERE account_id = ?').all(sourceId))
    touchNames(db, 'memberships', String(row.id), nodes);
  const people = db
    .prepare('SELECT DISTINCT person_id FROM account_person_links WHERE account_id = ? AND person_id IS NOT NULL')
    .all(sourceId);
  for (const row of people) touchNames(db, 'people', String(row.person_id), nodes);
  return nodes;
}

/** Every row of the index again from the stored rows. */
export function rebuildNames(db: Db): number {
  if (!hasNames(db)) return 0;
  const stem = loadStemmer(db).stem;
  db.exec('DELETE FROM names');
  for (const table of NAME_SOURCES)
    for (const row of db.prepare(`SELECT id FROM ${table} ORDER BY id`).all())
      writeRows(db, table, String(row.id), stem);
  return Number(db.prepare('SELECT COUNT(*) AS n FROM names').get()?.n ?? 0);
}

/** The distinct trigrams of a folded word. */
function trigramsOf(text: string): Set<string> {
  const chars = [...text];
  const out = new Set<string>();
  for (let i = 0; i + 3 <= chars.length; i += 1) out.add(chars.slice(i, i + 3).join(''));
  return out;
}

/** The Dice similarity of two folded words by their trigrams. */
function similarity(a: string, b: string): number {
  const left = trigramsOf(a);
  const right = trigramsOf(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

const HIT_COLUMNS = 'n.label, n.normalized, n.kind, n.node_id, n.audience_id';
const hitOf = (row: Row, match: NameMatch): NameHitRow => ({
  nodeId: String(row.node_id),
  kind: String(row.kind),
  label: String(row.label),
  match,
  audienceId: String(row.audience_id),
  normalized: String(row.normalized),
});

function trigramHits(db: Db, ctx: Context, folded: string): Array<NameHitRow> {
  if ([...folded].length < TRIGRAM_MIN_CHARS || folded.includes(' ')) return [];
  const query = [...trigramsOf(folded)].map((gram) => `"${gram.replace(/"/g, '""')}"`).join(' OR ');
  const filter = audienceWhere(ctx, 'n');
  const rows = db
    .prepare(
      `SELECT ${HIT_COLUMNS} FROM names_tri JOIN names n ON n.rowid = names_tri.rowid
       WHERE names_tri MATCH ? AND ${filter.sql} ORDER BY n.normalized, n.node_id LIMIT ?`
    )
    .all(query, ...filter.params, TRIGRAM_CANDIDATES);
  return rows
    .filter((row) => {
      const words = [String(row.normalized), ...String(row.normalized).split(' ')];
      return words.some((word) => similarity(folded, word) >= TRIGRAM_MIN_SIMILARITY);
    })
    .map((row) => hitOf(row, 'trigram'));
}

/** One hit per node, by its first (strongest) match. */
function onePerNode(hits: Array<NameHitRow>): Array<NameHitRow> {
  const seen = new Set<string>();
  return hits.filter((hit) => (seen.has(hit.nodeId) ? false : (seen.add(hit.nodeId), true)));
}

/**
 * The names one word or phrase matches under `ctx`: exact, else by stems, else by trigrams (`only` limits the ways).
 * Each hit keeps its folded name. A caller matching many words passes `stem` once (stems.ts#loadStemmer reads the
 * stored stemmer on every call).
 */
export function matchName(
  db: Db,
  ctx: Context,
  word: string,
  only: ReadonlyArray<NameMatch> = ['exact', 'stem', 'trigram'],
  stem?: (word: string) => string
): Array<NameHitRow> {
  const folded = normalName(word);
  if (folded === '' || !hasNames(db)) return [];
  const filter = audienceWhere(ctx, 'n');
  const select = (column: string, value: string): Array<Row> =>
    db
      .prepare(`SELECT ${HIT_COLUMNS} FROM names n WHERE n.${column} = ? AND ${filter.sql} ORDER BY n.node_id, n.kind`)
      .all(value, ...filter.params);
  if (only.includes('exact')) {
    const exact = select('normalized', folded);
    if (exact.length > 0) return onePerNode(exact.map((row) => hitOf(row, 'exact')));
  }
  if (only.includes('stem')) {
    const stems = stemsOf(stem ?? loadStemmer(db).stem, folded);
    const stemmed = stems === '' ? [] : select('stem', stems);
    if (stemmed.length > 0) return onePerNode(stemmed.map((row) => hitOf(row, 'stem')));
  }
  return only.includes('trigram') ? onePerNode(trigramHits(db, ctx, folded)) : [];
}

/** The nodes `words` name, read under `ctx`: per word, one hit per node by its strongest match. */
export function namesOf(db: Db, ctx: Context, words: Array<string>): Array<NameHit> {
  const { stem } = loadStemmer(db);
  return words.flatMap((word) =>
    matchName(db, ctx, word, undefined, stem).map(({ nodeId, kind, label, match, audienceId }) => ({
      nodeId,
      kind,
      label,
      match,
      audienceId,
    }))
  );
}

/** The live places `name` names under `ctx`, by exact form or stems: each place once, with its stored name. */
export function placesNamed(db: Db, ctx: Context, name: string): Array<{ id: string; name: string }> {
  const prefix = 'place:';
  const ids = new Set(
    matchName(db, ctx, name.replace(/^#/, ''), ['exact', 'stem'])
      .filter((hit) => hit.nodeId.startsWith(prefix))
      .map((hit) => hit.nodeId.slice(prefix.length))
  );
  const read = db.prepare('SELECT id, name FROM places WHERE id = ? AND retired_at IS NULL');
  return [...ids].flatMap((id) => {
    const row = read.get(id);
    return row ? [{ id, name: typeof row.name === 'string' && row.name !== '' ? row.name : id }] : [];
  });
}

/** The words and the phrases of two and three words of a text, folded, for a name lookup. */
export function phrasesOf(text: unknown, longest = 3): Array<string> {
  const words = indexWords(text);
  const out: Array<string> = [];
  for (let size = 1; size <= longest; size += 1)
    for (let i = 0; i + size <= words.length; i += 1) out.push(words.slice(i, i + size).join(' '));
  return out;
}
