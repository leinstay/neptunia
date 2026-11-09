// The one bounded retrieval service. `retrieveMemory` turns a query and explicit anchors into versioned assertions, their
// evidence, source ids and association paths under a context the core issued, and every consumer of memory context reads
// through it (src/memory/retrieval-input.ts makes each consumer's query). It is code alone: names and words find seeds, the
// typed arguments of sealed versions give the neighbours, and nothing here asks a model except for the one query embedding
// a caller supplies. A path is an association and never a new fact.
//
// The work is a breadth-first walk over `semantic_arguments` inside one shared budget, with per-seed fairness: each node of a
// layer gives one assertion in turn, so a hub cannot spend what the entity a person named needs. Every read filters by the
// context's audience before any limit, so a private row is never counted, ranked or walked through. A bound that stops the
// work says which in `partialReason` and leaves a cursor bound to the context, the query and the revision of what the context
// can see. A plain source and a plain claim with no entity are their own streams, with a share semantic rows cannot take.
//
// The reads run in one read transaction on the connection they are given, after the embedding came back. Nothing is written.

import { createHash } from 'node:crypto';
import { RECALL_DEFAULTS, fuseRanks } from '../../behavior/recall.ts';
import { estimateTokens } from '../../llm/tokens.ts';
import { objectMeaning } from './object-vectors.ts';
import { dbSettings, search } from './recall.ts';
import type { DbSettings } from './recall.ts';
import { audienceWhere } from './scope.ts';
import type { Context } from './scope.ts';
import { LABEL_PREDICATE } from './semantic-registry.ts';
import { followMerges, resolveLabel } from './semantic-read.ts';
import { normalizeLabel, entityWitnesses, visibleMerges } from './semantic-rows.ts';
import {
  audienceKey,
  forkedClaims,
  searchSemantic,
  semanticCacheKey,
  versionSelection,
  wordsOf,
} from './semantic-search.ts';
import type { SemanticHit } from './semantic-search.ts';
import type {
  MemoryPage,
  MemoryQuery,
  RetrievedAssertion,
  SemanticArgument,
  SemanticDependency,
  SemanticEvidence,
  SemanticLiteral,
  SemanticRef,
} from './semantic-types.ts';
import type { Db, Row } from './types.ts';

export type RetrieveDeps = {
  now: () => number;
  /** The one embedding of a query, a failure or a null leaving the lexical streams. */
  embedQuery: ((text: string) => Promise<ArrayLike<number> | null | undefined>) | null;
  model: string | null;
  /** False when the caller has searched the sources itself (the prefetch's and the search's windows). */
  sources?: boolean;
  /** False for a read that wants structured facts alone (the prefetch: her profiles already show plain claims). */
  plainClaims?: boolean;
  /** The recall settings of the source stream, the defaults without them. */
  recall?: DbSettings | null;
  /** The cosine under which a document found by meaning alone is no hit. */
  minSimilarity?: number;
};

type Reason = NonNullable<MemoryPage['partialReason']>;
type GraphPath = { from: SemanticRef; versionIds: Array<string> };
type WalkNode = { ref: SemanticRef; hop: number; paths: Array<GraphPath>; anchored: boolean };
type Cursor = {
  bind: string;
  revision: string;
  seen: Array<string>;
  visited: Array<string>;
  frontier: Array<WalkNode>;
};
/** One version as the reads load it: all of an assertion except what the budget may trim. */
type Loaded = Omit<RetrievedAssertion, 'evidence'> & { evidence: Array<SemanticEvidence>; recordedAt: string };

/** How many parallel paths one node keeps: a diamond shows, a clique does not enumerate. */
const MAX_PATHS_PER_NODE = 4;
/** How many words of a query form its source search. */
const MAX_SOURCE_FORMS = 8;
/** A word in more than this share of the visible plain claims says nothing about any of them. */
const COMMON_WORD_SHARE = 0.25;
const COMMON_WORD_MIN_CLAIMS = 20;

const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const keyOf = (ref: SemanticRef): string => `${ref.kind}\u0000${ref.id}`;

const parseLiteral = (text: unknown): SemanticLiteral => JSON.parse(String(text)) as SemanticLiteral;

/** The arguments of a version in their role order. */
function argumentsOf(db: Db, versionId: string): Array<SemanticArgument> {
  return db
    .prepare(
      'SELECT role, position, ref_kind, ref_id, literal_json FROM semantic_arguments WHERE version_id = ? ORDER BY role, position'
    )
    .all(versionId)
    .map((row) => {
      const place = { role: String(row.role), position: Number(row.position) };
      if (row.ref_kind === null) return { ...place, literal: parseLiteral(row.literal_json) };
      return { ...place, ref: { kind: row.ref_kind, id: String(row.ref_id) } } as SemanticArgument;
    });
}

/** The evidence of a version the context may read, in the order it was linked. */
function evidenceOf(db: Db, ctx: Context, versionId: string): Array<SemanticEvidence> {
  const visible = audienceWhere(ctx, 's');
  return db
    .prepare(
      `SELECT l.source_id, l.role FROM claim_version_sources l JOIN sources s ON s.id = l.source_id
        WHERE l.version_id = ? AND ${visible.sql} ORDER BY l.rowid`
    )
    .all(versionId, ...visible.params)
    .map((row) => ({ sourceId: String(row.source_id), role: row.role as SemanticEvidence['role'] }));
}

/** The premises of a version the context may read, and whether one of them has a newer version at the cutoff. */
function premisesOf(
  db: Db,
  ctx: Context,
  versionId: string,
  recordedBefore: string | null
): { dependencies: Array<SemanticDependency>; needsReview: boolean } {
  const visible = audienceWhere(ctx, 'a');
  const rows = db
    .prepare(
      `SELECT d.premise_version_id, d.role, v.claim_id FROM semantic_dependencies d
         JOIN semantic_assertion_versions a ON a.version_id = d.premise_version_id
         JOIN claim_versions v ON v.id = d.premise_version_id
        WHERE d.version_id = ? AND ${visible.sql} ORDER BY d.premise_version_id, d.role`
    )
    .all(versionId, ...visible.params);
  const newest = db.prepare(
    `SELECT v.id FROM claim_versions v JOIN semantic_assertion_versions a ON a.version_id = v.id
      WHERE v.claim_id = ? AND ${visible.sql} AND (? IS NULL OR v.recorded_at <= ?)
      ORDER BY v.recorded_at DESC, v.rowid DESC LIMIT 1`
  );
  return {
    dependencies: rows.map((row) => ({
      versionId: String(row.premise_version_id),
      role: row.role as SemanticDependency['role'],
    })),
    needsReview: rows.some(
      (row) =>
        newest.get(row.claim_id, ...visible.params, recordedBefore, recordedBefore)?.id !== row.premise_version_id
    ),
  };
}

const VERSION_COLUMNS = `a.version_id, a.assertion_kind, a.truth_state, a.polarity, v.claim_id, v.text, v.recorded_at`;

/** A structured or snapshotted version row as a page holds it, with its state from the version and never the parent. */
function loadVersion(db: Db, ctx: Context, row: Row, recordedBefore: string | null): Loaded {
  const versionId = String(row.version_id);
  return {
    claimId: String(row.claim_id),
    versionId,
    assertionKind: row.assertion_kind as Loaded['assertionKind'],
    text: String(row.text),
    polarity: row.polarity as Loaded['polarity'],
    state: row.truth_state as Loaded['state'],
    arguments: argumentsOf(db, versionId),
    evidence: evidenceOf(db, ctx, versionId),
    ...premisesOf(db, ctx, versionId, recordedBefore),
    recordedAt: String(row.recorded_at),
  };
}

/** The filters of a query over versions (aliases `v` and `a`): selection, the moment of validity and the predicates. */
function queryFilter(ctx: Context, query: MemoryQuery): { sql: string; params: Array<unknown> } {
  const selection = versionSelection(ctx, {
    recordedBefore: query.recordedBefore,
    historical: query.includeHistorical,
  });
  const parts = [selection.sql];
  const params = [...selection.params];
  if (query.validAt !== null) {
    parts.push('(a.valid_from_at IS NULL OR a.valid_from_at <= ?) AND (a.valid_to_at IS NULL OR a.valid_to_at >= ?)');
    params.push(query.validAt, query.validAt);
  }
  if (query.predicates.length > 0) {
    parts.push(`a.predicate_id IN (${query.predicates.map(() => '?').join(', ')})`);
    params.push(...query.predicates);
  }
  return { sql: parts.join(' AND '), params };
}

/** The state of one call: what the page holds so far and what remains of its budget. */
class Walk {
  readonly page: MemoryPage = {
    assertions: [],
    sourceIds: [],
    paths: [],
    next: null,
    partialReason: null,
    ambiguous: [],
    signals: [],
  };
  readonly seen: Set<string>;
  readonly visited: Set<string>;
  edges = 0;
  tokens = 0;
  evidence = 0;
  stopped = false;
  emitted = 0;
  private readonly started: number;
  private readonly bounds: MemoryQuery['bounds'];
  private readonly now: () => number;

  constructor(query: MemoryQuery, deps: RetrieveDeps, seen: ReadonlyArray<string>, visited: ReadonlyArray<string>) {
    this.bounds = query.bounds;
    this.now = deps.now;
    this.started = deps.now();
    this.seen = new Set(seen);
    this.visited = new Set(visited);
  }

  stop(reason: Reason): void {
    this.stopped = true;
    this.mark(reason);
  }

  /** Adds the paths that reached `to`, each ending there. */
  addPaths(paths: ReadonlyArray<GraphPath>, to: SemanticRef): void {
    const { page } = this;
    page.paths.push(...paths.map((path) => ({ ...path, to })));
  }

  /** Records a name that matched more than one ref, so the page can say which it could not tell apart. */
  addAmbiguous(text: string, candidates: Array<SemanticRef>): void {
    const { page } = this;
    page.ambiguous.push({ text, candidates });
  }

  /** The first reason is the one a page reports. */
  mark(reason: Reason): void {
    this.page.partialReason ??= reason;
  }

  overDeadline(): boolean {
    return this.now() - this.started >= this.bounds.deadlineMs;
  }

  /** Whether this assertion may join the page; a bound it hits stops the walk first. */
  admits(one: Loaded): boolean {
    if (this.overDeadline()) {
      this.stop('deadline');
      return false;
    }
    if (this.emitted >= this.bounds.assertions) {
      this.stop('assertions');
      return false;
    }
    const refs = one.arguments.filter((argument) => 'ref' in argument).length;
    if (this.emitted > 0 && this.edges + refs > this.bounds.edges) {
      this.stop('edges');
      return false;
    }
    if (this.evidence >= this.bounds.evidence) {
      this.stop('evidence');
      return false;
    }
    const cost = estimateTokens(one.text);
    if (this.tokens + cost > this.bounds.tokens) {
      // One fact larger than the whole budget can never fit: it is passed over so a cursor still makes progress.
      if (cost > this.bounds.tokens) this.seen.add(one.versionId);
      this.stop('tokens');
      return false;
    }
    return true;
  }

  /** Adds a whole assertion, its evidence trimmed to what is left, with its signals kept apart. */
  emit(one: Loaded, signal: { hops: number | null; anchored: boolean; similarity: number | null }): void {
    const left = this.bounds.evidence - this.evidence;
    const evidence = one.evidence.slice(0, left);
    this.evidence += evidence.length;
    this.edges += one.arguments.filter((argument) => 'ref' in argument).length;
    this.tokens += estimateTokens(one.text);
    this.emitted += 1;
    this.seen.add(one.versionId);
    const { page } = this;
    page.assertions.push({
      claimId: one.claimId,
      versionId: one.versionId,
      assertionKind: one.assertionKind,
      text: one.text,
      polarity: one.polarity,
      state: one.state,
      arguments: one.arguments,
      evidence,
      dependencies: one.dependencies,
      needsReview: one.needsReview,
    });
    page.signals.push({ versionId: one.versionId, ...signal });
    if (evidence.length < one.evidence.length) this.stop('evidence');
  }
}

// ---------- seeds ----------

type Merges = ReadonlyMap<string, string>;

/** A reference as this context takes it: an entity at the end of its visible equivalences. */
const canonical = (ref: SemanticRef, merges: Merges): SemanticRef =>
  ref.kind === 'entity' ? { kind: 'entity', id: followMerges(merges, ref.id) } : ref;

/** The explicit anchors a context may start from: an entity with no witness here does not exist here. */
function anchorNodes(db: Db, ctx: Context, query: MemoryQuery, merges: Merges): Array<WalkNode> {
  return query.anchors
    .filter((ref) => ref.kind !== 'entity' || entityWitnesses(db, ctx, ref.id, query.recordedBefore).length > 0)
    .map((ref) => {
      const seed = canonical({ kind: ref.kind, id: ref.id }, merges);
      return { ref: seed, hop: 1, paths: [{ from: seed, versionIds: [] }], anchored: true };
    });
}

/** The labels among the hits that the query says in full, each resolved with every entity it may mean. */
function namedSeeds(
  db: Db,
  ctx: Context,
  query: MemoryQuery,
  hits: ReadonlyArray<SemanticHit>,
  walk: Walk
): Array<SemanticRef> {
  const spoken = ` ${wordsOf(query.text).join(' ')} `;
  const label = db.prepare(
    `SELECT l.text, l.normalized FROM semantic_labels l JOIN semantic_assertion_versions a ON a.version_id = l.version_id
      WHERE l.version_id = ? AND a.predicate_id = ?`
  );
  const names = new Map<string, string>();
  for (const hit of hits) {
    for (const row of label.all(hit.versionId, LABEL_PREDICATE)) {
      if (spoken.includes(` ${wordsOf(row.text).join(' ')} `)) names.set(String(row.normalized), String(row.text));
    }
  }
  const seeds: Array<SemanticRef> = [];
  for (const text of names.values()) {
    const found = resolveLabel(db, ctx, { text, language: null, recordedBefore: query.recordedBefore });
    const refs = found.candidates.map((one) => one.ref);
    if (found.status === 'ambiguous') walk.addAmbiguous(normalizeLabel(text), refs);
    seeds.push(...refs);
  }
  return seeds;
}

/** The first nodes of a walk: anchors, then the names the query says, then the entities its direct hits name. */
function seedNodes(
  db: Db,
  ctx: Context,
  query: MemoryQuery,
  hits: ReadonlyArray<SemanticHit>,
  merges: Merges,
  walk: Walk
): Array<WalkNode> {
  const named = namedSeeds(db, ctx, query, hits, walk);
  const fromHits = hits.filter((hit) => hit.ref.kind === 'entity').map((hit) => hit.ref);
  const textual = [...named, ...fromHits].map((ref): WalkNode => {
    const seed = canonical(ref, merges);
    return { ref: seed, hop: 1, paths: [{ from: seed, versionIds: [] }], anchored: false };
  });
  const out = new Map<string, WalkNode>();
  for (const node of [...anchorNodes(db, ctx, query, merges), ...textual]) {
    if (!out.has(keyOf(node.ref))) out.set(keyOf(node.ref), node);
  }
  return [...out.values()];
}

// ---------- the walk ----------

/** The refs that stand for one node: an entity with every entity this context merges into it. */
function membersOf(ref: SemanticRef, merges: Merges): Array<string> {
  if (ref.kind !== 'entity') return [ref.id];
  return [ref.id, ...[...merges.keys()].filter((id) => id !== ref.id && followMerges(merges, id) === ref.id)];
}

/** What a node shows: the versions naming it that the context selects, newest first, seen ones left out. */
function incident(
  db: Db,
  ctx: Context,
  query: MemoryQuery,
  node: WalkNode,
  merges: Merges,
  walk: Walk,
  forks: ReadonlySet<string>
): Array<Row> {
  const filter = queryFilter(ctx, query);
  const ids = membersOf(node.ref, merges);
  const rows = db
    .prepare(
      `SELECT DISTINCT ${VERSION_COLUMNS}, v.rowid AS version_rowid FROM semantic_arguments g
         JOIN semantic_assertion_versions a ON a.version_id = g.version_id
         JOIN claim_versions v ON v.id = g.version_id
        WHERE g.ref_kind = ? AND g.ref_id IN (${ids.map(() => '?').join(', ')}) AND ${filter.sql}
        ORDER BY v.recorded_at DESC, v.rowid DESC LIMIT ?`
    )
    .all(node.ref.kind, ...ids, ...filter.params, query.bounds.edges + query.bounds.assertions + walk.seen.size + 1);
  return rows.filter(
    (row) => !walk.seen.has(String(row.version_id)) && (query.includeHistorical || !forks.has(String(row.claim_id)))
  );
}

/** The neighbours one emitted assertion opens: each new one joins the next layer, with its paths and within the node bound. */
function discover(
  walk: Walk,
  query: MemoryQuery,
  node: WalkNode,
  one: Loaded,
  merges: Merges,
  next: Map<string, WalkNode>
): void {
  for (const argument of one.arguments) {
    if (!('ref' in argument)) continue;
    const ref = canonical(argument.ref, merges);
    const key = keyOf(ref);
    if (key === keyOf(node.ref)) continue;
    const paths = node.paths.map((path) => ({ from: path.from, versionIds: [...path.versionIds, one.versionId] }));
    const known = next.get(key);
    if (known !== undefined) {
      const room = paths.slice(0, Math.max(0, MAX_PATHS_PER_NODE - known.paths.length));
      known.paths.push(...room);
      walk.addPaths(room, ref);
      continue;
    }
    if (walk.visited.has(key)) continue;
    const kept = paths.slice(0, MAX_PATHS_PER_NODE);
    walk.visited.add(key);
    next.set(key, { ref, hop: node.hop + 1, paths: kept, anchored: false });
    walk.addPaths(kept, ref);
    if (walk.visited.size > query.bounds.nodes) walk.stop('nodes');
  }
}

/** Each node of a layer gives one assertion in turn, until the layer is done or a bound stops the walk. */
function expandLayer(
  db: Db,
  ctx: Context,
  query: MemoryQuery,
  layer: ReadonlyArray<WalkNode>,
  merges: Merges,
  walk: Walk,
  forks: ReadonlySet<string>
): Map<string, WalkNode> {
  const next = new Map<string, WalkNode>();
  const queues = layer.map((node) => ({ node, rows: incident(db, ctx, query, node, merges, walk, forks) }));
  for (let moved = true; moved && !walk.stopped;) {
    moved = false;
    for (const queue of queues) {
      if (walk.stopped) break;
      let row = queue.rows.shift();
      while (row !== undefined && walk.seen.has(String(row.version_id))) row = queue.rows.shift();
      if (row === undefined) continue;
      moved = true;
      const one = loadVersion(db, ctx, row, query.recordedBefore);
      if (!walk.admits(one)) break;
      walk.emit(one, { hops: queue.node.hop, anchored: queue.node.anchored, similarity: null });
      discover(walk, query, queue.node, one, merges, next);
    }
  }
  return next;
}

/** Whether a node beyond the last hop still has something this context has not been shown. */
const hasMore = (
  db: Db,
  ctx: Context,
  query: MemoryQuery,
  node: WalkNode,
  merges: Merges,
  walk: Walk,
  forks: ReadonlySet<string>
): boolean => incident(db, ctx, query, node, merges, walk, forks).length > 0;

/** The walk from a frontier, layer by layer; returns the frontier a cursor continues from. */
function walkFrom(
  db: Db,
  ctx: Context,
  query: MemoryQuery,
  start: ReadonlyArray<WalkNode>,
  merges: Merges,
  walk: Walk,
  forks: ReadonlySet<string>
): Array<WalkNode> {
  let frontier = [...start];
  const lastHop = (frontier[0]?.hop ?? 1) + query.bounds.hops - 1;
  const seeded = new Set(frontier.filter((node) => node.hop === frontier[0]?.hop).slice(0, query.bounds.seeds));
  if (frontier.some((node) => node.hop === frontier[0]?.hop && !seeded.has(node))) walk.mark('seeds');
  let first = true;
  while (frontier.length > 0 && !walk.stopped) {
    const hop = Math.min(...frontier.map((node) => node.hop));
    if (hop > lastHop) break;
    const layer = frontier.filter((node) => node.hop === hop && (!first || seeded.has(node)));
    const rest = frontier.filter((node) => !layer.includes(node));
    first = false;
    const next = expandLayer(db, ctx, query, layer, merges, walk, forks);
    if (walk.stopped) return [...layer, ...rest, ...next.values()];
    frontier = [...rest, ...next.values()];
  }
  if (!walk.stopped && frontier.some((node) => hasMore(db, ctx, query, node, merges, walk, forks))) walk.mark('depth');
  return frontier;
}

// ---------- the direct streams ----------

/** The hits of the query's text as loaded versions, under the same filters as the walk. */
function directVersions(
  db: Db,
  ctx: Context,
  query: MemoryQuery,
  hits: ReadonlyArray<SemanticHit>
): Array<Loaded & { similarity: number | null }> {
  const filter = queryFilter(ctx, query);
  const read = db.prepare(
    `SELECT ${VERSION_COLUMNS} FROM semantic_assertion_versions a JOIN claim_versions v ON v.id = a.version_id
      WHERE a.version_id = ? AND ${filter.sql}`
  );
  return hits.flatMap((hit) => {
    const row = read.get(hit.versionId, ...filter.params);
    return row ? [{ ...loadVersion(db, ctx, row, query.recordedBefore), similarity: hit.similarity }] : [];
  });
}

/** A plain claim's newest version at the cutoff; metadata its version never had stays `unknown`. */
function plainVersion(db: Db, ctx: Context, claim: Row, query: MemoryQuery): Loaded | null {
  const row = db
    .prepare(
      `SELECT v.id, v.text, v.recorded_at, a.truth_state, a.polarity, a.assertion_kind FROM claim_versions v
         LEFT JOIN semantic_assertion_versions a ON a.version_id = v.id
        WHERE v.claim_id = ? AND v.retired_at IS NULL AND (? IS NULL OR v.recorded_at <= ?)
        ORDER BY v.recorded_at DESC, v.rowid DESC LIMIT 1`
    )
    .get(claim.id, query.recordedBefore, query.recordedBefore);
  if (!row) return null;
  return {
    claimId: String(claim.id),
    versionId: String(row.id),
    assertionKind: 'text',
    text: String(row.text),
    polarity: (row.polarity ?? 'unknown') as Loaded['polarity'],
    state: (row.truth_state ?? 'unknown') as Loaded['state'],
    arguments: [],
    evidence: evidenceOf(db, ctx, String(row.id)),
    dependencies: [],
    needsReview: false,
    recordedAt: String(row.recorded_at),
  };
}

/**
 * The learned claims with no structured form whose words the query says, ranked by the words only this context's claims
 * make rare, fused by rank with the claims whose vector meets the query's at or above `minMeaning`. The scan folds in
 * code, because SQLite compares Cyrillic by bytes. On a tie the word list goes first, and with no vector the page is the
 * word list alone. Predicates and validity belong to structured facts, so a filter on either leaves this stream out.
 */
function plainClaims(
  db: Db,
  ctx: Context,
  query: MemoryQuery,
  walk: Walk,
  limit: number,
  meaning: { vector: ArrayLike<number> | null; model: string | null; minMeaning: number }
): Array<Loaded> {
  const terms = [...new Set(wordsOf(query.text))];
  if (terms.length === 0 || limit <= 0 || query.predicates.length > 0 || query.validAt !== null) return [];
  const visible = audienceWhere(ctx, 'c');
  const inForce = query.includeHistorical
    ? ''
    : `AND c.shown = 1 AND (c.truth IS NULL OR c.truth IN ('current', 'disputed'))`;
  const held: Array<{ id: unknown; words: Set<string> }> = [];
  const frequency = new Map<string, number>();
  const meant = objectMeaning(db, ctx, { ...meaning, kinds: ['claim'] });
  const standing = new Set<string>();
  let total = 0;
  for (const claim of db
    .prepare(
      `SELECT c.id, c.text FROM claims c WHERE c.subject_kind IS NOT 'semantic' AND c.retired_at IS NULL ${inForce} AND ${visible.sql}`
    )
    .iterate(...visible.params)) {
    total += 1;
    if (total % 1024 === 0 && walk.overDeadline()) break;
    if (meant.length > 0) standing.add(String(claim.id));
    const words = new Set(wordsOf(claim.text));
    const found = terms.filter((term) => words.has(term));
    if (found.length === 0) continue;
    for (const term of found) frequency.set(term, (frequency.get(term) ?? 0) + 1);
    held.push({ id: claim.id, words });
  }
  const common = (term: string): boolean =>
    total >= COMMON_WORD_MIN_CLAIMS && (frequency.get(term) ?? 0) / total > COMMON_WORD_SHARE;
  const useful = terms.filter((term) => !common(term));
  const weight = (term: string): number => Math.log(1 + total / (frequency.get(term) ?? 1));
  const scored = held
    .map((one) => ({
      id: one.id,
      score: useful.filter((term) => one.words.has(term)).reduce((sum, term) => sum + weight(term), 0),
    }))
    .filter((one) => one.score > 0)
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  const byWords = scored.map((one) => String(one.id));
  const byMeaning = meant.filter((hit) => standing.has(hit.itemId)).map((hit) => hit.itemId);
  const ranked = byMeaning.length === 0 ? byWords : fuseRanks([byWords, byMeaning]).map((one) => String(one.id));
  const out: Array<Loaded> = [];
  for (const id of ranked) {
    if (out.length >= limit) break;
    const version = plainVersion(db, ctx, { id }, query);
    if (version && !walk.seen.has(version.versionId)) out.push(version);
  }
  return out;
}

/** Plain lines the query's words find, each as its source id. Their stream takes no share of the assertion budget. */
function sourceStream(
  db: Db,
  ctx: Context,
  query: MemoryQuery,
  deps: RetrieveDeps,
  vector: ArrayLike<number> | null
): Array<string> {
  const forms = [...new Set(wordsOf(query.text))].slice(0, MAX_SOURCE_FORMS);
  if (forms.length === 0) return [];
  const until = query.recordedBefore === null ? null : Date.parse(query.recordedBefore);
  // One window is enough: `search` is the source fallback, and only the ids of its hits go on the page.
  const { hits } = search(db, {
    ctx,
    limit: 1,
    plan: { forms, who: [], from: null, to: until },
    now: deps.now(),
    vector,
    settings: deps.recall ?? dbSettings({}),
    model: deps.model,
  });
  return hits.slice(0, query.bounds.evidence).map((hit) => String(hit.id));
}

// ---------- the cursor ----------

const bindOf = (ctx: Context, query: MemoryQuery): string => {
  const shape = query;
  return createHash('sha256')
    .update(
      JSON.stringify([
        audienceKey(ctx),
        shape.text,
        shape.anchors,
        shape.predicates,
        shape.validAt,
        shape.recordedBefore,
        shape.includeHistorical,
        shape.bounds,
      ])
    )
    .digest('hex');
};

const revisionFor = (db: Db, ctx: Context, query: MemoryQuery): string =>
  semanticCacheKey(db, ctx, {
    text: query.text,
    limit: query.bounds.assertions,
    recordedBefore: query.recordedBefore,
    vector: null,
    model: null,
    historical: query.includeHistorical,
  });

/** A cursor of this context and query, or `CURSOR_INVALID`; one from an older state of what it can see is `CURSOR_EXPIRED`. */
function readCursor(db: Db, ctx: Context, query: MemoryQuery): Cursor | null {
  if (query.cursor === null) return null;
  let parsed: Cursor | null = null;
  try {
    parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as Cursor;
  } catch {
    throw coded('CURSOR_INVALID');
  }
  if (parsed?.bind !== bindOf(ctx, query) || !Array.isArray(parsed.frontier)) throw coded('CURSOR_INVALID');
  if (parsed.revision !== revisionFor(db, ctx, query)) throw coded('CURSOR_EXPIRED');
  return parsed;
}

function writeCursor(db: Db, ctx: Context, query: MemoryQuery, walk: Walk, frontier: ReadonlyArray<WalkNode>): string {
  const cursor: Cursor = {
    bind: bindOf(ctx, query),
    revision: revisionFor(db, ctx, query),
    seen: [...walk.seen],
    visited: [...walk.visited],
    frontier: [...frontier],
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

// ---------- the service ----------

/** Waits for the one query embedding, at most the page's deadline; a failure or a hang leaves the lexical streams. */
async function embedOnce(query: MemoryQuery, deps: RetrieveDeps): Promise<ArrayLike<number> | null> {
  if (typeof deps.embedQuery !== 'function' || deps.model === null || query.text.trim() === '') return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const out = await Promise.race([
      deps.embedQuery(query.text),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), query.bounds.deadlineMs);
        timer.unref?.();
      }),
    ]);
    return out ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Emits direct finds in turn until `share` or the list ends. */
function emitDirect(walk: Walk, list: Array<Loaded & { similarity?: number | null }>, share: number): void {
  for (let taken = 0; taken < share && list.length > 0 && !walk.stopped; taken += 1) {
    const one = list[0];
    if (!walk.admits(one)) return;
    list.shift();
    walk.emit(one, { hops: 0, anchored: false, similarity: one.similarity ?? null });
  }
}

/** The page of one query, read in one synchronous pass. */
function readPage(
  db: Db,
  ctx: Context,
  query: MemoryQuery,
  deps: RetrieveDeps,
  vector: ArrayLike<number> | null
): MemoryPage {
  const cursor = readCursor(db, ctx, query);
  const walk = new Walk(query, deps, cursor?.seen ?? [], cursor?.visited ?? []);
  const merges = visibleMerges(db, ctx, query.recordedBefore);
  const forks = forkedClaims(db, ctx);
  const { assertions } = query.bounds;
  const hits = searchSemantic(db, ctx, {
    text: query.text,
    limit: assertions * 2 + walk.seen.size,
    recordedBefore: query.recordedBefore,
    vector: vector === null ? null : Array.from(vector),
    model: deps.model,
    historical: query.includeHistorical,
  }).hits.filter((hit) => hit.streams.includes('lexical') || (hit.similarity ?? 0) >= (deps.minSimilarity ?? 0));
  const direct = directVersions(
    db,
    ctx,
    query,
    hits.filter((hit) => !walk.seen.has(hit.versionId))
  );
  const meaning = { vector, model: deps.model, minMeaning: deps.minSimilarity ?? RECALL_DEFAULTS.db.minMeaning };
  const plain = deps.plainClaims === false ? [] : plainClaims(db, ctx, query, walk, assertions, meaning);
  emitDirect(walk, direct, Math.ceil(assertions / 2));
  emitDirect(walk, plain, Math.ceil(assertions / 4));
  const start = cursor?.frontier ?? seedNodes(db, ctx, query, hits, merges, walk);
  if (cursor === null) for (const node of start) walk.visited.add(keyOf(node.ref));
  const frontier = walk.stopped ? start : walkFrom(db, ctx, query, start, merges, walk, forks);
  emitDirect(walk, direct, direct.length);
  emitDirect(walk, plain, plain.length);
  const { page } = walk;
  const shownSources = page.assertions.flatMap((one) => one.evidence.map((item) => item.sourceId));
  const lines = cursor === null && deps.sources !== false ? sourceStream(db, ctx, query, deps, vector) : [];
  page.sourceIds = [...new Set([...lines, ...shownSources])];
  if (page.partialReason !== null) page.next = writeCursor(db, ctx, query, walk, frontier);
  return page;
}

/**
 * The one retrieval read: a page of what this context may see for `given`. Authority comes from `ctx` alone, and only the
 * named fields of the query are read, so an extra field a caller adds does nothing. Throws without a valid context, and with
 * `CURSOR_INVALID` or `CURSOR_EXPIRED` for a cursor it cannot continue. Writes nothing.
 */
export async function retrieveMemory(
  db: Db,
  ctx: Context,
  given: MemoryQuery,
  deps: RetrieveDeps
): Promise<MemoryPage> {
  audienceWhere(ctx);
  const query: MemoryQuery = {
    text: String(given.text ?? ''),
    anchors: given.anchors ?? [],
    predicates: given.predicates ?? [],
    validAt: given.validAt ?? null,
    recordedBefore: given.recordedBefore ?? null,
    includeHistorical: given.includeHistorical === true,
    purpose: given.purpose,
    bounds: given.bounds,
    cursor: given.cursor ?? null,
  };
  const vector = await embedOnce(query, deps);
  db.exec('SAVEPOINT retrieve_page');
  try {
    return readPage(db, ctx, query, deps, vector);
  } finally {
    db.exec('RELEASE retrieve_page');
  }
}
