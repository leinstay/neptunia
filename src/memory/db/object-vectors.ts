// The vectors of the memory objects a search reads as text (spec 2026-11-08-embeddings-everywhere): each live claim, each
// description of a person, a place, the persona or an entity, each live episode, and the set of names a person or a
// place has in one audience. Each object holds one row of `vectors` per model under its own chunk key, with the hash of
// the text it was made from in `context`, `source_rowid` and `owner_key` null, and the object's scope and audience copied.
// A row with no owner belongs to no month, so no month's manifest counts it (audit.ts#vectorManifests).
//
//   pendingObjectEmbeds(db, { model, limit })   the live objects with no row of `model`, oldest first; asks no model
//   applyObjectEmbedding(handle, update)        the writer message `{ kind: 'object-embedding', model, now, items }`:
//       each item `{ kind, itemId, audienceId, hash, vector }` is written only while its object still holds the text of
//       `hash` (session-write.ts dispatches it)
//   touchVectors(db, table, id)                 graph.ts#projectRow, in the writer's transaction: the rows of a claim, a
//       description or an episode whose text changed or which retired are deleted
//   touchNameVectors(db, nodeIds)               the same for the name sets of the nodes names.ts#touchNames rewrote
//   embedObjects({ db, write, embed, config, model, now })   service.ts's minute job: at most
//       `memoryDb.retrieval.embedBatch` pending texts, oldest first, cut where the next text would pass
//       `llm.maxRequestTokens`, in one `embed` request of purpose `memory-object`, written through one `object-embedding`
//       message. A text over the cap alone is never sent. A failed request writes nothing, so the batch stays pending.
// Between a change and the next embedding the object has no vector and a search finds it by its words.
// Logs nothing.

import { estimateTokens } from '../../llm/tokens.ts';
import { objOf } from '../../tools/types.ts';
import { quantize } from '../vectors.ts';
import { shortHash } from './ids.ts';
import { scopeOfAudience } from './scope.ts';
import { dbOf, transactionOf } from './types.ts';
import type { Connection, Db, Row } from './types.ts';

export const OBJECT_KINDS = ['claim', 'desc', 'episode', 'names'] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];
/** One object with no vector yet: its kind, its id (the node for a name set), its audience, its text and when it began. */
export type PendingObject = {
  kind: ObjectKind;
  itemId: string;
  audienceId: string;
  text: string;
  hash: string;
  chunkKey: string;
  at: string;
};

/** The unit tables of graph.ts whose rows are objects, by the kind of their vector. */
const KIND_OF_TABLE: Readonly<Record<string, ObjectKind>> = {
  claims: 'claim',
  descriptions: 'desc',
  episodes: 'episode',
};
/** The subjects whose descriptions a search reads; a medium's description has its own `media:` vectors. */
const DESCRIBED = "('person', 'place', 'self', 'entity')";
/** The nodes whose names make a set: a person and a place. */
const NAMED_NODES = "(n.node_id LIKE 'person:%' OR n.node_id LIKE 'place:%')";

const filled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** The statements of one connection, prepared once: the projection runs them on every unit it writes. */
const statements = new WeakMap<Db, Map<string, ReturnType<Db['prepare']>>>();
function prepared(db: Db, sql: string): ReturnType<Db['prepare']> {
  let map = statements.get(db);
  if (!map) statements.set(db, (map = new Map<string, ReturnType<Db['prepare']>>()));
  let statement = map.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    map.set(sql, statement);
  }
  return statement;
}

/** The chunk key of an object's vector; a name set is keyed by its node and its audience. */
export function objectChunkKey(kind: ObjectKind, itemId: string, audienceId: string, model: string): string {
  return kind === 'names' ? `names:${itemId}:${audienceId}:${model}` : `${kind}:${itemId}:${model}`;
}

/** The text of an object from its two text columns: an episode's `what`, then its `quote` on its own line. */
const textOf = (first: unknown, second: unknown): string => [first, second].filter(filled).join('\n');

/** The live claim, description or episode a vector reads, with its text, audience and scope; null when it has none. */
const CURRENT_SQL: Readonly<Record<Exclude<ObjectKind, 'names'>, string>> = {
  claim: `SELECT c.text AS first, NULL AS second, c.audience_id, c.scope_kind, c.scope_iface, c.scope_dm FROM claims c
    WHERE c.id = ? AND c.retired_at IS NULL AND c.superseded_by IS NULL AND c.kind IS NOT 'alias'
      AND c.subject_kind IS NOT 'semantic'`,
  desc: `SELECT v.text AS first, NULL AS second, d.audience_id, d.scope_kind, d.scope_iface, d.scope_dm
    FROM descriptions d JOIN description_versions v ON v.id = d.current_version
    WHERE d.id = ? AND d.retired_at IS NULL AND d.subject_kind IN ${DESCRIBED}`,
  episode: `SELECT e.what AS first, e.quote AS second, e.audience_id, e.scope_kind, e.scope_iface, e.scope_dm
    FROM episodes e WHERE e.id = ? AND e.retired_at IS NULL`,
};

type Current = { text: string; audienceId: string; scope: Row };

/** The labels of one node in one audience, distinct, sorted and one per line. */
function nameSetText(db: Db, nodeId: string, audienceId: string): string {
  return prepared(db, 'SELECT DISTINCT label FROM names WHERE node_id = ? AND audience_id = ? ORDER BY label')
    .all(nodeId, audienceId)
    .map((row) => String(row.label))
    .join('\n');
}

function currentOf(db: Db, kind: ObjectKind, itemId: string, audienceId: string): Current | null {
  if (kind === 'names') {
    const text = nameSetText(db, itemId, audienceId);
    const lookup = (place: string) => db.prepare('SELECT iface, partner_person FROM places WHERE id = ?').get(place);
    return text === '' ? null : { text, audienceId, scope: { ...scopeOfAudience(audienceId, lookup) } };
  }
  const row = prepared(db, CURRENT_SQL[kind]).get(itemId);
  const text = row ? textOf(row.first, row.second) : '';
  if (!row || text === '') return null;
  const scope = { scope_kind: row.scope_kind, scope_iface: row.scope_iface, scope_dm: row.scope_dm };
  return { text, audienceId: String(row.audience_id), scope };
}

/** The live objects of each kind, as `kind, item_id, audience_id, first, second, at`, with no row under `model`. */
const PENDING_SQL = `
  SELECT 'claim' AS kind, c.id AS item_id, c.audience_id, c.text AS first, NULL AS second,
         COALESCE(c.created_at, c.first_seen_at, '') AS at
    FROM claims c
   WHERE c.retired_at IS NULL AND c.superseded_by IS NULL AND c.kind IS NOT 'alias' AND c.subject_kind IS NOT 'semantic'
     AND trim(COALESCE(c.text, '')) <> ''
     AND NOT EXISTS (SELECT 1 FROM vectors v WHERE v.chunk_key = 'claim:' || c.id || ':' || :model)
  UNION ALL
  SELECT 'desc', d.id, d.audience_id, v.text, NULL, COALESCE(v.written_at, '')
    FROM descriptions d JOIN description_versions v ON v.id = d.current_version
   WHERE d.retired_at IS NULL AND d.subject_kind IN ${DESCRIBED} AND trim(COALESCE(v.text, '')) <> ''
     AND NOT EXISTS (SELECT 1 FROM vectors x WHERE x.chunk_key = 'desc:' || d.id || ':' || :model)
  UNION ALL
  SELECT 'episode', e.id, e.audience_id, e.what, e.quote, COALESCE(e.created_at, '')
    FROM episodes e
   WHERE e.retired_at IS NULL AND trim(COALESCE(e.what, '') || COALESCE(e.quote, '')) <> ''
     AND NOT EXISTS (SELECT 1 FROM vectors v WHERE v.chunk_key = 'episode:' || e.id || ':' || :model)
  UNION ALL
  SELECT 'names', n.node_id, n.audience_id, NULL, NULL, COALESCE(MIN(g.created_at), '')
    FROM names n LEFT JOIN graph_nodes g ON g.id = n.node_id
   WHERE ${NAMED_NODES}
     AND NOT EXISTS (SELECT 1 FROM vectors v
                      WHERE v.chunk_key = 'names:' || n.node_id || ':' || n.audience_id || ':' || :model)
   GROUP BY n.node_id, n.audience_id
  ORDER BY at, kind, item_id
  LIMIT :limit`;

/** The live objects with no vector of `model`, oldest first and at most `limit`. Asks no model. */
export function pendingObjectEmbeds(db: Db, { model, limit }: { model: string; limit: number }): Array<PendingObject> {
  const out: Array<PendingObject> = [];
  for (const row of db.prepare(PENDING_SQL).all({ model, limit })) {
    const kind = row.kind as ObjectKind; // one of the four literals the query selects
    const itemId = String(row.item_id);
    const audienceId = String(row.audience_id);
    const text = kind === 'names' ? nameSetText(db, itemId, audienceId) : textOf(row.first, row.second);
    if (text === '') continue;
    const chunkKey = objectChunkKey(kind, itemId, audienceId, model);
    out.push({ kind, itemId, audienceId, text, hash: shortHash(text), chunkKey, at: String(row.at) });
  }
  return out;
}

type Item = { kind: ObjectKind; itemId: string; audienceId: string; hash: string; vector: ReadonlyArray<number> };

function itemOf(value: unknown): Item {
  const item = value as Partial<Item> | null;
  const isVector = Array.isArray(item?.vector) && item.vector.length > 0;
  if (
    !item ||
    !OBJECT_KINDS.includes(item.kind as ObjectKind) ||
    !filled(item.itemId) ||
    !filled(item.hash) ||
    !isVector
  )
    throw new Error(
      `object-embedding item needs { kind: ${OBJECT_KINDS.join(' | ')}, itemId, audienceId, hash, vector }`
    );
  return item as Item; // every field checked above
}

/** The writer's message `{ kind: 'object-embedding', model, now, items }`; returns how many rows it wrote. */
export function applyObjectEmbedding(handle: Connection, update: Row): { written: number } {
  const model = update.model;
  if (!filled(model) || !Array.isArray(update.items))
    throw new Error('object-embedding needs a model and an items list; embedObjects sends both');
  const items = update.items.map(itemOf);
  const db = dbOf(handle);
  const at = new Date(Number(update.now)).toISOString();
  const insert = db.prepare(
    `INSERT INTO vectors (source_rowid, item_id, chunk_key, model, dims, scale, norm, bytes, context, occurred_at,
       scope_kind, scope_iface, scope_dm, audience_id)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chunk_key) DO UPDATE SET dims = excluded.dims, scale = excluded.scale, norm = excluded.norm,
       bytes = excluded.bytes, context = excluded.context, occurred_at = excluded.occurred_at,
       scope_kind = excluded.scope_kind, scope_iface = excluded.scope_iface, scope_dm = excluded.scope_dm,
       audience_id = excluded.audience_id, retired_at = NULL, evicted_at = NULL`
  );
  return transactionOf(handle)(() => {
    let written = 0;
    for (const item of items) {
      const current = currentOf(db, item.kind, item.itemId, item.audienceId);
      if (!current || shortHash(current.text) !== item.hash) continue;
      const packed = quantize(item.vector);
      insert.run(
        item.itemId,
        objectChunkKey(item.kind, item.itemId, current.audienceId, model),
        model,
        item.vector.length,
        packed.scale,
        packed.norm,
        new Uint8Array(packed.bytes.buffer, packed.bytes.byteOffset, packed.bytes.byteLength),
        JSON.stringify({ hash: item.hash }),
        at,
        current.scope.scope_kind ?? null,
        current.scope.scope_iface ?? null,
        current.scope.scope_dm ?? null,
        current.audienceId
      );
      written += 1;
    }
    return { written };
  });
}

const ready = new WeakMap<Db, true>();
/**
 * Whether the database has the index `vectors_item` (schema 41). Before it no object vector exists, and a step of an
 * older migration that projects rows needs no lookup that would scan every vector.
 */
function hasItemIndex(db: Db): boolean {
  if (ready.has(db)) return true;
  const found = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND name = 'vectors_item'").get();
  if (found) ready.set(db, true);
  return found !== undefined;
}

/** Deletes the rows of an object whose hash is not `hash` (all of them for null); returns how many went. */
function retire(db: Db, kind: ObjectKind, itemId: string, hash: string | null): number {
  const result = prepared(
    db,
    `DELETE FROM vectors WHERE item_id = ? AND substr(chunk_key, 1, ?) = ?
         AND (? IS NULL OR json_extract(context, '$.hash') IS NOT ?)`
  ).run(itemId, kind.length + 1, `${kind}:`, hash, hash);
  return Number(result.changes);
}

/**
 * The vectors of a projected unit, in the writer's transaction: a claim, a description or an episode whose text changed
 * keeps no row of the old text, and one that retired keeps none. Returns how many rows went.
 */
export function touchVectors(db: Db, table: string, id: string): number {
  const kind = KIND_OF_TABLE[table];
  if (kind === undefined || !hasItemIndex(db)) return 0;
  const current = currentOf(db, kind, id, '');
  return retire(db, kind, id, current === null ? null : shortHash(current.text));
}

/** The name sets of the given nodes, each audience compared with the names it holds now. Returns how many rows went. */
export function touchNameVectors(db: Db, nodeIds: ReadonlySet<string>): number {
  if (nodeIds.size === 0 || !hasItemIndex(db)) return 0;
  const held = prepared(
    db,
    `SELECT rowid, audience_id, json_extract(context, '$.hash') AS hash FROM vectors
      WHERE item_id = ? AND substr(chunk_key, 1, 6) = 'names:'`
  );
  const drop = prepared(db, 'DELETE FROM vectors WHERE rowid = ?');
  let count = 0;
  for (const nodeId of nodeIds)
    for (const row of held.all(nodeId)) {
      const text = nameSetText(db, nodeId, String(row.audience_id));
      if (text !== '' && shortHash(text) === row.hash) continue;
      drop.run(row.rowid);
      count += 1;
    }
  return count;
}

/** `memoryDb.retrieval.embedBatch` when missing or invalid: config.json's value. */
const EMBED_BATCH_FALLBACK = 50;
/** `llm.maxRequestTokens` when missing or invalid: config.json's value. */
const MAX_REQUEST_TOKENS_FALLBACK = 50_000;

const positive = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

/** The pending objects one request carries: oldest first, cut where the next text would pass `maxTokens`. */
function batchUnder(pending: ReadonlyArray<PendingObject>, maxTokens: number): Array<PendingObject> {
  const batch: Array<PendingObject> = [];
  let tokens = 0;
  for (const one of pending) {
    const cost = estimateTokens(one.text);
    if (cost > maxTokens) continue; // the client would refuse it in any batch
    if (tokens + cost > maxTokens) break;
    tokens += cost;
    batch.push(one);
  }
  return batch;
}

/**
 * One bounded batch of the minute job (service.ts#startRetrievalEmbed): the oldest pending objects, at most
 * `memoryDb.retrieval.embedBatch` and under `llm.maxRequestTokens`, in one `embed` request, then one writer message.
 * Rejects when the request fails, writing nothing.
 */
export async function embedObjects({
  db,
  write,
  embed,
  config,
  model,
  now,
}: {
  db: Db;
  write: (update: Row) => Promise<unknown>;
  embed: (texts: ReadonlyArray<string>, opts: Row) => Promise<unknown>;
  config: unknown;
  model: string;
  now: number;
}): Promise<{ pending: number; written: number }> {
  const retrieval = objOf(objOf(objOf(config).memoryDb).retrieval);
  const limit = positive(retrieval.embedBatch, EMBED_BATCH_FALLBACK);
  const maxTokens = positive(objOf(objOf(config).llm).maxRequestTokens, MAX_REQUEST_TOKENS_FALLBACK);
  const batch = batchUnder(pendingObjectEmbeds(db, { model, limit }), maxTokens);
  if (batch.length === 0) return { pending: 0, written: 0 };
  // The embedding client answers one vector per text, in input order.
  const vectors = (await embed(
    batch.map((one) => one.text),
    { config, purpose: 'memory-object' }
  )) as Array<ArrayLike<number> | undefined> | undefined;
  const items = batch.flatMap((one, index) => {
    const vector = vectors?.[index];
    if (!vector || vector.length === 0) return [];
    return [
      { kind: one.kind, itemId: one.itemId, audienceId: one.audienceId, hash: one.hash, vector: Array.from(vector) },
    ];
  });
  if (items.length === 0) return { pending: batch.length, written: 0 };
  const done = (await write({ kind: 'object-embedding', model, now, items })) as { written?: number } | undefined;
  return { pending: batch.length, written: done?.written ?? 0 };
}
