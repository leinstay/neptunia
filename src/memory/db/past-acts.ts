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
  after: Follow;
};
/**
 * What followed lines of hers in their place: people's lines after the last of them, bots aside, within `AFTER_MS` in a
 * group chat and up to now in a direct chat (`direct`), how many people wrote them, and how many lines of any time answer
 * one of hers by `reply_to`.
 */
export type Follow = { lines: number; people: number; answers: number; direct: boolean };
/** A near line as the vector read finds it, with the message id its answers name. */
type FoundLine = Omit<PastLine, 'after'> & { nativeId: string };
/**
 * One wake run that carried an intention: when it started, how it ended, the lines of hers it sent by place, and what
 * followed them in the place of the last one, null for a run that sent none.
 */
export type PastRun = { at: number; status: string; sent: number; placeIds: Array<string>; after: Follow | null };
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

/** How long after a line of hers in a group chat what people wrote there counts as what followed it. */
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
 * Her lines whose stored vector of `model` lies at `minScore` or nearer, each line once at its best row. The read walks
 * the `record` vectors over `vectors_kind` and finds each one's line by its link `source_rowid`, the primary key of
 * `sources`: her lines carry no index of their own, and an older line of hers holds no turn.
 */
function nearLines(
  db: Db,
  { vector, model, minScore }: { vector: ReadonlyArray<number>; model: string; minScore: number }
): Array<FoundLine> {
  const queryNorm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  if (!(queryNorm > 0)) return [];
  const rows = db
    .prepare(
      `SELECT s.id, s.native_id, s.place_id, s.occurred_at, s.text, s.scope_kind, v.scale, v.norm, v.bytes
       FROM vectors v INDEXED BY vectors_kind CROSS JOIN sources s ON s.rowid = v.source_rowid
       WHERE v.kind = 'record' AND v.model = ? AND v.dims = ? AND v.bytes IS NOT NULL
         AND v.retired_at IS NULL AND v.evicted_at IS NULL
         AND s.kind = 'said' AND s.author_kind = 'self' AND s.retired_at IS NULL`
    )
    .all(model, vector.length);
  const best = new Map<string, FoundLine>();
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
      nativeId: String(row.native_id),
      text: row.scope_kind === 'dm' || typeof row.text !== 'string' ? null : row.text,
    });
  }
  return [...best.values()];
}

/**
 * What followed lines of hers (`nativeIds`) in `placeId`, the last of them at `at` (see Follow). Whether the place is a
 * direct chat is read from its row by the primary key, and both counts walk the range of `sources_place_time`.
 */
function followOf(
  db: Db,
  { placeId, at, nativeIds, now }: { placeId: string; at: number; nativeIds: ReadonlyArray<string>; now: number }
): Follow {
  const direct = db.prepare('SELECT chat FROM places WHERE id = ?').get(placeId)?.chat === 'dm';
  const from = new Date(at).toISOString();
  const window = db
    .prepare(
      `SELECT COUNT(DISTINCT s.native_id) AS n, COUNT(DISTINCT COALESCE(s.author_person, s.author_account)) AS people
       FROM sources s LEFT JOIN accounts a ON a.id = s.author_account
       WHERE s.place_id = ? AND s.occurred_at > ? AND s.occurred_at <= ? AND s.kind = 'seen' AND s.retired_at IS NULL
         AND COALESCE(a.kind, 'user') <> 'bot'`
    )
    .get(placeId, from, new Date(direct ? now : at + AFTER_MS).toISOString());
  const answers = db
    .prepare(
      `SELECT COUNT(DISTINCT s.native_id) AS n FROM sources s
       WHERE s.place_id = ? AND s.occurred_at > ? AND s.kind = 'seen' AND s.retired_at IS NULL
         AND s.reply_to IN (${nativeIds.map(() => '?').join(', ')})`
    )
    .get(placeId, from, ...nativeIds);
  return {
    lines: Number(window?.n ?? 0),
    people: Number(window?.people ?? 0),
    answers: Number(answers?.n ?? 0),
    direct,
  };
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
function runsSince(db: Db, since: number, now: number): Map<string, Array<PastRun>> {
  const out = new Map<string, Array<PastRun>>();
  const sent = db.prepare(
    "SELECT place_id, native_id, occurred_at FROM sources WHERE turn_id = ? AND kind = 'said' AND retired_at IS NULL"
  );
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
    const lines = sent
      .all(String(row.id))
      .map((line) => ({
        placeId: String(line.place_id),
        nativeId: String(line.native_id),
        at: momentOf(line.occurred_at) ?? since,
      }))
      .sort((a, b) => a.at - b.at);
    const last = lines.at(-1);
    const pastRun: PastRun = {
      at: momentOf(row.started_at) ?? since,
      status: String(row.status),
      sent: lines.length,
      placeIds: [...new Set(lines.map((line) => line.placeId))],
      after: last
        ? followOf(db, {
            placeId: last.placeId,
            at: last.at,
            nativeIds: lines.filter((line) => line.placeId === last.placeId).map((line) => line.nativeId),
            now,
          })
        : null,
    };
    for (const id of ids) out.set(id, [...(out.get(id) ?? []), pastRun]);
  }
  return out;
}

/**
 * Her lines and intentions near a purpose, best first, at most `limit`: a line whose stored vector of `model` lies at
 * `nearLine` or nearer to `vector`, and an intention whose score in `intentionScores` lies at `nearIntention` or nearer.
 * A line comes with what followed it, an intention with the runs that carried it, each with what followed what it sent,
 * read up to `now`.
 */
export function pastActsOf(
  db: Db,
  input: {
    vector: ReadonlyArray<number>;
    model: string;
    intentionScores: ReadonlyMap<string, number>;
    nearIntention: number;
    nearLine: number;
    limit: number;
    now: number;
  }
): Array<PastAct> {
  const intentions = [...input.intentionScores]
    .filter(([, score]) => score >= input.nearIntention)
    .flatMap(([id, score]) => {
      const stored = storedIntention(db, id);
      return stored === null ? [] : [{ stored, score }];
    });
  const near = [
    ...nearLines(db, { ...input, minScore: input.nearLine }).map((line) => ({
      score: line.score,
      line,
      intention: null,
    })),
    ...intentions.map((one) => ({ score: one.score, line: null, intention: one })),
  ]
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit);
  const oldest = Math.min(...near.flatMap(({ intention }) => (intention ? [intention.stored.createdAt] : [])));
  const runs = Number.isFinite(oldest) ? runsSince(db, oldest, input.now) : new Map<string, Array<PastRun>>();
  return near.map((one): PastAct => {
    if (one.line) {
      const { id, score, at, placeId, text } = one.line;
      return {
        kind: 'line',
        id,
        score,
        at,
        placeId,
        text,
        after: followOf(db, { ...one.line, nativeIds: [one.line.nativeId], now: input.now }),
      };
    }
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
