// The notice a heartbeat's `intention.set` reads before the intention is saved (docs/inner-life.md "Heartbeat"): the
// purpose is compared with what she already did, her own posted lines by their stored vectors and her intentions of the
// newest `OWN_INTENTIONS` by vectors made in the same embedding request as the purpose's, and the acts that lie near it
// come back as evidence (src/memory/db/past-acts.ts). `checkPurpose` finds them, `noticeText` words them from
// `labels.heartbeat.notice`. The skill calls of a turn (src/turn/skill-calls.ts) run both and keep the state of a turn's
// notices on its draft. Every vector a turn embedded is kept in its memo, so a changed purpose embeds itself alone.

import { fill, formatDay } from '../format.ts';
import type { OwnIntention, PastAct } from '../memory/db/past-acts.ts';
import { objOf } from '../tools/types.ts';
import type { Obj } from '../tools/types.ts';

/**
 * The cosine at or above which a past act counts as near the purpose. A start value, to be calibrated in the simulator
 * (`scripts/replay.ts --inner heartbeat`) on the live data: it sits where an act of another subject or person stays
 * under it, so the notice is the exception.
 */
export const NEAR_SCORE = 0.6;
/** How many of her newest intentions a purpose is compared with: one embedding request carries them with the purpose. */
const OWN_INTENTIONS = 100;
/** The most acts one notice lists. */
const NOTICE_ITEMS = 5;
/** How long the check waits for its embedding request before the intention is saved without it. */
const EMBED_TIMEOUT_MS = 15_000;

/** What the check reads of memory (src/memory/db/frame-reads.ts). */
export type NoticeReads = {
  ownIntentions: (limit: number) => Array<OwnIntention>;
  pastActs: (input: {
    vector: ReadonlyArray<number>;
    model: string;
    intentionScores: ReadonlyMap<string, number>;
    minScore: number;
    limit: number;
  }) => Array<PastAct>;
};
/** One embedding request: a vector per text, in order. */
export type EmbedTexts = (texts: Array<string>) => Promise<ReadonlyArray<ArrayLike<number> | null | undefined>>;
/** The notices of one turn: the vectors it embedded, the acts it showed, and each notice's held call by its id. */
export type NoticeState = {
  memo: Map<string, ArrayLike<number> | null>;
  shown: Set<string>;
  held: Map<string, Obj>;
};
/** What a check found: acts near the purpose that no notice of the turn showed yet, none, or why it could not run. */
export type Check =
  | { kind: 'near'; acts: Array<PastAct> }
  | { kind: 'clear' }
  | { kind: 'failed'; stage: 'model' | 'read' | 'embed'; reason: string };

/** A turn's notice state before its first check. */
export const noticeState = (): NoticeState => ({ memo: new Map(), shown: new Set(), held: new Map() });

const keyOf = (act: PastAct): string => `${act.kind}:${act.id}`;

/** The cosine of two vectors, 0 when either has no length. */
function cosineOf(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let at = 0; at < Math.min(a.length, b.length); at += 1) {
    dot += a[at] * b[at];
    na += a[at] * a[at];
    nb += b[at] * b[at];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

/** The code or message of a thrown value, for the warn line: never a text of hers. */
const reasonOf = (error: unknown): string => {
  const code: unknown = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' && code !== '' ? code : error instanceof Error ? error.name : 'error';
};

/** `embed(texts)`, rejected with `timeout` after EMBED_TIMEOUT_MS. */
async function embedInTime(embed: EmbedTexts, texts: Array<string>) {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error('embedding timed out'), { code: 'timeout' })),
      EMBED_TIMEOUT_MS
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([embed(texts), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The acts near `purpose`, nearest first, at most NOTICE_ITEMS, leaving out those a notice of this turn showed. The
 * purpose and every intention of the window the memo lacks go in one embedding request.
 */
export async function checkPurpose({
  purpose,
  embed,
  reads,
  model,
  state,
}: {
  purpose: string;
  embed: EmbedTexts;
  reads: NoticeReads;
  model: string | null;
  state: NoticeState;
}): Promise<Check> {
  if (model === null) return { kind: 'failed', stage: 'model', reason: 'no-embedding-model' };
  let own: Array<OwnIntention>;
  try {
    own = reads.ownIntentions(OWN_INTENTIONS);
  } catch (error) {
    return { kind: 'failed', stage: 'read', reason: reasonOf(error) };
  }
  const missing = [...new Set([purpose, ...own.map((one) => one.purpose)])].filter((text) => !state.memo.has(text));
  if (missing.length > 0) {
    try {
      const vectors = await embedInTime(embed, missing);
      for (const [index, text] of missing.entries()) {
        const vector = vectors[index];
        state.memo.set(text, vector && vector.length > 0 ? vector : null);
      }
    } catch (error) {
      return { kind: 'failed', stage: 'embed', reason: reasonOf(error) };
    }
  }
  const query = state.memo.get(purpose) ?? null;
  if (query === null) return { kind: 'failed', stage: 'embed', reason: 'no-vector' };
  const intentionScores = new Map(
    own.flatMap((one) => {
      const vector = state.memo.get(one.purpose) ?? null;
      return vector === null ? [] : [[one.id, cosineOf(query, vector)] as const];
    })
  );
  let acts: Array<PastAct>;
  try {
    acts = reads.pastActs({
      vector: Array.from(query),
      model,
      intentionScores,
      minScore: NEAR_SCORE,
      limit: NOTICE_ITEMS + state.shown.size,
    });
  } catch (error) {
    return { kind: 'failed', stage: 'read', reason: reasonOf(error) };
  }
  const fresh = acts.filter((act) => !state.shown.has(keyOf(act))).slice(0, NOTICE_ITEMS);
  return fresh.length > 0 ? { kind: 'near', acts: fresh } : { kind: 'clear' };
}

/** The acts as shown: a later check of the same turn leaves them out. */
export function noteShown(state: NoticeState, acts: ReadonlyArray<PastAct>): void {
  for (const act of acts) state.shown.add(keyOf(act));
}

/** A label of `labels.heartbeat.notice`, '' when it is missing. */
const word = (words: Obj, key: string): string => (typeof words[key] === 'string' ? words[key] : '');

/** One act as its line of the notice. */
function actLine(
  act: PastAct,
  words: Obj,
  { timezone, placeName }: { timezone: string; placeName: (id: string) => string }
) {
  const date = formatDay(act.at, timezone);
  if (act.kind === 'line') {
    const place = placeName(act.placeId);
    const said =
      act.text === null
        ? fill(word(words, 'linePrivate'), { date, place })
        : fill(word(words, 'line'), { date, place, text: act.text });
    const after =
      act.after.lines > 0
        ? fill(word(words, 'followed'), {
            lines: act.after.lines,
            people: act.after.people,
            answers: act.after.answers,
          })
        : word(words, 'noReply');
    return `${said}; ${after}`;
  }
  const states = objOf(words.states);
  const state = typeof states[act.status] === 'string' ? states[act.status] : act.status;
  const runs = act.runs.map((run) =>
    run.sent > 0
      ? fill(word(words, 'run'), {
          date: formatDay(run.at, timezone),
          sent: run.sent,
          places: run.placeIds.map(placeName).join(', '),
        })
      : fill(word(words, 'runSilent'), { date: formatDay(run.at, timezone) })
  );
  const intention = fill(word(words, 'intention'), { date, state, purpose: act.purpose });
  return [intention, ...(runs.length > 0 ? runs : [word(words, 'notRun')])].join('; ');
}

/**
 * The notice of `acts`: the lead with its id, one line per act and the ways on, from `labels.heartbeat.notice`
 * (`lead`, `line`, `linePrivate`, `followed`, `noReply`, `intention`, `states`, `run`, `runSilent`, `notRun`, `ways`).
 */
export function noticeText(
  acts: ReadonlyArray<PastAct>,
  {
    id,
    labels,
    timezone,
    placeName,
  }: { id: string; labels: unknown; timezone: string; placeName: (id: string) => string }
): string {
  const words = objOf(objOf(labels).heartbeat).notice;
  const table = objOf(words);
  return [
    fill(word(table, 'lead'), { id }),
    ...acts.map((act) => `- ${actLine(act, table, { timezone, placeName })}`),
    fill(word(table, 'ways'), { id }),
  ].join('\n');
}
