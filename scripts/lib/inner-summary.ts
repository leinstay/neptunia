// The numbers of an `--inner` run of scripts/replay.ts: `sampleFacts` reads one sample's requests, answers and actions
// into the facts a comparison of two heartbeat variants needs, and `innerSummary` counts them over the samples. Both
// are pure. The facts carry sizes, names, codes and the place a call gave, never her words or a chat line.

import { parseWhen } from '../../src/intentions/model.ts';
import { ERRAND_TOOLS } from '../../src/tools/definitions.ts';

/** One call of hers as the turn's gate recorded it. */
export type InnerCall = { name: string; status: string; code: string | null };

/**
 * How a sample ended: her own skip, one intention change, or unresolved with a short code. `code` is `errand-proposed`
 * (an errand call only proposed in shadow), `errand-unanswered` (an errand call that found no answer in
 * `--errand-answers`), `step-cap`, `time-budget` or `token-cap` (the loop cut her calls), the turn's outcome when it
 * neither spoke nor skipped (`error`, `refused`, `cancelled`, `not-now`), or `no-decision` (no change and no skip).
 */
export type InnerEnd =
  | { kind: 'skip' }
  | { kind: 'unresolved'; code: string }
  | {
      kind: 'intention';
      change: 'set' | 'update' | 'cancel';
      place: string | null;
      direct: boolean | null;
      dueInMinutes: number | null;
      recurs: boolean;
      purposeWords: number;
    };

export type SampleFacts = {
  /** The prompt tokens of the first request, as the provider reported them. */
  promptTokens: number | null;
  /** The blocks of the first request with their characters, as the turn recorded them for the request archive. */
  blocks: Array<{ name: string; chars: number }>;
  requests: Array<{ promptTokens: number | null; thinkChars: number }>;
  thinkChars: number;
  calls: Array<InnerCall>;
  /** Each errand call that was not refused, with the agent it went to and whether a result answered it. */
  errands: Array<{ agent: string; answered: boolean }>;
  end: InnerEnd;
};

/** How the turn runner said the turn ended: its `outcome` and `reason`, and the cut of the loop (`inner.loop.cut`). */
export type TurnEnd = { outcome: string | null; reason: string | null; cut: string | null };

/** The TurnEnd of a turn runner's result, a turn that threw included (`{ outcome: 'error', reason }`). */
export function turnEndOf(result: {
  outcome?: string;
  reason?: string;
  inner?: { loop?: { cut: string | null } };
}): TurnEnd {
  const loop = result.inner?.loop;
  return { outcome: result.outcome ?? null, reason: result.reason ?? null, cut: loop?.cut ?? null };
}

type Request = { usage?: { prompt_tokens?: unknown } | null; blocks?: ReadonlyArray<{ name: string; chars: number }> };
type Answer = {
  think?: unknown;
  calls?: ReadonlyArray<{ skill: string; args?: Record<string, unknown> }>;
  skip?: unknown;
};
type Action = Record<string, unknown> & {
  skill?: unknown;
  status?: unknown;
  code?: unknown;
  target?: Record<string, unknown>;
};

const CHANGES = { 'intention.set': 'set', 'intention.update': 'update', 'intention.cancel': 'cancel' } as const;
const SIX_HOURS_MIN = 6 * 60;
/** The cuts of the loop that end a turn before she decided, by their code. */
const CUTS: Readonly<Record<string, string>> = { steps: 'step-cap', time: 'time-budget', tokens: 'token-cap' };
/** The answer of an errand call whose wait ended with no result (src/tools/operations/errand.ts). */
const WAIT_ENDED = 'errand-wait-ended';

const tokensOf = (request: Request | undefined): number | null => {
  const n = Number(request?.usage?.prompt_tokens);
  return request?.usage && Number.isFinite(n) ? n : null;
};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The facts of one sample. `requests` are her reply requests in order, `answers` her parsed answers to them, `actions`
 * the turn's inner actions, `turn` what the runner said of its end. The ending, first match wins: a turn that neither
 * spoke nor skipped is unresolved with its outcome; an errand call left without a result is unresolved; the last
 * intention change that was proposed or ran is the ending; a loop cut is unresolved; the runner's `skip`, or her last
 * answer's skip, is a skip; anything else is unresolved `no-decision`. `directOf` says whether a place is a direct
 * chat, null when unknown. An intention whose call names a `person` is one in a direct chat.
 */
export function sampleFacts(
  {
    requests,
    answers,
    actions,
    turn,
  }: { requests: Array<Request>; answers: Array<Answer>; actions: Array<Action>; turn: TurnEnd },
  { now, timezone, directOf }: { now: number; timezone: string; directOf: (place: string) => boolean | null }
): SampleFacts {
  const thinks = answers.map((answer) => text(answer.think).length);
  const change = actions.findLast((action) => text(action.skill) in CHANGES && action.status !== 'refused');
  const errandCalls = actions.filter(
    (action) => Object.hasOwn(ERRAND_TOOLS, text(action.skill)) && action.status !== 'refused'
  );
  const errands = errandCalls.map((action) => ({
    agent: ERRAND_TOOLS[text(action.skill)] ?? '',
    answered: action.status === 'executed' && action.code !== WAIT_ENDED,
  }));
  const proposed = errandCalls.some((action) => action.status === 'proposed');
  const cut = turn.cut === null ? null : (CUTS[turn.cut] ?? null);
  let end: InnerEnd;
  if (turn.outcome !== 'skip' && turn.outcome !== 'spoke') end = { kind: 'unresolved', code: turn.outcome ?? 'error' };
  else if (proposed) end = { kind: 'unresolved', code: 'errand-proposed' };
  else if (errands.some((errand) => !errand.answered)) end = { kind: 'unresolved', code: 'errand-unanswered' };
  else if (change) {
    const skill = text(change.skill) as keyof typeof CHANGES;
    const args = answers.flatMap((answer) => answer.calls ?? []).findLast((call) => call.skill === skill)?.args ?? {};
    const place = text(args.place) || null;
    const resolved = text(change.target?.channel) || place;
    const due = parseWhen(args.due, now, { timezone });
    const every = text(args.every).trim();
    end = {
      kind: 'intention',
      change: CHANGES[skill],
      place,
      direct: text(args.person) !== '' ? true : resolved === null ? null : directOf(resolved),
      dueInMinutes: due === null ? null : Math.round((due - now) / 60_000),
      recurs: every !== '' && every !== 'none',
      purposeWords: text(args.text).split(/\s+/).filter(Boolean).length,
    };
  } else if (cut !== null) end = { kind: 'unresolved', code: cut };
  else if (turn.outcome === 'skip' || answers.at(-1)?.skip === true) end = { kind: 'skip' };
  else end = { kind: 'unresolved', code: 'no-decision' };
  return {
    promptTokens: tokensOf(requests[0]),
    blocks: (requests[0]?.blocks ?? []).map(({ name, chars }) => ({ name, chars })),
    requests: requests.map((request, i) => ({ promptTokens: tokensOf(request), thinkChars: thinks[i] ?? 0 })),
    thinkChars: thinks.reduce((sum, n) => sum + n, 0),
    calls: actions.map((action) => ({
      name: text(action.skill),
      status: text(action.status),
      code: action.status === 'refused' ? text(action.code) || null : null,
    })),
    errands,
    end,
  };
}

type Share = { count: number; share: number | null };

export type InnerSummary = {
  samples: number;
  /** A share of the samples, and its codes from most to least. */
  unresolved: Share;
  unresolvedCodes: Array<{ code: string; count: number }>;
  /** Shares of the samples that ended resolved. */
  skips: Share;
  intentions: Share;
  /** Shares of the intentions. */
  withPlace: Share;
  direct: Share;
  dueOverSixHours: Share;
  places: Array<{ place: string; count: number; share: number | null }>;
  refused: Array<{ code: string; count: number }>;
  thinkChars: { median: number | null; max: number | null };
  promptTokens: { median: number | null; max: number | null };
};

const share = (count: number, of: number): Share => ({
  count,
  share: of === 0 ? null : Math.round((count / of) * 1000) / 1000,
});

function spread(values: Array<number>): { median: number | null; max: number | null } {
  if (values.length === 0) return { median: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { median, max: sorted.at(-1) ?? null };
}

/** Counted from most to least, ties in the order first seen. */
function counted(keys: Array<string>): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

/**
 * The counts over the samples of one variant: the unresolved of the samples, skips and intentions of the samples that
 * ended resolved, the rest of the intentions.
 */
export function innerSummary(samples: Array<SampleFacts>): InnerSummary {
  const ends = samples.map((sample) => sample.end);
  const changes = ends.filter((end) => end.kind === 'intention');
  const placed = changes.flatMap((end) => (end.place === null ? [] : [end.place]));
  const unresolved = ends.flatMap((end) => (end.kind === 'unresolved' ? [end.code] : []));
  const resolved = samples.length - unresolved.length;
  return {
    samples: samples.length,
    unresolved: share(unresolved.length, samples.length),
    unresolvedCodes: counted(unresolved).map(([code, count]) => ({ code, count })),
    skips: share(ends.filter((end) => end.kind === 'skip').length, resolved),
    intentions: share(changes.length, resolved),
    withPlace: share(placed.length, changes.length),
    direct: share(changes.filter((end) => end.direct === true).length, changes.length),
    dueOverSixHours: share(
      changes.filter((end) => end.dueInMinutes !== null && end.dueInMinutes > SIX_HOURS_MIN).length,
      changes.length
    ),
    places: counted(placed).map(([place, count]) => ({ place, ...share(count, changes.length) })),
    refused: counted(
      samples.flatMap((sample) => sample.calls.flatMap((call) => (call.code === null ? [] : [call.code])))
    ).map(([code, count]) => ({ code, count })),
    thinkChars: spread(samples.map((sample) => sample.thinkChars)),
    promptTokens: spread(samples.flatMap((sample) => (sample.promptTokens === null ? [] : [sample.promptTokens]))),
  };
}

/** The summary as a Markdown table, for the top of the `--inner` report. */
export function innerSummaryTable(summary: InnerSummary): Array<string> {
  const pct = (value: Share) => `${value.count} (${value.share === null ? '-' : `${Math.round(value.share * 100)}%`})`;
  const size = (value: { median: number | null; max: number | null }) => `${value.median ?? '-'} / ${value.max ?? '-'}`;
  return [
    '| Measure | Value |',
    '|---|---|',
    `| samples | ${summary.samples} |`,
    `| unresolved, of samples | ${pct(summary.unresolved)} |`,
    ...summary.unresolvedCodes.map((entry) => `| unresolved \`${entry.code}\` | ${entry.count} |`),
    `| skips, of resolved samples | ${pct(summary.skips)} |`,
    `| intentions, of resolved samples | ${pct(summary.intentions)} |`,
    `| with a place, of intentions | ${pct(summary.withPlace)} |`,
    `| in a direct chat, of intentions | ${pct(summary.direct)} |`,
    `| due over six hours away, of intentions | ${pct(summary.dueOverSixHours)} |`,
    ...summary.places.map((entry) => `| place \`${entry.place}\` | ${pct(entry)} |`),
    ...summary.refused.map((entry) => `| refused \`${entry.code}\` | ${entry.count} |`),
    `| think characters, median / largest | ${size(summary.thinkChars)} |`,
    `| prompt tokens, median / largest | ${size(summary.promptTokens)} |`,
  ];
}
