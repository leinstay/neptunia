// What the persona already did near a purpose she proposes, read from the engine's own tables and never from her words:
// her posted lines that lie near it by their stored vectors (src/memory/db/line-vectors.ts), each with how many lines
// people wrote in its place within a day after it, and her intentions near it, each with the state the store holds and
// what every wake run that carried it sent. A heartbeat's notice before an intention is saved reads it
// (src/turn/intention-notice.ts) through the frame reads. The heartbeat reads as herself, so no read applies a scope.
// Read only, and no model request: the caller hands in the purpose's vector and the scores of her intentions.

import type { Db } from './types.ts';

/** A line of hers near the purpose. `text` is null for a line of a direct chat, whose content a heartbeat never shows. */
export type PastLine = {
  kind: 'line';
  id: string;
  score: number;
  at: number;
  placeId: string;
  text: string | null;
  /** People's lines in the line's place within `AFTER_MS` after it, bots aside, and how many people wrote them. */
  after: { lines: number; people: number };
};
/** One wake run that carried an intention: when it started, how it ended and the lines of hers it sent, by place. */
export type PastRun = { at: number; status: string; sent: number; placeIds: Array<string> };
/** An intention of hers near the purpose, with every run that carried it, oldest first. */
export type PastIntention = {
  kind: 'intention';
  id: string;
  score: number;
  at: number;
  status: string;
  purpose: string;
  runs: Array<PastRun>;
};
export type PastAct = PastLine | PastIntention;
/** An intention of hers as the window compares it. */
export type OwnIntention = { id: string; purpose: string; createdAt: number; status: string };

/** How long after a line of hers what people wrote in its place counts as what followed it. */
const AFTER_MS = 86_400_000;

const momentOf = (value: unknown): number | null => {
  const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
};

/** A stored record's fields the window reads, null for a record without an id or a purpose. */
function ownOf(raw: unknown): OwnIntention | null {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    // A torn record, which the store's own reader skips as well (src/intentions/store.ts#archived).
    return null;
  }
  const { id, purpose, status } = record;
  if (typeof id !== 'string' || typeof purpose !== 'string' || purpose.trim() === '') return null;
  return {
    id,
    purpose,
    createdAt: momentOf(record.createdAt) ?? 0,
    status: typeof status === 'string' ? status : 'pending',
  };
}

/**
 * Her newest `limit` intentions by the moment she set them, open and archived together. Both reads walk
 * `intentions_list` (`archived`, `position`), the archive from its newest position down.
 */
export function ownIntentionsOf(db: Db, limit: number): Array<OwnIntention> {
  const open = db.prepare('SELECT record FROM intentions WHERE archived = 0 AND retired_at IS NULL').all();
  const archived = db
    .prepare('SELECT record FROM intentions WHERE archived = 1 AND retired_at IS NULL ORDER BY position DESC LIMIT ?')
    .all(limit);
  return [...open, ...archived]
    .map((row) => ownOf(row.record))
    .filter((one): one is OwnIntention => one !== null)
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/** The cosine of a stored int8 row and a query of norm `queryNorm`. */
function cosine(row: Record<string, unknown>, query: ReadonlyArray<number>, queryNorm: number): number {
  const bytes = row.bytes as Uint8Array;
  const data = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let dot = 0;
  for (let at = 0; at < query.length; at += 1) dot += (data[at] ?? 0) * (query[at] ?? 0);
  const norm = Number(row.norm);
  return norm > 0 ? (dot * Number(row.scale)) / (queryNorm * norm) : 0;
}

/**
 * Her lines whose stored vector of `model` lies at `minScore` or nearer, best first, each line once at its best row.
 * Her lines are walked over `sources_turn`, the lines her turns wrote, and each one's vectors over `vectors_item`.
 */
function nearLines(
  db: Db,
  { vector, model, minScore }: { vector: ReadonlyArray<number>; model: string; minScore: number }
): Array<Omit<PastLine, 'after'>> {
  const queryNorm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  if (!(queryNorm > 0)) return [];
  const rows = db
    .prepare(
      `SELECT s.id, s.place_id, s.occurred_at, s.text, s.scope_kind, v.scale, v.norm, v.bytes
       FROM sources s INDEXED BY sources_turn CROSS JOIN vectors v INDEXED BY vectors_item ON v.item_id = s.native_id
       WHERE s.turn_id > '' AND s.kind = 'said' AND s.retired_at IS NULL
         AND v.kind = 'record' AND v.model = ? AND v.dims = ? AND v.bytes IS NOT NULL
         AND v.retired_at IS NULL AND v.evicted_at IS NULL`
    )
    .all(model, vector.length);
  const best = new Map<string, Omit<PastLine, 'after'>>();
  for (const row of rows) {
    const score = cosine(row, vector, queryNorm);
    const id = String(row.id);
    const at = momentOf(row.occurred_at);
    if (score < minScore || at === null || (best.get(id)?.score ?? -1) >= score) continue;
    best.set(id, {
      kind: 'line',
      id,
      score,
      at,
      placeId: String(row.place_id),
      text: row.scope_kind === 'dm' || typeof row.text !== 'string' ? null : row.text,
    });
  }
  return [...best.values()];
}

/** People's lines in `placeId` within AFTER_MS after `at`, over the range of `sources_place_time`. */
function afterOf(db: Db, placeId: string, at: number): PastLine['after'] {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT s.native_id) AS n, COUNT(DISTINCT COALESCE(s.author_person, s.author_account)) AS people
       FROM sources s LEFT JOIN accounts a ON a.id = s.author_account
       WHERE s.place_id = ? AND s.occurred_at > ? AND s.occurred_at <= ? AND s.kind = 'seen' AND s.retired_at IS NULL
         AND COALESCE(a.kind, 'user') <> 'bot'`
    )
    .get(placeId, new Date(at).toISOString(), new Date(at + AFTER_MS).toISOString());
  return { lines: Number(row?.n ?? 0), people: Number(row?.people ?? 0) };
}

/** The intention of `id` as the store holds it, over the primary key; null for one it holds no live row of. */
function storedIntention(db: Db, id: string): OwnIntention | null {
  const row = db.prepare('SELECT record FROM intentions WHERE id = ? AND retired_at IS NULL').get(id);
  return row === undefined ? null : ownOf(row.record);
}

/**
 * The ended wake runs since `since` by the intentions their view carried (`inputs.intentions`), each with the lines of
 * hers its turn wrote. The runs are read over `wake_runs_status` (`status`, `started_at`), the lines over `sources_turn`.
 */
function runsSince(db: Db, since: number): Map<string, Array<PastRun>> {
  const out = new Map<string, Array<PastRun>>();
  const sent = db.prepare("SELECT place_id FROM sources WHERE turn_id = ? AND kind = 'said' AND retired_at IS NULL");
  for (const row of db
    .prepare(
      `SELECT id, status, started_at, inputs FROM wake_runs
       WHERE status IN ('succeeded', 'failed', 'interrupted') AND started_at >= ? ORDER BY started_at`
    )
    .all(new Date(since).toISOString())) {
    let carried: Array<unknown> = [];
    try {
      const inputs = JSON.parse(typeof row.inputs === 'string' ? row.inputs : 'null') as {
        intentions?: unknown;
      } | null;
      carried = Array.isArray(inputs?.intentions) ? inputs.intentions : [];
    } catch {
      // `inputs` is written as JSON by the wake writer (wakes.ts#startRun); a row of an older writer may hold none.
      continue;
    }
    const ids = carried.map((one) => (one as { id?: unknown } | null)?.id).filter((id) => typeof id === 'string');
    if (ids.length === 0) continue;
    const places = sent.all(String(row.id)).map((line) => String(line.place_id));
    const pastRun: PastRun = {
      at: momentOf(row.started_at) ?? since,
      status: String(row.status),
      sent: places.length,
      placeIds: [...new Set(places)],
    };
    for (const id of ids) out.set(id, [...(out.get(id) ?? []), pastRun]);
  }
  return out;
}

/**
 * Her lines and intentions near a purpose, best first, at most `limit`: a line whose stored vector of `model` lies at
 * `minScore` or nearer to `vector`, and an intention whose score in `intentionScores` does. A line comes with what
 * people wrote after it, an intention with the runs that carried it.
 */
export function pastActsOf(
  db: Db,
  input: {
    vector: ReadonlyArray<number>;
    model: string;
    intentionScores: ReadonlyMap<string, number>;
    minScore: number;
    limit: number;
  }
): Array<PastAct> {
  const intentions = [...input.intentionScores]
    .filter(([, score]) => score >= input.minScore)
    .flatMap(([id, score]) => {
      const stored = storedIntention(db, id);
      return stored === null ? [] : [{ stored, score }];
    });
  const near = [
    ...nearLines(db, input).map((line) => ({ score: line.score, line, intention: null })),
    ...intentions.map((one) => ({ score: one.score, line: null, intention: one })),
  ]
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit);
  const oldest = Math.min(...near.flatMap((one) => (one.intention ? [one.intention.stored.createdAt] : [])));
  const runs = Number.isFinite(oldest) ? runsSince(db, oldest) : new Map<string, Array<PastRun>>();
  return near.map((one): PastAct => {
    if (one.line) return { ...one.line, after: afterOf(db, one.line.placeId, one.line.at) };
    const { stored, score } = one.intention;
    return {
      kind: 'intention',
      id: stored.id,
      score,
      at: stored.createdAt,
      status: stored.status,
      purpose: stored.purpose,
      runs: runs.get(stored.id) ?? [],
    };
  });
}
