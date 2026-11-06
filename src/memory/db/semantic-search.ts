// Scoped text candidates of semantic memory. The writer gives each sealed structured version one row of
// `semantic_search_documents` (`writeSearchDocument`), holding her text and its literals, and `searchSemantic` reads those
// rows through the audience of the issued context. FTS only says which rows hold a word: the rank comes from term statistics
// over the documents this context may read, so a private row never moves a public answer. A vector row lives under its own
// `semantic:` chunk key beside the source chunks and is written by `applySemanticEmbedding`; a successor with unchanged words
// inherits its base's rows. `retrieve.ts` is the one caller on the read path, and `embedSemanticDocuments` the background
// job that fills the vectors. Reading never writes.

import { createHash } from 'node:crypto';
import { foldText } from '../recent.ts';
import { audienceWhere, scopeOfAudience } from './scope.ts';
import type { Context } from './scope.ts';
import type { SemanticArgument, SemanticRef } from './semantic-types.ts';
import { dbOf } from './types.ts';
import type { Db, MemoryHandle, Row } from './types.ts';

export type SemanticSearchInput = {
  text: string;
  limit: number;
  recordedBefore: string | null;
  vector: ReadonlyArray<number> | null;
  model: string | null;
  /** Every version the context may read, also an older one and a retired one. */
  historical?: boolean;
};
export type SemanticHit = {
  versionId: string;
  claimId: string;
  ref: SemanticRef;
  streams: Array<'lexical' | 'vector'>;
  similarity: number | null;
};

/** The newest matches a search ranks: bounds the work of a word that sits in every document. */
const MAX_LEXICAL_CANDIDATES = 2000;
/** The reciprocal-rank constant that fuses the two streams, the one recall uses. */
const RRF_K = 60;
/** BM25's term saturation and length normalization. */
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const PROJECTION_VERSION = 1;

const documentKeyOf = (versionId: string): string => `sem:${versionId}`;
const chunkKeyOf = (documentKey: string, model: string): string => `semantic:${documentKey}:${model}`;

/** The words of a text as both the query and the ranking compare them: folded, runs of letters and digits. */
export const wordsOf = (text: unknown): Array<string> => foldText(text).match(/[\p{L}\p{N}]+/gu) ?? [];

/** The words a literal adds to a document; a language code and a time carry nothing someone searches by. */
function literalText(argument: SemanticArgument): string | null {
  if (!('literal' in argument) || argument.role === 'language') return null;
  return typeof argument.literal === 'string' ? argument.literal : null;
}

/**
 * The search row of one sealed version, in the writer's transaction. A successor with the same words takes over its base's
 * vector rows, so a confirmation pays for no embedding.
 */
export function writeSearchDocument(
  db: Db,
  version: {
    versionId: string;
    claimId: string;
    text: string;
    arguments: ReadonlyArray<SemanticArgument>;
    audienceId: string;
  }
): void {
  const literals = version.arguments.map(literalText).filter((one) => one !== null && one !== version.text);
  const text = [version.text, ...literals].join('\n');
  const ref = version.arguments.find((one) => 'ref' in one && one.ref.kind === 'entity') ??
    version.arguments.find((one) => 'ref' in one) ?? {
      role: 'version',
      position: 0,
      ref: { kind: 'claim_version' as const, id: version.versionId },
    };
  const documentKey = documentKeyOf(version.versionId);
  db.prepare(
    `INSERT INTO semantic_search_documents (document_key, version_id, ref_kind, ref_id, audience_id, text, projection_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    documentKey,
    version.versionId,
    (ref as { ref: SemanticRef }).ref.kind,
    (ref as { ref: SemanticRef }).ref.id,
    version.audienceId,
    text,
    PROJECTION_VERSION
  );
  const base = db
    .prepare(
      `SELECT d.document_key FROM semantic_search_documents d JOIN claim_versions v ON v.id = d.version_id
        WHERE v.claim_id = ? AND d.document_key <> ? AND d.text = ? AND d.audience_id = ? ORDER BY v.rowid DESC LIMIT 1`
    )
    .get(version.claimId, documentKey, text, version.audienceId);
  if (!base) return;
  const held = db
    .prepare(`SELECT * FROM vectors WHERE item_id = ? AND retired_at IS NULL`)
    .all(String(base.document_key));
  for (const row of held) insertVector(db, documentKey, row);
}

const vectorColumns = 'item_id, chunk_key, model, dims, scale, norm, bytes, occurred_at';

/** One vector row of a document, its scope that of the document. */
function insertVector(db: Db, documentKey: string, row: Row): void {
  const doc = db.prepare('SELECT audience_id FROM semantic_search_documents WHERE document_key = ?').get(documentKey);
  const audience = String(doc?.audience_id);
  const lookup = (place: string) => db.prepare('SELECT iface, partner_person FROM places WHERE id = ?').get(place);
  const scope = scopeOfAudience(audience, lookup);
  db.prepare(
    `INSERT OR REPLACE INTO vectors (${vectorColumns}, scope_kind, scope_iface, scope_dm, audience_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    documentKey,
    chunkKeyOf(documentKey, String(row.model)),
    row.model,
    row.dims,
    row.scale,
    row.norm,
    row.bytes,
    row.occurred_at ?? null,
    scope.scope_kind,
    scope.scope_iface,
    scope.scope_dm,
    audience
  );
}

/** One int8 row as `src/memory/vectors.ts#quantize` packs it; kept here so a writer message stays plain data. */
function quantized(vector: ReadonlyArray<number>): { bytes: Uint8Array; scale: number; norm: number } {
  const max = vector.reduce((most, x) => Math.max(most, Math.abs(x)), 0);
  const scale = max / 127;
  const signed = Int8Array.from(vector, (x) => (scale > 0 ? Math.round(x / scale) : 0));
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return { bytes: new Uint8Array(signed.buffer), scale, norm };
}

/** The writer's message `{ kind: 'semantic-embedding', documentKey, model, vector, now }`. */
export function applySemanticEmbedding(handle: MemoryHandle, update: Row): { written: number } {
  const documentKey = String(update.documentKey);
  const vector = update.vector as ReadonlyArray<number>;
  const db = dbOf(handle);
  return handle.transaction(() => {
    if (!db.prepare('SELECT 1 AS ok FROM semantic_search_documents WHERE document_key = ?').get(documentKey))
      return { written: 0 };
    const at = new Date(Number(update.now)).toISOString();
    insertVector(db, documentKey, {
      model: update.model,
      dims: vector.length,
      ...quantized(vector),
      occurred_at: at,
    });
    return { written: 1 };
  });
}

/** The documents with no vector of `model`, oldest first and at most `limit`. Asks no model. */
export function pendingSemanticEmbeddings(
  db: Db,
  { model, limit }: { model: string; limit: number }
): Array<{ documentKey: string; versionId: string; text: string }> {
  return db
    .prepare(
      `SELECT d.document_key, d.version_id, d.text FROM semantic_search_documents d
        WHERE NOT EXISTS (SELECT 1 FROM vectors v WHERE v.chunk_key = 'semantic:' || d.document_key || ':' || ?)
        ORDER BY d.rowid LIMIT ?`
    )
    .all(model, limit)
    .map((row) => ({
      documentKey: String(row.document_key),
      versionId: String(row.version_id),
      text: String(row.text),
    }));
}

/**
 * The background job beside the re-embed job (service.ts): one bounded batch of the pending documents embedded and written
 * through the writer. A failed embedding leaves them pending, and a search stays lexical until then.
 */
export async function embedSemanticDocuments({
  db,
  write,
  embed,
  config,
  model,
  now,
  limit = 20,
}: {
  db: Db;
  write: (update: Row) => Promise<unknown>;
  embed: (texts: ReadonlyArray<string>, opts: Row) => Promise<unknown>;
  config: unknown;
  model: string;
  now: number;
  limit?: number;
}): Promise<{ pending: number; written: number }> {
  const pending = pendingSemanticEmbeddings(db, { model, limit });
  if (pending.length === 0) return { pending: 0, written: 0 };
  const vectors = (await embed(
    pending.map((one) => one.text),
    { config, purpose: 'memory-semantic' }
  )) as Array<ArrayLike<number> | undefined> | undefined;
  let written = 0;
  for (const [index, one] of pending.entries()) {
    const vector = vectors?.[index];
    if (!vector || vector.length === 0) continue;
    await write({
      kind: 'semantic-embedding',
      documentKey: one.documentKey,
      model,
      vector: Array.from(vector),
      now,
    });
    written += 1;
  }
  return { pending: pending.length, written };
}

// ---------- the read ----------

/** The claims a fork stands in for, in this context: the fork speaks for the claim it names. */
export function forkedClaims(db: Db, ctx: Context): Set<string> {
  const visible = audienceWhere(ctx, 'c');
  const rows = db
    .prepare(
      `SELECT json_extract(c.extra, '$.derivedFrom') AS parent FROM claims c
        WHERE c.subject_kind = 'semantic' AND c.extra IS NOT NULL AND ${visible.sql}`
    )
    .all(...visible.params);
  return new Set(rows.map((row) => row.parent).filter((id) => typeof id === 'string'));
}

/**
 * The filter of a version (aliases `v` and `a`): its audience, the cutoff and, unless `historical`, that it is the newest of
 * its claim this context may read at the cutoff and that its state is in force.
 */
export function versionSelection(
  ctx: Context,
  input: { recordedBefore: string | null; historical?: boolean }
): { sql: string; params: Array<unknown> } {
  const visible = audienceWhere(ctx, 'a');
  const parts = [visible.sql, '(? IS NULL OR v.recorded_at <= ?)'];
  const params: Array<unknown> = [...visible.params, input.recordedBefore, input.recordedBefore];
  if (input.historical !== true) {
    const newer = audienceWhere(ctx, 'na');
    parts.push(
      `a.truth_state IN ('current', 'disputed', 'unknown') AND NOT EXISTS (
        SELECT 1 FROM claim_versions n JOIN semantic_assertion_versions na ON na.version_id = n.id
         WHERE n.claim_id = v.claim_id AND ${newer.sql} AND (? IS NULL OR n.recorded_at <= ?)
           AND (n.recorded_at > v.recorded_at OR (n.recorded_at = v.recorded_at AND n.rowid > v.rowid)))`
    );
    params.push(...newer.params, input.recordedBefore, input.recordedBefore);
  }
  return { sql: parts.join(' AND '), params };
}

const VERSION_JOINS = `JOIN claim_versions v ON v.id = d.version_id
  JOIN semantic_assertion_versions a ON a.version_id = d.version_id`;

/** How many documents this context may read: the N of its own term statistics. */
const visibleDocuments = (db: Db, ctx: Context): number => {
  const visible = audienceWhere(ctx, 'd');
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM semantic_search_documents d WHERE ${visible.sql}`)
    .get(...visible.params);
  return Number(row?.n ?? 0);
};

/** BM25 over the given rows alone: document frequency, length and N all come from what the context may read. */
function rankByVisibleTerms(rows: ReadonlyArray<Row>, terms: ReadonlyArray<string>, total: number): Array<Row> {
  const docs = rows.map((row) => {
    const words = wordsOf(row.text);
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    return { row, counts, length: words.length };
  });
  const mean = docs.reduce((sum, one) => sum + one.length, 0) / Math.max(1, docs.length);
  const idf = new Map(
    terms.map((term) => {
      const df = docs.filter((one) => one.counts.has(term)).length;
      return [term, Math.log(1 + (Math.max(total, df) - df + 0.5) / (df + 0.5))];
    })
  );
  const scoreOf = (one: (typeof docs)[number]): number =>
    terms.reduce((sum, term) => {
      const tf = one.counts.get(term) ?? 0;
      const norm = tf + BM25_K1 * (1 - BM25_B + (BM25_B * one.length) / Math.max(1, mean));
      return sum + ((idf.get(term) ?? 0) * tf * (BM25_K1 + 1)) / norm;
    }, 0);
  return docs
    .map((one) => ({ row: one.row, score: scoreOf(one) }))
    .sort((a, b) => b.score - a.score || Number(a.row.rowid) - Number(b.row.rowid))
    .map((one) => one.row);
}

/** The lexical stream: every visible match of any term, newest first up to the cap, ranked by visible statistics. */
function lexicalRows(db: Db, ctx: Context, input: SemanticSearchInput): Array<Row> {
  const terms = [...new Set(wordsOf(input.text))];
  if (terms.length === 0) return [];
  const where = versionSelection(ctx, input);
  const match = terms.map((term) => `"${term}"`).join(' OR ');
  const rows = db
    .prepare(
      `SELECT d.rowid, d.version_id, d.ref_kind, d.ref_id, d.text, v.claim_id FROM semantic_search_fts
         JOIN semantic_search_documents d ON d.rowid = semantic_search_fts.rowid ${VERSION_JOINS}
        WHERE semantic_search_fts MATCH ? AND ${where.sql} ORDER BY d.rowid DESC LIMIT ?`
    )
    .all(match, ...where.params, MAX_LEXICAL_CANDIDATES);
  return rankByVisibleTerms(rows, terms, visibleDocuments(db, ctx));
}

/** The vector stream over the visible documents, the query's model and dimensions only, best cosine first. */
function vectorRows(db: Db, ctx: Context, input: SemanticSearchInput): Array<Row & { similarity: number }> {
  const query = input.vector;
  if (query === null || query.length === 0 || input.model === null) return [];
  const queryNorm = Math.sqrt(query.reduce((sum, x) => sum + x * x, 0));
  if (!(queryNorm > 0)) return [];
  const where = versionSelection(ctx, input);
  const rows = db
    .prepare(
      `SELECT d.rowid, d.version_id, d.ref_kind, d.ref_id, v.claim_id, x.scale, x.norm, x.bytes
         FROM semantic_search_documents d ${VERSION_JOINS}
         JOIN vectors x ON x.chunk_key = 'semantic:' || d.document_key || ':' || ?
        WHERE x.dims = ? AND x.bytes IS NOT NULL AND x.retired_at IS NULL AND ${where.sql}`
    )
    .all(input.model, query.length, ...where.params);
  const scored: Array<Row & { similarity: number }> = [];
  for (const row of rows) {
    const bytes = row.bytes as Uint8Array;
    const data = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let dot = 0;
    for (let at = 0; at < query.length; at += 1) dot += data[at] * query[at];
    const similarity = (dot * Number(row.scale)) / (queryNorm * Number(row.norm));
    if (similarity > 0) scored.push({ ...row, similarity });
  }
  return scored.sort((a, b) => b.similarity - a.similarity || Number(a.rowid) - Number(b.rowid));
}

/**
 * The documents of a query this context may read, best first, up to `limit`; `visibleTotal` counts all of them and nothing
 * else. Lexical and vector results are fused by rank, and a missing vector leaves the lexical result whole. Throws without
 * a valid context.
 */
export function searchSemantic(
  db: Db,
  ctx: Context,
  input: SemanticSearchInput
): { hits: Array<SemanticHit>; visibleTotal: number } {
  audienceWhere(ctx);
  const forks = forkedClaims(db, ctx);
  const standing = (row: Row): boolean => input.historical === true || !forks.has(String(row.claim_id));
  const lexical = lexicalRows(db, ctx, input).filter(standing);
  const vector = vectorRows(db, ctx, input).filter(standing);
  const fused = new Map<string, { row: Row; score: number; hit: SemanticHit }>();
  const add = (row: Row, rank: number, stream: 'lexical' | 'vector', similarity: number | null): void => {
    const key = String(row.version_id);
    const known = fused.get(key) ?? {
      row,
      score: 0,
      hit: {
        versionId: key,
        claimId: String(row.claim_id),
        ref: { kind: row.ref_kind, id: String(row.ref_id) } as SemanticRef,
        streams: [],
        similarity: null,
      },
    };
    known.score += 1 / (RRF_K + rank);
    const { hit } = known;
    hit.streams.push(stream);
    if (similarity !== null) hit.similarity = similarity;
    fused.set(key, known);
  };
  lexical.forEach((row, rank) => add(row, rank, 'lexical', null));
  vector.forEach((row, rank) => add(row, rank, 'vector', row.similarity));
  const ranked = [...fused.values()].sort((a, b) => b.score - a.score || Number(a.row.rowid) - Number(b.row.rowid));
  return { hits: ranked.slice(0, Math.max(0, input.limit)).map((one) => one.hit), visibleTotal: ranked.length };
}

/** What every answer in this context rests on: the assertions it can read and the account links, by count and newest row. */
function revisionOf(db: Db, ctx: Context): string {
  const visible = audienceWhere(ctx, 'a');
  const facts = db
    .prepare(`SELECT COUNT(*) AS n, MAX(a.rowid) AS newest FROM semantic_assertion_versions a WHERE ${visible.sql}`)
    .get(...visible.params);
  const links = db
    .prepare(
      'SELECT COUNT(*) AS n, COALESCE(MAX(valid_to_at), MAX(recorded_at)) AS newest, SUM(valid_to_at IS NOT NULL) AS closed FROM account_person_links'
    )
    .get();
  return JSON.stringify([facts?.n, facts?.newest, links?.n, links?.newest, links?.closed]);
}

/** The audiences a context reads, as one string: two contexts that read the same rows share it. */
export function audienceKey(ctx: Context): string {
  const visible = audienceWhere(ctx);
  return JSON.stringify([visible.sql.length, visible.params]);
}

/**
 * The key a cached answer would be stored under, and what a retrieval cursor binds to: the audience the context reads, the
 * revision of what it can see and of the account links, the query and its budget. A new label, merge, retirement or conflict
 * is a new version and so a new revision; a private write moves only the private reader's key.
 */
export function semanticCacheKey(db: Db, ctx: Context, input: SemanticSearchInput): string {
  const parts = [audienceKey(ctx), revisionOf(db, ctx), input.text, input.limit, input.recordedBefore, input.model];
  return createHash('sha256')
    .update(JSON.stringify([...parts, input.vector, input.historical === true]))
    .digest('hex');
}
