// What the persona already did near a purpose they propose, read from the engine's own tables and never from their
// words: their posted lines that lie near it by their stored vectors (src/memory/db/line-vectors.ts), each with how
// many lines people wrote in its place within a day after it, and their intentions near it, each with the state the
// store holds and what every wake run that carried it sent. A heartbeat's notice before an intention is saved reads it
// (src/turn/intention-notice.ts) through the frame reads. The heartbeat reads as the persona, so no read applies a
// scope. Read only, and no model request: the caller hands in the purpose's vector and the scores of their intentions.

import { HEARTBEAT_ORIGIN } from '../../intentions/model.ts';
import type { Db } from './types.ts';

/**
 * A line of the persona's near the purpose. `text` is null for a line of a direct chat, unless
 * `context.memory.openPrivate` is on.
 */
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
 * What followed the persona's lines in their place: people's lines after the last of them, bots aside, within
 * `AFTER_MS` in a group chat and up to now in a direct chat (`direct`), how many people wrote them, and how many lines
 * of any time answer one of those lines by `reply_to`, bots aside, with the people who wrote those (`answeredBy`): a
 * person id, or the account where a line holds no person, each once, at most ANSWERERS, in the order of their first
 * answer.
 */
export type Follow = { lines: number; people: number; answers: number; answeredBy: Array<string>; direct: boolean };
/** A near line as the vector read finds it, with the message id its answers name. */
type FoundLine = Omit<PastLine, 'after'> & { nativeId: string };
/**
 * One wake run that carried an intention: when it started, how it ended, the persona's lines it sent by place, and what
 * followed them in the place of the last one, null for a run that sent none.
 */
export type PastRun = { at: number; status: string; sent: number; placeIds: Array<string>; after: Follow | null };
/** An intention of the persona's near the purpose, with every run that carried it, oldest first. */
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
/** An intention of the persona's as the window compares it. */
export type OwnIntention = { id: string; purpose: string; createdAt: number; status: string };

/** How long after a line of the persona's in a group chat what people wrote there counts as what followed it. */
const AFTER_MS = 86_400_000;
/** The most people a notice names as having answered one act. */
const ANSWERERS = 3;

const momentOf = (value: unknown): number | null => {
  const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
};

/** A stored record's fields the window reads, null for a record without an id or a purpose. */
export function ownOf(raw: unknown): OwnIntention | null {
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
 * The persona's newest `limit` intentions by the moment they set them, open and archived together. Both reads walk
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
 * The persona's lines whose stored vector of `model` lies at `minScore` or nearer, each line once at its best row. The
 * read walks the `record` vectors over `vectors_kind` and finds each one's line by its link `source_rowid`, the primary
 * key of `sources`: the persona's lines carry no index of their own, and an older one holds no turn.
 */
function nearLines(
  db: Db,
  {
    vector,
    model,
    minScore,
    openPrivate,
  }: { vector: ReadonlyArray<number>; model: string; minScore: number; openPrivate: boolean }
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
      text: (row.scope_kind === 'dm' && !openPrivate) || typeof row.text !== 'string' ? null : row.text,
    });
  }
  return [...best.values()];
}

/**
 * What followed the persona's lines (`nativeIds`) in `placeId`, the last of them at `at` (see Follow). Whether the
 * place is a direct chat is read from its row by the primary key, and both counts walk the range of
 * `sources_place_time`.
 */
export function followOf(
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
  const answerers = db
    .prepare(
      `SELECT COALESCE(s.author_person, s.author_account) AS who, COUNT(DISTINCT s.native_id) AS n,
         MIN(s.occurred_at) AS first
       FROM sources s LEFT JOIN accounts a ON a.id = s.author_account
       WHERE s.place_id = ? AND s.occurred_at > ? AND s.kind = 'seen' AND s.retired_at IS NULL
         AND s.reply_to IN (${nativeIds.map(() => '?').join(', ')}) AND COALESCE(a.kind, 'user') <> 'bot'
       GROUP BY who ORDER BY first, who`
    )
    .all(placeId, from, ...nativeIds);
  return {
    lines: Number(window?.n ?? 0),
    people: Number(window?.people ?? 0),
    answers: answerers.reduce((sum, row) => sum + Number(row.n ?? 0), 0),
    answeredBy: answerers
      .map((row) => row.who)
      .filter((who): who is string => typeof who === 'string')
      .slice(0, ANSWERERS),
    direct,
  };
}

/** The intention of `id` as the store holds it, over the primary key; null for one it holds no live row of. */
function storedIntention(db: Db, id: string): OwnIntention | null {
  const row = db.prepare('SELECT record FROM intentions WHERE id = ? AND retired_at IS NULL').get(id);
  return row === undefined ? null : ownOf(row.record);
}

/** The ids of the intentions a wake run's `inputs` say its view carried, [] for a run that carried none. */
export function carriedIntentions(inputs: unknown): Array<string> {
  let carried: Array<unknown> = [];
  try {
    const parsed = JSON.parse(typeof inputs === 'string' ? inputs : 'null') as { intentions?: unknown } | null;
    carried = Array.isArray(parsed?.intentions) ? parsed.intentions : [];
  } catch {
    // `inputs` is written as JSON by the wake writer (wakes.ts#startRun); a row of an older writer may hold none.
    return [];
  }
  return carried.map((one) => (one as { id?: unknown } | null)?.id).filter((id) => typeof id === 'string');
}

/**
 * The persona's lines the turn `turnId` wrote, oldest first, over `sources_turn`; a line with no moment takes
 * `fallback`.
 */
export function sentLinesOf(
  db: Db,
  turnId: string,
  fallback: number
): Array<{ placeId: string; nativeId: string; at: number }> {
  return db
    .prepare(
      "SELECT place_id, native_id, occurred_at FROM sources WHERE turn_id = ? AND kind = 'said' AND retired_at IS NULL"
    )
    .all(turnId)
    .map((line) => ({
      placeId: String(line.place_id),
      nativeId: String(line.native_id),
      at: momentOf(line.occurred_at) ?? fallback,
    }))
    .sort((a, b) => a.at - b.at);
}

/**
 * The times the persona wrote first in a direct chat: how many wake runs within the window wrote there, the moment of
 * the last line of the last of them, the moments of that run's lines there, and how many lines people wrote there after
 * it.
 */
export type FirstLines = { count: number; lastAt: number; lineAts: Array<number>; after: number };

/**
 * The persona's first lines in each direct chat by place id, over the last `days` days up to `now`: a wake run started
 * in them counts once for each direct chat its turn wrote in when an intention it carried holds `origin: heartbeat`.
 * What followed is read as the notice reads it (followOf). A direct chat they did not write first in has no entry.
 */
export function firstLinesOf(db: Db, { days, now }: { days: number; now: number }): Map<string, FirstLines> {
  const since = now - days * AFTER_MS;
  const heartbeat = db.prepare('SELECT record FROM intentions WHERE id = ? AND retired_at IS NULL');
  const direct = db.prepare("SELECT 1 FROM places WHERE id = ? AND chat = 'dm'");
  const runs = new Map<string, { count: number; last: Array<{ nativeId: string; at: number }> }>();
  for (const row of db
    .prepare(
      `SELECT id, inputs FROM wake_runs
       WHERE status IN ('succeeded', 'failed', 'interrupted') AND started_at >= ? AND started_at <= ? ORDER BY started_at`
    )
    .all(new Date(since).toISOString(), new Date(now).toISOString())) {
    const first = carriedIntentions(row.inputs).some((id) => originOf(heartbeat.get(id)?.record) === HEARTBEAT_ORIGIN);
    if (!first) continue;
    const lines = sentLinesOf(db, String(row.id), since);
    for (const placeId of new Set(lines.map((line) => line.placeId))) {
      if (direct.get(placeId) === undefined) continue;
      const known = runs.get(placeId);
      const last = lines.filter((line) => line.placeId === placeId);
      runs.set(placeId, { count: (known?.count ?? 0) + 1, last });
    }
  }
  const out = new Map<string, FirstLines>();
  for (const [placeId, { count, last }] of runs) {
    const at = Math.max(...last.map((line) => line.at));
    const after = followOf(db, { placeId, at, nativeIds: last.map((line) => line.nativeId), now }).lines;
    out.set(placeId, { count, lastAt: at, lineAts: last.map((line) => line.at), after });
  }
  return out;
}

/** The `origin` a stored intention record holds, null for none or a torn record. */
function originOf(raw: unknown): string | null {
  try {
    const origin: unknown = (JSON.parse(String(raw)) as { origin?: unknown } | null)?.origin;
    return typeof origin === 'string' ? origin : null;
  } catch {
    // A torn record, which the store's own reader skips as well (src/intentions/store.ts#archived).
    return null;
  }
}

/**
 * The ended wake runs since `since` by the intentions their view carried (`inputs.intentions`), each with the
 * persona's lines its turn wrote. The runs are read over `wake_runs_status` (`status`, `started_at`), the lines over
 * `sources_turn`.
 */
function runsSince(db: Db, since: number, now: number): Map<string, Array<PastRun>> {
  const out = new Map<string, Array<PastRun>>();
  for (const row of db
    .prepare(
      `SELECT id, status, started_at, inputs FROM wake_runs
       WHERE status IN ('succeeded', 'failed', 'interrupted') AND started_at >= ? ORDER BY started_at`
    )
    .all(new Date(since).toISOString())) {
    const ids = carriedIntentions(row.inputs);
    if (ids.length === 0) continue;
    const lines = sentLinesOf(db, String(row.id), since);
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
 * The persona's lines and intentions near a purpose, best first, at most `limit`: a line whose stored vector of `model`
 * lies at `nearLine` or nearer to `vector`, and an intention whose score in `intentionScores` lies at `nearIntention`
 * or nearer. A line comes with what followed it, an intention with the runs that carried it, each with what followed
 * what it sent, read up to `now`.
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
    /** `context.memory.openPrivate`: a line of the persona's in a direct chat keeps its text. */
    openPrivate?: boolean;
  }
): Array<PastAct> {
  const intentions = [...input.intentionScores]
    .filter(([, score]) => score >= input.nearIntention)
    .flatMap(([id, score]) => {
      const stored = storedIntention(db, id);
      return stored === null ? [] : [{ stored, score }];
    });
  const near = [
    ...nearLines(db, { ...input, minScore: input.nearLine, openPrivate: input.openPrivate === true }).map((line) => ({
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
