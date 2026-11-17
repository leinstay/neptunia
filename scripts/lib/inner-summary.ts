// The numbers of an `--inner` run of scripts/replay.ts: `sampleFacts` reads one sample's requests, answers and actions
// into the facts a comparison of two heartbeat variants needs, and `innerSummary` counts them over the samples. Both
// are pure. The facts carry sizes, names, codes and the place a call gave, never her words or a chat line.

import { parseWhen } from '../../src/intentions/model.ts';

/** One call of hers as the turn's gate recorded it. */
export type InnerCall = { name: string; status: string; code: string | null };

/** How a sample ended: a skip, one intention change, or anything else. */
export type InnerEnd =
  | { kind: 'skip' }
  | { kind: 'other' }
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
  end: InnerEnd;
};

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

const tokensOf = (request: Request | undefined): number | null => {
  const n = Number(request?.usage?.prompt_tokens);
  return request?.usage && Number.isFinite(n) ? n : null;
};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The facts of one sample. `requests` are her reply requests in order, `answers` her parsed answers to them, `actions`
 * the turn's inner actions. The ending is the last intention change that was proposed or ran; a sample without one is
 * a skip when her last answer skipped. `directOf` says whether a place is a direct chat, null when unknown.
 */
export function sampleFacts(
  { requests, answers, actions }: { requests: Array<Request>; answers: Array<Answer>; actions: Array<Action> },
  { now, timezone, directOf }: { now: number; timezone: string; directOf: (place: string) => boolean | null }
): SampleFacts {
  const thinks = answers.map((answer) => text(answer.think).length);
  const change = actions.findLast((action) => text(action.skill) in CHANGES && action.status !== 'refused');
  let end: InnerEnd = answers.at(-1)?.skip === true ? { kind: 'skip' } : { kind: 'other' };
  if (change) {
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
      direct: resolved === null ? null : directOf(resolved),
      dueInMinutes: due === null ? null : Math.round((due - now) / 60_000),
      recurs: every !== '' && every !== 'none',
      purposeWords: text(args.text).split(/\s+/).filter(Boolean).length,
    };
  }
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
    end,
  };
}

type Share = { count: number; share: number | null };

export type InnerSummary = {
  samples: number;
  /** Shares of the samples. */
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

/** The counts over the samples of one variant: skips and intentions of the samples, the rest of the intentions. */
export function innerSummary(samples: Array<SampleFacts>): InnerSummary {
  const ends = samples.map((sample) => sample.end);
  const changes = ends.filter((end) => end.kind === 'intention');
  const placed = changes.flatMap((end) => (end.place === null ? [] : [end.place]));
  return {
    samples: samples.length,
    skips: share(ends.filter((end) => end.kind === 'skip').length, samples.length),
    intentions: share(changes.length, samples.length),
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
    `| skips, of samples | ${pct(summary.skips)} |`,
    `| intentions, of samples | ${pct(summary.intentions)} |`,
    `| with a place, of intentions | ${pct(summary.withPlace)} |`,
    `| in a direct chat, of intentions | ${pct(summary.direct)} |`,
    `| due over six hours away, of intentions | ${pct(summary.dueOverSixHours)} |`,
    ...summary.places.map((entry) => `| place \`${entry.place}\` | ${pct(entry)} |`),
    ...summary.refused.map((entry) => `| refused \`${entry.code}\` | ${entry.count} |`),
    `| think characters, median / largest | ${size(summary.thinkChars)} |`,
    `| prompt tokens, median / largest | ${size(summary.promptTokens)} |`,
  ];
}
