// Places and people found by the memory graph for a name or a description in her words (docs/memory.md, "Finding a
// place or a person"). Code ranks, she decides: the finder lists candidates best first and never picks one for her.
//
//   placesFound(db, ctx, request, settings) -> Array<FoundPlace>
//   peopleFound(db, ctx, request, settings) -> Array<FoundPerson>
//
// A place is read as the fields the graph holds about it: its name and the names of the index that point at it, its
// stored purpose, topics and tone, the names of the people who wrote its last `lines` lines, and the words of those
// lines. A person is read as the names of the index that point at them, their stored descriptions and the live claims
// about them. Every field is read under the context, and a place or a person the context may not see is no candidate.
//
// A word of the request matches a word of a field when their stems under the learned stemmer are equal, or partly when
// the two words share a beginning of at least MIN_SHARED characters that misses at most one character of the shorter
// word (an inflected form the stemmer has not learned). A field counts its matches with a saturation, a field weighs by
// FIELD_WEIGHTS, and a word of the request weighs by how few candidates it fits (inverse document frequency), so a
// word every candidate holds weighs nothing. A candidate below RELATIVE_FLOOR of the best one's score is left out, and
// at most `candidates` come back. No model takes part. Read only.

import { indexWords } from '../record-index.ts';
import { placeAudience } from './graph.ts';
import { SELF_PERSON } from './ids.ts';
import { allowedAudience, audienceWhere, whereFor } from './scope.ts';
import type { Context } from './scope.ts';
import { loadStemmer } from './stems.ts';
import type { Db, Row } from './types.ts';

/** A place that fits a request: its id, its stored name, its purpose when one is stored, and its score. */
export type FoundPlace = { id: string; name: string; about: string | null; score: number };
/** A person who fits a request: their id, their first name, their character when one is stored, and their score. */
export type FoundPerson = { id: string; name: string; about: string | null; score: number };
/** How many candidates come back at most, and how many of a place's last lines are read. */
export type FindSettings = { candidates: number; lines: number };

/** The shipped values of `context.find` in config/config.json, for a key the live settings lack. */
export const FIND_DEFAULTS: Readonly<FindSettings> = Object.freeze({ candidates: 5, lines: 100 });

/** The shortest beginning two words share for a partial match, and the credit of one. */
const MIN_SHARED = 4;
const PARTIAL = 0.7;
/** The saturation of a field's count of matches (BM25's k1). */
const SATURATION = 1.2;
/** A candidate is kept from this share of the best candidate's score. */
const RELATIVE_FLOOR = 0.2;
/** The longest `about` a candidate carries, in characters. */
const ABOUT_CHARS = 200;

type Field = 'name' | 'purpose' | 'topics' | 'tone' | 'people' | 'lines' | 'description' | 'claims';
const FIELD_WEIGHTS: Readonly<Record<Field, number>> = Object.freeze({
  name: 3,
  purpose: 2,
  topics: 2,
  tone: 1,
  people: 1.5,
  lines: 1,
  description: 2,
  claims: 1.5,
});

/** One candidate as the ranker reads it: its fields, each a count per folded word. */
type Doc = { id: string; fields: Map<Field, Map<string, number>> };

const isObj = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

/** The finder's settings from the live config (`context.find`), each missing or broken key at its shipped value. */
export function findSettingsOf(config: unknown): FindSettings {
  const context = isObj(config) && isObj(config.context) ? config.context : {};
  const find = isObj(context.find) ? context.find : {};
  const count = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
  return {
    candidates: count(find.candidates, FIND_DEFAULTS.candidates),
    lines: count(find.lines, FIND_DEFAULTS.lines),
  };
}

/** Adds the words of `value` to a field of `doc`. */
function addWords(doc: Doc, field: Field, value: unknown): void {
  const words = indexWords(value);
  if (words.length === 0) return;
  const counts = doc.fields.get(field) ?? new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  doc.fields.set(field, counts);
}

/** How many characters two words share from their start. */
function sharedStart(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  let n = 0;
  while (n < left.length && n < right.length && left[n] === right[n]) n += 1;
  return n;
}

/** The credit of a doc word for a request word: 1 for one stem, PARTIAL for a shared beginning, else 0. */
function credit(query: string, queryStem: string, word: string, stem: (word: string) => string): number {
  if (word === query || stem(word) === queryStem) return 1;
  const shared = sharedStart(query, word);
  const shorter = Math.min([...query].length, [...word].length);
  return shared >= MIN_SHARED && shared >= shorter - 1 ? PARTIAL : 0;
}

/** The words of the vocabulary that match `query`, each with its credit. */
function creditsOf(
  query: string,
  vocabulary: ReadonlySet<string>,
  stem: (word: string) => string
): Map<string, number> {
  const queryStem = stem(query);
  const credits = new Map<string, number>();
  for (const word of vocabulary) {
    const given = credit(query, queryStem, word, stem);
    if (given > 0) credits.set(word, given);
  }
  return credits;
}

/** How well one candidate fits the matching words: each field's saturated count of matches, by its weight. */
function fitOf(doc: Doc, credits: ReadonlyMap<string, number>): number {
  let fit = 0;
  for (const [field, counts] of doc.fields) {
    let matched = 0;
    for (const [word, given] of credits) matched += given * (counts.get(word) ?? 0);
    if (matched > 0) fit += FIELD_WEIGHTS[field] * ((matched * (SATURATION + 1)) / (matched + SATURATION));
  }
  return fit;
}

/** The weight of a word that `df` of `n` candidates fit; a word every candidate of several holds tells none apart. */
const idfOf = (n: number, df: number): number => (n > 1 && df >= n ? 0 : Math.log(1 + (n - df + 0.5) / (df + 0.5)));

/** The candidates ranked against `request`, best first, with their scores; those that fit nothing are left out. */
function rank(
  docs: ReadonlyArray<Doc>,
  request: string,
  stem: (word: string) => string
): Array<{ id: string; score: number }> {
  const queries = [...new Set(indexWords(request))];
  if (queries.length === 0 || docs.length === 0) return [];
  const vocabulary = new Set<string>();
  for (const doc of docs)
    for (const counts of doc.fields.values()) for (const word of counts.keys()) vocabulary.add(word);
  const scores = new Map<string, number>();
  for (const query of queries) {
    const credits = creditsOf(query, vocabulary, stem);
    if (credits.size === 0) continue;
    const fits = docs.map((doc) => ({ id: doc.id, fit: fitOf(doc, credits) })).filter((one) => one.fit > 0);
    const idf = idfOf(docs.length, fits.length);
    for (const { id, fit } of fits) scores.set(id, (scores.get(id) ?? 0) + idf * fit);
  }
  const ranked = [...scores]
    .filter(([, score]) => score > 0)
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const best = ranked[0]?.score ?? 0;
  return ranked.filter((one) => one.score >= best * RELATIVE_FLOOR);
}

/** A stored text clipped to ABOUT_CHARS. */
const aboutOf = (value: string | null): string | null =>
  value === null
    ? null
    : [...value].length <= ABOUT_CHARS
      ? value
      : `${[...value].slice(0, ABOUT_CHARS - 1).join('')}…`;

/** The names of the index that point at `nodeId` under the context. */
function indexNames(db: Db, ctx: Context, nodeId: string): Array<string> {
  const filter = audienceWhere(ctx, 'n');
  return db
    .prepare(`SELECT n.label FROM names n WHERE n.node_id = ? AND ${filter.sql} ORDER BY n.kind, n.label`)
    .all(nodeId, ...filter.params)
    .flatMap((row) => (typeof row.label === 'string' ? [row.label] : []));
}

/** The current text of every live description of a subject the context reads, by field. */
function descriptionsOf(
  db: Db,
  ctx: Context,
  kind: 'place' | 'person',
  subject: string
): Array<{ field: string; text: string }> {
  const where = whereFor(ctx, 'd');
  return db
    .prepare(
      `SELECT d.field, v.text FROM descriptions d JOIN description_versions v ON v.id = d.current_version
       WHERE d.subject_kind = ? AND d.subject_id = ? AND d.retired_at IS NULL AND ${where.sql}
       ORDER BY d.field, d.scope_kind = 'dm' DESC, d.id`
    )
    .all(kind, subject, ...where.params)
    .flatMap((row) => {
      const field = text(row.field);
      const value = text(row.text);
      return field === null || value === null ? [] : [{ field, text: value }];
    });
}

/** The live places the context may read, servers left out. */
function readablePlaces(db: Db, ctx: Context): Array<Row> {
  return db
    .prepare(
      "SELECT id, iface, kind, chat, name, partner_account FROM places WHERE retired_at IS NULL AND kind <> 'server' ORDER BY id"
    )
    .all()
    .filter((place) => allowedAudience({ audience_id: placeAudience(place) }, ctx));
}

/** The first display name of an account, null when it has none. */
function accountName(db: Db, account: string): string | null {
  const row = db.prepare('SELECT names FROM accounts WHERE id = ?').get(account);
  try {
    const names: unknown = JSON.parse(typeof row?.names === 'string' ? row.names : '[]');
    return Array.isArray(names) ? (names.map(text).find((name) => name !== null) ?? null) : null;
  } catch {
    return null;
  }
}

/** The places that fit `request` under the context, best first, at most `settings.candidates`. */
export function placesFound(
  db: Db,
  ctx: Context,
  request: string,
  settings: Partial<FindSettings> = {}
): Array<FoundPlace> {
  const { candidates, lines } = { ...FIND_DEFAULTS, ...settings };
  if (candidates === 0 || indexWords(request).length === 0) return [];
  const where = whereFor(ctx, 's');
  const recent = db.prepare(
    `SELECT s.author_account, s.text FROM sources s
     WHERE s.place_id = ? AND s.kind IN ('seen', 'said') AND s.retired_at IS NULL AND ${where.sql}
     ORDER BY s.occurred_at DESC LIMIT ?`
  );
  const shown = new Map<string, { name: string; about: string | null }>();
  const names = new Map<string, string | null>();
  const docs = readablePlaces(db, ctx).map((place) => {
    const id = String(place.id);
    const doc: Doc = { id, fields: new Map() };
    addWords(doc, 'name', place.name);
    for (const name of indexNames(db, ctx, `place:${id}`)) addWords(doc, 'name', name);
    let purpose: string | null = null;
    for (const { field, text: value } of descriptionsOf(db, ctx, 'place', id)) {
      if (field === 'purpose' || field === 'topics' || field === 'tone') addWords(doc, field, value);
      if (field === 'purpose' && purpose === null) purpose = value;
    }
    for (const line of recent.all(id, ...where.params, lines)) {
      addWords(doc, 'lines', line.text);
      const author = text(line.author_account);
      if (author === null) continue;
      if (!names.has(author)) names.set(author, accountName(db, author));
      addWords(doc, 'people', names.get(author));
    }
    const partner = text(place.partner_account);
    const name = text(place.name) ?? (partner === null ? null : accountName(db, partner)) ?? id;
    shown.set(id, { name, about: aboutOf(purpose) });
    return doc;
  });
  return rank(docs, request, loadStemmer(db).stem)
    .slice(0, candidates)
    .map(({ id, score }) => ({ id, name: shown.get(id)?.name ?? id, about: shown.get(id)?.about ?? null, score }));
}

/** The people that fit `request` under the context, best first, at most `settings.candidates`; never herself. */
export function peopleFound(
  db: Db,
  ctx: Context,
  request: string,
  settings: Partial<FindSettings> = {}
): Array<FoundPerson> {
  const { candidates } = { ...FIND_DEFAULTS, ...settings };
  if (candidates === 0 || indexWords(request).length === 0) return [];
  const filter = audienceWhere(ctx, 'n');
  const people = db
    .prepare(
      `SELECT DISTINCT substr(n.node_id, 8) AS id FROM names n JOIN people p ON p.id = substr(n.node_id, 8)
       WHERE n.node_id LIKE 'person:%' AND p.retired_at IS NULL AND COALESCE(p.status, '') NOT LIKE 'merged_into:%'
         AND ${filter.sql} ORDER BY id`
    )
    .all(...filter.params)
    .flatMap((row) => (typeof row.id === 'string' && row.id !== SELF_PERSON ? [row.id] : []));
  const claims = whereFor(ctx, 'c');
  const claimsOf = db.prepare(
    `SELECT c.text FROM claims c WHERE c.subject_kind = 'person' AND c.subject_id = ? AND c.retired_at IS NULL
       AND c.kind <> 'alias' AND ${claims.sql} ORDER BY c.id`
  );
  const shown = new Map<string, { name: string; about: string | null }>();
  const docs = people.map((id) => {
    const doc: Doc = { id, fields: new Map() };
    const labels = indexNames(db, ctx, `person:${id}`);
    for (const name of labels) addWords(doc, 'name', name);
    let character: string | null = null;
    for (const { field, text: value } of descriptionsOf(db, ctx, 'person', id)) {
      addWords(doc, 'description', value);
      if (field === 'character' && character === null) character = value;
    }
    for (const claim of claimsOf.all(id, ...claims.params)) addWords(doc, 'claims', claim.text);
    shown.set(id, { name: labels[0] ?? id, about: aboutOf(character) });
    return doc;
  });
  return rank(docs, request, loadStemmer(db).stem)
    .slice(0, candidates)
    .map(({ id, score }) => ({ id, name: shown.get(id)?.name ?? id, about: shown.get(id)?.about ?? null, score }));
}
