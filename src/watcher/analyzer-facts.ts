// What the analyzer did in the watcher's observation window, read from the memory database with no model call. Each
// function (the `purpose` of a `model_requests` row with role `analyzer`) gets its requests by status and error code, and
// its decisions, each recorded answer read by that function's own parser so the count is what the engine acted on. Her
// effects downstream come from the turn journal's `day` rows and the media pick's delivered answers. An enabled function
// that had inputs (lines in group places, her replies) and no request, no acting decision or no effect is listed under
// `zeros` with those inputs, for the watcher to treat as a likely fault. A function is off when its prompt is empty or
// missing. src/service/watcher.ts puts the result on the first evidence page as `analyzer`.

import { parseMediaPick } from '../behavior/media-pick.ts';
import { parseAddressAnswer } from '../behavior/mention.ts';
import { MISSED_VERDICTS, UNCHECKED, parseMissedAnswer } from '../behavior/missed.ts';
import { parseMergeAnswer } from '../behavior/pending.ts';
import { parseQueryPlan } from '../behavior/query-builder.ts';
import { parseSplitAnswer, splitSettings } from '../behavior/split.ts';
import { parseJsonObject } from '../llm/parse.ts';
import type { Db } from '../memory/db/types.ts';
import type { Untyped } from '../tools/types.ts';

export type AnalyzerFunctionFacts = {
  purpose: string;
  enabled: boolean;
  requests: { total: number; byStatus: Record<string, number>; errorCodes: Record<string, number> };
  decisions: Record<string, number>;
};

export type AnalyzerEffects = {
  /** Her GIF posts that went out. */
  gifReplies: number;
  /** Her emoji reactions that went out. */
  emojiReactions: number;
  /** Media-pick answers of `emoji` or `replace` whose turn delivered its reply. */
  emojiInText: number;
  /** Calls answered in parts, one per turn the splitter divided. */
  splitReplies: number;
  /** Lines the merge answer joined to a waiting item. */
  mergedMessages: number;
};

export type AnalyzerZero = {
  purpose: string;
  reason: 'no-requests' | 'no-decision' | 'no-effect';
  inputs: Record<string, number>;
};

export type AnalyzerFacts = {
  functions: Array<AnalyzerFunctionFacts>;
  effects: AnalyzerEffects;
  zeros: Array<AnalyzerZero>;
};

type Row = Record<string, unknown>;
/** One recorded request as a parser reads it: the answer and the text of what it was asked. */
type Asked = { answer: string; asked: string; outcome: unknown };
type Reader = {
  decisions: ReadonlyArray<string>;
  read: (one: Asked, config: Record<string, Untyped>) => Array<string>;
};

const iso = (at: number): string => new Date(at).toISOString();

/** The lines of `<tag>` in the asked text, blank ones left out. */
function blockLines(asked: string, tag: string): Array<string> {
  const found = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(asked)?.[1] ?? '';
  return found.split('\n').filter((line) => line.trim() !== '');
}

/** How many numbered items `<tag>` held, as `<n>.` or `<n>:` opens each; with none shown, any number counts. */
function numbered(asked: string, tag: string, mark: RegExp): number {
  const count = blockLines(asked, tag).filter((line) => mark.test(line)).length;
  return count === 0 ? Number.MAX_SAFE_INTEGER : count;
}

/** The words of `<tag>`, so a handle or a name the answer gives can be found among what was offered. */
const offered = (asked: string, tag: string): Array<string> =>
  blockLines(asked, tag).flatMap((line) => line.split(/[\s:,;"'()[\]]+/).filter(Boolean));

/** The parser of each function and the decisions it counts, in the order the brief names them. */
const READERS: Readonly<Record<string, Reader>> = {
  address: {
    decisions: ['yes', 'overheard', 'no'],
    // An unreadable answer is no decision.
    read: ({ answer }) => {
      const one = parseAddressAnswer(answer);
      return one === null ? [] : [one];
    },
  },
  split: {
    decisions: ['one', 'several'],
    read: ({ answer }, config) => [parseSplitAnswer(answer, splitSettings(config)).parts === null ? 'one' : 'several'],
  },
  merge: {
    decisions: ['joined', 'new'],
    read: ({ answer, asked }) => [
      parseMergeAnswer(answer, numbered(asked, 'waiting', /^\d+\. /)).reason === 'item' ? 'joined' : 'new',
    ],
  },
  missed: {
    decisions: [...MISSED_VERDICTS, UNCHECKED],
    read: ({ answer, asked }) => parseMissedAnswer(answer, numbered(asked, 'candidates', /^\d+: /)).verdicts,
  },
  'media-pick': {
    decisions: ['none', 'gif', 'emoji', 'replace'],
    read: ({ answer, asked }) => [
      parseMediaPick(answer, {
        gifs: offered(asked, 'gifs'),
        emoji: offered(asked, 'emoji'),
        actions: ['append', 'replace'],
      }).kind,
    ],
  },
  'query-builder': {
    decisions: ['web', 'history', 'none'],
    read: ({ answer }) => {
      const plan = parseQueryPlan(answer);
      const asked = [...(plan.web === null ? [] : ['web']), ...(plan.history === null ? [] : ['history'])];
      return asked.length === 0 ? ['none'] : asked;
    },
  },
  'selfreflection-planner': {
    decisions: [],
    read: ({ answer }) => {
      try {
        const plan = parseJsonObject(answer) as { kind?: unknown } | null;
        return [typeof plan?.kind === 'string' && plan.kind !== '' ? plan.kind : 'no-kind'];
      } catch {
        return ['unparsed'];
      }
    },
  },
};

/** The text of every user message of a request, its parts joined. */
function askedText(messages: unknown): string {
  let list: unknown;
  try {
    list = typeof messages === 'string' ? JSON.parse(messages) : messages;
  } catch {
    return '';
  }
  if (!Array.isArray(list)) return '';
  return list
    .filter((one: { role?: unknown }) => one?.role === 'user')
    .flatMap((one: { content?: unknown }) => {
      if (typeof one.content === 'string') return [one.content];
      if (!Array.isArray(one.content)) return [];
      return one.content.flatMap((part: { text?: unknown }) => (typeof part?.text === 'string' ? [part.text] : []));
    })
    .join('\n');
}

const bump = (counts: Record<string, number>, key: string, by = 1): void => {
  counts[key] = (counts[key] ?? 0) + by;
};

/** Whether a delivery outcome says the turn's reply went out. */
function delivered(outcome: unknown): boolean {
  try {
    const value: unknown = typeof outcome === 'string' ? JSON.parse(outcome) : outcome;
    return (value as { state?: unknown } | null)?.state === 'confirmed';
  } catch {
    return false;
  }
}

function functionFacts(
  rows: ReadonlyArray<Row>,
  [purpose, reader]: readonly [string, Reader],
  enabled: boolean,
  config: Record<string, Untyped>
): { facts: AnalyzerFunctionFacts; emojiInText: number } {
  const byStatus: Record<string, number> = {};
  const errorCodes: Record<string, number> = {};
  const decisions: Record<string, number> = Object.fromEntries(reader.decisions.map((name) => [name, 0]));
  let emojiInText = 0;
  for (const row of rows) {
    bump(byStatus, String(row.status));
    if (typeof row.error_code === 'string' && row.error_code !== '') bump(errorCodes, row.error_code);
    if (row.status !== 'ok' || typeof row.response_text !== 'string') continue;
    const one = { answer: row.response_text, asked: askedText(row.messages), outcome: row.outcome };
    const read = reader.read(one, config);
    for (const decision of read) bump(decisions, decision);
    if (purpose === 'media-pick' && (read[0] === 'emoji' || read[0] === 'replace') && delivered(one.outcome))
      emojiInText += 1;
  }
  return {
    facts: { purpose, enabled, requests: { total: rows.length, byStatus, errorCodes }, decisions },
    emojiInText,
  };
}

/** Her actions of the window that went out, by the action's name. */
function actionsDone(db: Db, span: ReadonlyArray<string>, name: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM day WHERE what = 'action' AND retired_at IS NULL AND json_valid(extra)
         AND json_extract(extra, '$.name') = ? AND json_extract(extra, '$.phase') = 'succeeded' AND at > ? AND at <= ?`
    )
    .get(name, ...span);
  return Number(row?.n ?? 0);
}

function countOf(db: Db, sql: string, span: ReadonlyArray<string>): number {
  return Number(db.prepare(sql).get(...span)?.n ?? 0);
}

/**
 * What the analyzer did in (`from`, `to`]: its functions, her effects and the zeros. `prompts` are the live prompt files,
 * and an empty or missing one turns its function off; `config` gives the parsers their settings.
 */
export function analyzerFacts(
  db: Db,
  window: { from: number; to: number },
  options: { config: unknown; prompts: Readonly<Record<string, unknown>> }
): AnalyzerFacts {
  const span = [iso(window.from), iso(window.to)];
  const config = (options.config ?? {}) as Record<string, Untyped>;
  const rows = db
    .prepare(
      `SELECT purpose, status, error_code, response_text, messages, outcome FROM model_requests
       WHERE role = 'analyzer' AND finished_at > ? AND finished_at <= ? ORDER BY finished_at, rowid`
    )
    .all(...span);
  let emojiInText = 0;
  const functions = Object.entries(READERS).map((entry) => {
    const [purpose] = entry;
    const prompt = options.prompts[purpose];
    const enabled = typeof prompt === 'string' && prompt.trim() !== '';
    const read = functionFacts(
      rows.filter((row) => row.purpose === purpose),
      entry,
      enabled,
      config
    );
    emojiInText += read.emojiInText;
    return read.facts;
  });
  const effects: AnalyzerEffects = {
    gifReplies: actionsDone(db, span, 'gif'),
    emojiReactions: actionsDone(db, span, 'react'),
    emojiInText,
    splitReplies: countOf(
      db,
      `SELECT COUNT(*) AS n FROM day WHERE what = 'turn' AND retired_at IS NULL AND at > ? AND at <= ?
         AND COALESCE(outcome, CASE WHEN json_valid(extra) THEN json_extract(extra, '$.outcome') END) = 'split'`,
      span
    ),
    mergedMessages: functions.find((one) => one.purpose === 'merge')?.decisions.joined ?? 0,
  };
  const inputs = {
    groupLines: countOf(
      db,
      `SELECT COUNT(*) AS n FROM sources WHERE kind = 'seen' AND scope_kind = 'group' AND retired_at IS NULL
         AND occurred_at > ? AND occurred_at <= ?`,
      span
    ),
    herReplies: countOf(
      db,
      "SELECT COUNT(*) AS n FROM sources WHERE kind = 'said' AND retired_at IS NULL AND occurred_at > ? AND occurred_at <= ?",
      span
    ),
  };
  return { functions, effects, zeros: zerosOf(functions, effects, inputs) };
}

/** The functions that had inputs and did nothing with them: no request, no acting decision, or no effect. */
function zerosOf(
  functions: ReadonlyArray<AnalyzerFunctionFacts>,
  effects: AnalyzerEffects,
  inputs: { groupLines: number; herReplies: number }
): Array<AnalyzerZero> {
  const watched: Array<{
    purpose: string;
    inputs: Record<string, number>;
    acting: Array<string>;
    effect: number | null;
  }> = [
    { purpose: 'address', inputs: { groupLines: inputs.groupLines }, acting: ['yes', 'overheard'], effect: null },
    {
      purpose: 'media-pick',
      inputs: { herReplies: inputs.herReplies },
      acting: ['gif', 'emoji', 'replace'],
      effect: effects.gifReplies + effects.emojiInText,
    },
  ];
  return watched.flatMap((one): Array<AnalyzerZero> => {
    const facts = functions.find((fn) => fn.purpose === one.purpose);
    if (facts === undefined || !facts.enabled || Object.values(one.inputs).every((n) => n === 0)) return [];
    const zero = (reason: AnalyzerZero['reason']): Array<AnalyzerZero> => [
      { purpose: one.purpose, reason, inputs: one.inputs },
    ];
    if (facts.requests.total === 0) return zero('no-requests');
    if (one.acting.every((name) => (facts.decisions[name] ?? 0) === 0)) return zero('no-decision');
    if (one.effect === 0) return zero('no-effect');
    return [];
  });
}
