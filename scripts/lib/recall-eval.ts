// The pure parts of scripts/recall-eval.ts: the questions file checked, record lines turned
// into chat messages, the ids a recall run surfaced scored against the expected ones, the run
// summed up (hit@1, hit@5, answered by the chat, false confident recalls, web answers, latency,
// cost), the question loop with its spend stop, the candidate sample for writing questions by
// hand, and the offline guild the local stages run against. Nothing here reads a file, the
// network or the clock.

import { recordMessage } from '../../src/behavior/recall.ts';
import type { Untyped } from '../../src/tools/types.ts';
import type { Reads } from '../../src/interface/reads.ts';

/** An object read by key whose values are not typed yet. */
type Rec = Record<string, Untyped>;

/** How one question scored: whether the expected line was in the first window, in the first five, anywhere, or in chat. */
export type Score = {
  hit1?: boolean | null;
  hit5?: boolean | null;
  seen?: boolean | null;
  inChat?: boolean | null;
  outcome?: string | null;
  falseConfident?: boolean | null;
  surfaced?: Array<string>;
  [field: string]: Untyped;
};

/** One question's result as `ask` returns it; the fields past these depend on the mode that asked. */
export type QuestionResult = {
  kind?: string;
  score?: Score | null;
  web?: { found?: boolean } | null;
  error?: unknown;
  latencyMs?: Untyped;
  costUsd?: Untyped;
  [field: string]: Untyped;
};

/** The kinds of a question: the answer is one exact message, a looser stretch, or not in memory at all. */
export const QUESTION_KINDS = Object.freeze(['exact', 'fuzzy', 'none']);
/** How many surfaced ids count for the wide hit. */
export const HIT_AT = 5;
const SNOWFLAKE = /^\d{17,20}$/;
const DAY_MS = 86_400_000;

/** Whether `value` is a Discord id. */
export function isSnowflake(value: Untyped): boolean {
  return typeof value === 'string' && SNOWFLAKE.test(value);
}

/** One question of the file: whom it was asked of, where, and the messages that answer it. */
export type Question = {
  id: string;
  placeId: string;
  askerId: string;
  question: string;
  expected: Array<string>;
  kind: string;
  note?: string;
};

/**
 * The questions of a parsed questions file: `[{ id, placeId, askerId, question, expected:
 * [messageId...], kind: 'exact'|'fuzzy'|'none', note? }]`. `errors` names every problem by the
 * question's position and id (never its text); a file with any error should not be run. A
 * `none` question expects no message (the answer is not in memory); the others expect at
 * least one. Ids are unique.
 */
export function parseQuestions(value: unknown): { questions: Array<Question>; errors: Array<string> } {
  if (!Array.isArray(value)) return { questions: [], errors: ['the file is not a JSON array'] };
  const questions: Array<Question> = [];
  const errors: Array<string> = [];
  const ids = new Set();
  value.forEach((raw, i) => {
    const at = `question ${i + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${at}: not an object`);
      return;
    }
    const id = typeof raw.id === 'string' || Number.isInteger(raw.id) ? String(raw.id).trim() : '';
    const where = id ? `${at} (${id})` : at;
    const problems = [];
    if (!id) problems.push('no id');
    else if (ids.has(id)) problems.push('a duplicate id');
    if (!isSnowflake(raw.placeId)) problems.push('placeId is not a Discord id');
    if (!isSnowflake(raw.askerId)) problems.push('askerId is not a Discord id');
    if (typeof raw.question !== 'string' || !raw.question.trim()) problems.push('no question text');
    if (!QUESTION_KINDS.includes(raw.kind)) problems.push(`kind is not one of ${QUESTION_KINDS.join(', ')}`);
    const expected = Array.isArray(raw.expected) ? raw.expected : null;
    if (!expected) problems.push('expected is not a list');
    else if (!expected.every(isSnowflake)) problems.push('expected holds a value that is not a Discord id');
    else if (raw.kind === 'none' && expected.length > 0) problems.push('a none question expects no message');
    else if (raw.kind !== 'none' && QUESTION_KINDS.includes(raw.kind) && expected.length === 0)
      problems.push('expected is empty');
    if (raw.note !== undefined && typeof raw.note !== 'string') problems.push('note is not a string');
    if (problems.length > 0) {
      errors.push(`${where}: ${problems.join('; ')}`);
      return;
    }
    ids.add(id);
    questions.push({
      id,
      placeId: raw.placeId,
      askerId: raw.askerId,
      question: raw.question,
      expected: [...new Set<string>(expected)],
      kind: raw.kind,
      ...(raw.note !== undefined ? { note: raw.note } : {}),
    });
  });
  return { questions, errors };
}

/**
 * The record's messages as they stand: per message id the newest revision of a `seen` or
 * `said` line with a channel and a time; a message whose newest line is `deleted` is gone.
 * Oldest first.
 * @param lines Record lines (src/memory/record.ts).
 */
export function latestLines(lines: Iterable<Rec>): Array<Rec> {
  const latest = new Map();
  for (const line of lines) {
    if (!line || typeof line !== 'object' || typeof line.messageId !== 'string' || !line.messageId) continue;
    if (line.kind === 'deleted') {
      latest.set(line.messageId, null);
      continue;
    }
    if (line.kind !== 'seen' && line.kind !== 'said') continue;
    if (typeof line.scope?.channel !== 'string' || !Number.isFinite(Date.parse(line.occurredAt))) continue;
    const known = latest.get(line.messageId);
    const revision = Number.isInteger(line.revision) && line.revision > 0 ? line.revision : 1;
    if (known === null) continue;
    if (known && known.revision >= revision) continue;
    latest.set(line.messageId, { line, revision });
  }
  return [...latest.values()]
    .filter(Boolean)
    .map((entry) => entry.line)
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
}

/**
 * A record line as a normalized chat message, its link previews included: the live recall's own
 * function (src/behavior/recall.ts#recordMessage), so the chat the tool shows the classifier reads
 * as the record windows do. The line needs a channel (latestLines keeps only such lines).
 */
export { recordMessage };

/**
 * The ids a run surfaced, in order: first the matched ones (a search hit, a record match, a
 * meaning row) as the windows come, then every other line of the windows; each id once.
 * `windows` are the message lists the summary read, in its order.
 */
export function surfacedIds(
  windows: Array<Array<Rec>>,
  matched: Set<string> | Array<string>
): { surfaced: Array<string>; matched: Array<string> } {
  const hits = matched instanceof Set ? matched : new Set(matched ?? []);
  const first: Array<Untyped> = [];
  const rest: Array<Untyped> = [];
  const seen = new Set();
  for (const window of windows ?? []) {
    for (const message of window ?? []) {
      const id = message?.id;
      if (typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);
      (hits.has(id) ? first : rest).push(id);
    }
  }
  return { surfaced: [...first, ...rest], matched: first };
}

/**
 * One question scored. `rank`: the 1-based place of the first expected id among the matched
 * ids (null when none is); `hit1` / `hit5` from it; `seen`: whether an expected id is anywhere
 * in the windows the summary read; `windowRank`: the 1-based window holding the first one.
 * `inChat`: whether an expected id is among `chatIds`, the asking channel's visible chat window
 * (the live voice reads the answer there, search or not). `outcome`: `hit` (hit@5), else
 * `in-chat` (answered by the chat, not a miss), else `miss`.
 * A `none` question has no hits (null) and counts a confident answer as a false one.
 */
export function scoreQuestion(
  question: { kind: string; expected: Array<string> },
  {
    windows = [],
    matched = [],
    confident = false,
    chatIds = [],
  }: { windows?: Array<Array<Rec>>; matched?: Iterable<string>; confident?: boolean; chatIds?: Iterable<string> } = {}
):
  | {
      surfaced: Array<string>;
      rank: null;
      hit1: null;
      hit5: null;
      seen: null;
      windowRank: null;
      inChat: null;
      outcome: null;
      falseConfident: boolean;
    }
  | {
      surfaced: Array<string>;
      rank: number | null;
      hit1: boolean;
      hit5: boolean;
      seen: boolean;
      windowRank: number | null;
      inChat: boolean;
      outcome: string;
      falseConfident: null;
    } {
  const { surfaced, matched: hitOrder } = surfacedIds(windows, new Set(matched));
  if (question.kind === 'none') {
    return {
      surfaced,
      rank: null,
      hit1: null,
      hit5: null,
      seen: null,
      windowRank: null,
      inChat: null,
      outcome: null,
      falseConfident: confident === true,
    };
  }
  const expected = new Set(question.expected);
  const at = hitOrder.findIndex((id) => expected.has(id));
  const rank = at === -1 ? null : at + 1;
  const windowAt = (windows ?? []).findIndex((window) => (window ?? []).some((m) => expected.has(m?.id)));
  const hit5 = rank !== null && rank <= HIT_AT;
  const inChat = [...(chatIds ?? [])].some((id) => expected.has(id));
  return {
    surfaced,
    rank,
    hit1: rank === 1,
    hit5,
    seen: windowAt !== -1,
    windowRank: windowAt === -1 ? null : windowAt + 1,
    inChat,
    outcome: hit5 ? 'hit' : inChat ? 'in-chat' : 'miss',
    falseConfident: null,
  };
}

/** The nearest-rank `p`-th percentile (0..100) of `values`, or null for none. */
export function percentile(values: Array<number> | null | undefined, p: number): number | null {
  const sorted = (values ?? []).filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

/** What one completion cost, in USD: the upstream cost OpenRouter reports (a BYOK key), else its own `cost`, else 0. */
export function costOf(usage: Rec | null): number {
  const value = Number(usage?.cost_details?.upstream_inference_cost ?? usage?.cost ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** What `summarize` counts over a run's results. */
export type Summary = {
  questions: number;
  answerable: number;
  hit1: number;
  hit5: number;
  seen: number;
  answeredByChat: number;
  hit1OrChat: number;
  hit5OrChat: number;
  seenOrChat: number;
  webAnswered: number;
  noneQuestions: number;
  falseConfident: number;
  failed: number;
  latencyMs: { median: number | null; p90: number | null };
  costUsd: number;
  misses: Array<{
    id: Untyped;
    question: Untyped;
    surfaced: Array<string>;
    seen: boolean;
    answer: Untyped;
    error: Untyped;
  }>;
};

/**
 * The run summed up from its per-question results (`{ id, question, kind, score, confident,
 * latencyMs, costUsd, error?, surfaced?, answer? }`): hit@1 and hit@5 over the answerable
 * questions (`exact` and `fuzzy`; one that failed counts as a miss), how many of those had an
 * expected id anywhere in the windows, how many were answered by the chat (`answeredByChat`: no
 * hit@5, an expected id in the asking channel's chat window), the same three hit counts with
 * those added (`hit1OrChat`, `hit5OrChat`, `seenOrChat`), the confident answers on `none`
 * questions, the questions the web search answered (`webAnswered`: a result with `web.found`),
 * the latency median and p90, the total cost, and the misses (no hit in the first five, not
 * answered by the chat).
 */
export function summarize(results: Array<QuestionResult>): Summary {
  const answerable = results.filter((r) => r.kind !== 'none');
  const none = results.filter((r) => r.kind === 'none');
  const count = (list: Array<QuestionResult>, pick: (r: QuestionResult) => boolean) => list.filter(pick).length;
  const inChat = (r: QuestionResult) => r.score?.inChat === true;
  return {
    questions: results.length,
    answerable: answerable.length,
    hit1: count(answerable, (r) => r.score?.hit1 === true),
    hit5: count(answerable, (r) => r.score?.hit5 === true),
    seen: count(answerable, (r) => r.score?.seen === true),
    answeredByChat: count(answerable, (r) => r.score?.outcome === 'in-chat'),
    hit1OrChat: count(answerable, (r) => r.score?.hit1 === true || inChat(r)),
    hit5OrChat: count(answerable, (r) => r.score?.hit5 === true || inChat(r)),
    seenOrChat: count(answerable, (r) => r.score?.seen === true || inChat(r)),
    webAnswered: count(results, (r) => r.web?.found === true),
    noneQuestions: none.length,
    falseConfident: count(none, (r) => r.score?.falseConfident === true),
    failed: count(results, (r) => Boolean(r.error)),
    latencyMs: {
      median: percentile(
        results.map((r) => r.latencyMs),
        50
      ),
      p90: percentile(
        results.map((r) => r.latencyMs),
        90
      ),
    },
    costUsd: Math.round(results.reduce((sum, r) => sum + (Number.isFinite(r.costUsd) ? r.costUsd : 0), 0) * 1e6) / 1e6,
    misses: answerable
      .filter((r) => r.score?.hit5 !== true && !inChat(r))
      .map((r) => ({
        id: r.id,
        question: r.question,
        surfaced: (r.score?.surfaced ?? []).slice(0, HIT_AT),
        seen: r.score?.seen === true,
        answer: r.answer ?? null,
        error: r.error ?? null,
      })),
  };
}

/**
 * The questions asked one at a time (concurrency 1) through `ask(question)`, which resolves a
 * result with its `costUsd`. At most `limit` questions; none asked once the summed cost has
 * passed `maxUsd` (`stopped: 'max-usd'`, the rest `skipped`). `onResult` sees each result.
 */
export async function runQuestions(
  questions: Array<Question>,
  {
    ask,
    maxUsd,
    limit = Infinity,
    onResult = null,
  }: {
    ask: (q: Question) => Promise<QuestionResult>;
    maxUsd: number;
    limit?: number;
    onResult?: ((r: Rec) => void) | null;
  }
): Promise<{ results: Array<QuestionResult>; spentUsd: number; stopped: 'max-usd' | null; skipped: number }> {
  const asked = questions.slice(0, Number.isFinite(limit) ? Math.max(0, limit) : questions.length);
  const results = [];
  let spentUsd = 0;
  for (const question of asked) {
    if (spentUsd > maxUsd) {
      return { results, spentUsd, stopped: 'max-usd', skipped: asked.length - results.length };
    }
    const result = await ask(question);
    spentUsd += Number.isFinite(result?.costUsd) ? result.costUsd : 0;
    results.push(result);
    onResult?.(result);
  }
  return { results, spentUsd, stopped: null, skipped: 0 };
}

/** `list` shuffled in place by `rng` (Fisher-Yates). */
function shuffle(list: Untyped, rng: Untyped) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** A record line as a neighbour or a candidate shows it. */
export type SampleLine = {
  id: Untyped;
  authorId: string | null;
  authorName: string | null;
  self: boolean;
  occurredAt: Untyped;
  text: string;
  media: Array<Untyped>;
};

/** A message sampled for question writing, with the lines around it. */
export type Candidate = SampleLine & {
  placeId: Untyped;
  replyTo: Untyped;
  before: Array<SampleLine>;
  after: Array<SampleLine>;
};

function sampleLine(line: Untyped, nameOf: Untyped): SampleLine {
  const by = typeof line.by === 'string' && line.by ? line.by : null;
  return {
    id: line.messageId,
    authorId: by,
    authorName: line.kind === 'said' ? null : ((by && typeof nameOf === 'function' ? nameOf(by) : null) ?? null),
    self: line.kind === 'said',
    occurredAt: line.occurredAt,
    text: typeof line.text === 'string' ? line.text : '',
    media: Array.isArray(line.media) ? line.media : [],
  };
}

/**
 * Raw material for writing questions by hand: at most `n` record messages from the last `days`
 * days, never from the last `recentDays`, spread across channels and days (channels taken in
 * turn, each through its days in turn, one random message per pick), each with its
 * `neighbours` lines before and after in its channel. A candidate is substantive: at least
 * `minChars` characters of text, not the persona's own (`said`, or written by `selfId`).
 * `lines` are latestLines' messages (neighbours may come from the recent days). Pure: `rng`
 * and `now` are injected. Oldest first.
 */
export function sampleCandidates(
  lines: Array<Rec>,
  {
    n,
    days,
    now,
    rng,
    selfId = null,
    minChars = 40,
    recentDays = 2,
    neighbours = 3,
    nameOf = null,
  }: {
    n: number;
    days: number;
    now: number;
    rng: () => number;
    selfId?: string | null;
    minChars?: number;
    recentDays?: number;
    neighbours?: number;
    nameOf?: ((id: string) => string | null) | null;
  }
): Array<Candidate> {
  const from = now - days * DAY_MS;
  const until = now - recentDays * DAY_MS;
  const byChannel = new Map();
  for (const line of lines) {
    const placeId = line.scope?.channel;
    if (!byChannel.has(placeId)) byChannel.set(placeId, []);
    byChannel.get(placeId).push(line);
  }
  for (const list of byChannel.values())
    list.sort((a: Rec, b: Rec) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));

  // Channel -> its day buckets of eligible messages.
  const buckets = new Map();
  for (const [placeId, list] of byChannel) {
    list.forEach((line: Untyped, index: number) => {
      const at = Date.parse(line.occurredAt);
      if (!(at >= from && at < until)) return;
      if (line.kind !== 'seen' || (selfId && line.by === selfId)) return;
      if ([...String(line.text ?? '').trim()].length < minChars) return;
      const day = line.occurredAt.slice(0, 10);
      if (!buckets.has(placeId)) buckets.set(placeId, new Map());
      const days_ = buckets.get(placeId);
      if (!days_.has(day)) days_.set(day, []);
      days_.get(day).push(index);
    });
  }
  const queues = shuffle([...buckets.keys()].sort(), rng).map((placeId: string) => ({
    placeId,
    days: shuffle(
      [...buckets.get(placeId).entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
      rng
    ),
  }));
  const picked = [];
  while (picked.length < n && queues.some((q: Rec) => q.days.length > 0)) {
    for (const queue of queues) {
      if (picked.length >= n) break;
      const bucket = queue.days.shift();
      if (!bucket) continue;
      const [day, indexes] = bucket;
      const index = indexes.splice(Math.floor(rng() * indexes.length), 1)[0];
      picked.push({ placeId: queue.placeId, index });
      if (indexes.length > 0) queue.days.push([day, indexes]);
    }
  }
  return picked
    .map(({ placeId, index }) => {
      const list = byChannel.get(placeId);
      const line = list[index];
      return {
        ...sampleLine(line, nameOf),
        placeId,
        replyTo: typeof line.replyTo === 'string' ? line.replyTo : null,
        before: list.slice(Math.max(0, index - neighbours), index).map((l: Untyped) => sampleLine(l, nameOf)),
        after: list.slice(index + 1, index + 1 + neighbours).map((l: Untyped) => sampleLine(l, nameOf)),
      };
    })
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
}

/**
 * A guild for the local stages, with no Discord behind it: every channel id resolves to a
 * readable text channel everyone may view (named by `channelNameOf`), the bot is a member
 * that may read everything, and the guild's message and member searches answer nothing, so
 * the Discord stage of a run finds no hit and fetches no window. The audience rail therefore
 * passes every channel: the local run sees more than a live turn in a channel some members
 * cannot view.
 */
export function localGuild({
  placeId,
  selfId = null,
  channelNameOf = () => null,
}: {
  placeId: string;
  selfId?: string | null;
  channelNameOf?: (id: string) => string | null;
}): Rec {
  const channels = new Map();
  const guild: Rec = {
    id: placeId,
    local: true,
    members: { me: { id: selfId ?? '0' }, cache: new Map() },
    roles: { everyone: { id: placeId }, cache: new Map() },
    client: {
      rest: {
        async get(route: string) {
          if (/\/messages\/search$/.test(String(route))) return { total_results: 0, messages: [] };
          if (/\/members\/search$/.test(String(route))) return [];
          throw new Error('local guild: no Discord route');
        },
      },
    },
  };
  const channelOf = (id: string) => ({
    id,
    name: channelNameOf(id) ?? id,
    guild,
    viewable: true,
    lastMessageId: null,
    isTextBased: () => true,
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
    permissionOverwrites: { cache: new Map() },
    messages: {
      async fetch() {
        throw new Error('local guild: no Discord history');
      },
    },
  });
  guild.channels = {
    cache: {
      get(id: string) {
        if (typeof id !== 'string' || !id) return undefined;
        if (!channels.has(id)) channels.set(id, channelOf(id));
        return channels.get(id);
      },
      has: (id: string) => typeof id === 'string' && id !== '',
      values: () => channels.values(),
      get size() {
        return channels.size;
      },
    },
  };
  return guild;
}

/** A chat of the local guild as the interface describes it: readable, writable and viewable by everyone. */
function localInfo(placeId: string, id: string, name: string) {
  return {
    id,
    kind: 'channel' as const,
    rootId: placeId,
    name,
    topic: null,
    iface: 'local',
    permissions: { read: true, send: true, attach: true, react: true },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
    audience: {
      everyone: true,
      groups: [],
      groupAllow: [],
      groupDeny: [],
      memberAllow: [],
      memberDeny: [],
      memberGroups: {},
    },
    viewers: {},
  };
}

/**
 * The reads of the local stages, with no interface behind them (the counterpart of `localGuild`): every chat
 * resolves to a channel everyone may view, the searches answer nothing and a history cannot be read, so the search stage
 * of a run finds no hit and reads no window.
 */
export function localReads({
  placeId,
  channelNameOf = () => null,
}: {
  placeId: string;
  channelNameOf?: (id: string) => string | null;
}): Reads {
  const info = (id: string) => localInfo(placeId, id, channelNameOf(id) ?? id);
  return {
    offers: () => true,
    answer: () => Promise.resolve({ status: 'unsupported' as const, code: 'not-offered' }),
    chatInfo: (ref: { chatId: string }) => Promise.resolve({ chat: info(ref.chatId) }),
    chats: () => Promise.resolve({ chats: [], groups: [] }),
    fetchMessages: () => Promise.resolve(null),
    history: () => Promise.resolve(null),
    memberInfo: () => Promise.resolve(null),
    dmChatOf: () => Promise.resolve(null),
    searchMessages: () => Promise.resolve({ total: 0, hits: [] }),
    searchMembers: () => Promise.resolve({ members: [] }),
    emoji: () => Promise.resolve({ emoji: [] }),
    parseLinks: (texts: ReadonlyArray<string>) => Promise.resolve({ refs: texts.map(() => null) }),
    reactors: () => Promise.resolve({ accountIds: [] }),
    inviteLink: () => Promise.resolve(null),
  };
}

/**
 * The scope a recall run is handed in the local guild (`channel` and `snapshot`): any channel id is a readable channel
 * everyone views, so the audience rail passes every chat.
 */
export function localScope({
  placeId,
  chatId,
  channelNameOf = () => null,
}: {
  placeId: string;
  chatId: string;
  channelNameOf?: (id: string) => string | null;
}): { channel: Untyped; snapshot: Untyped } {
  const info = (id: string) => localInfo(placeId, id, channelNameOf(id) ?? id);
  return {
    channel: info(chatId),
    snapshot: {
      placeId,
      chats: [],
      groups: [],
      get: (id: string) => (typeof id === 'string' && id !== '' ? info(id) : null),
    },
  };
}

/** One table cell: pipes escaped, line breaks flattened, cut to `max` characters. */
function cell(value: Untyped, max = 120) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '\\|');
  return [...text].length > max ? `${[...text].slice(0, max - 1).join('')}~` : text;
}

/** A share as `k/n (p %)`. */
function share(k: Untyped, n: Untyped) {
  return n > 0 ? `${k}/${n} (${Math.round((k / n) * 100)} %)` : 'N/A';
}

/** The markdown summary of a run for stdout. */
export function renderSummary(
  summary: Summary,
  {
    reportPath,
    stages,
    stopped = null,
    skipped = 0,
  }: { reportPath: string; stages: Rec; stopped: string | null; skipped: number }
): string {
  const ran = Object.entries(stages)
    .map(([name, on]) => `${name} ${on ? 'on' : 'off'}`)
    .join(', ');
  const out = [
    '# Recall evaluation',
    '',
    `Report: ${reportPath}`,
    `Stages: ${ran}`,
    `Questions: ${summary.questions} (answerable ${summary.answerable}, not in memory ${summary.noneQuestions}, failed ${summary.failed})${stopped ? `; stopped (${stopped}), ${skipped} not asked` : ''}`,
    '',
    '| measure | value |',
    '| --- | --- |',
    `| hit@1 | ${share(summary.hit1, summary.answerable)} |`,
    `| hit@${HIT_AT} | ${share(summary.hit5, summary.answerable)} |`,
    `| expected line anywhere in the windows | ${share(summary.seen, summary.answerable)} |`,
    `| answered by the chat (expected line in the asking channel's chat, no hit@${HIT_AT}) | ${share(summary.answeredByChat, summary.answerable)} |`,
    `| hit@1 or answered by the chat | ${share(summary.hit1OrChat, summary.answerable)} |`,
    `| hit@${HIT_AT} or answered by the chat | ${share(summary.hit5OrChat, summary.answerable)} |`,
    `| in the windows or answered by the chat | ${share(summary.seenOrChat, summary.answerable)} |`,
    ...(stages.web ? [`| answered by the web | ${share(summary.webAnswered, summary.questions)} |`] : []),
    `| false confident recalls | ${share(summary.falseConfident, summary.noneQuestions)} |`,
    `| latency median / p90 | ${summary.latencyMs.median ?? 'N/A'} ms / ${summary.latencyMs.p90 ?? 'N/A'} ms |`,
    `| total cost | ${summary.costUsd.toFixed(4)} USD |`,
    '',
    '## Misses',
    '',
  ];
  if (summary.misses.length === 0) out.push('none');
  else {
    out.push(`| id | question | first ${HIT_AT} surfaced | in windows | answer |`, '| --- | --- | --- | --- | --- |');
    for (const miss of summary.misses) {
      const answer = miss.error ? `error: ${miss.error}` : (miss.answer ?? '-');
      out.push(
        `| ${cell(miss.id, 40)} | ${cell(miss.question)} | ${miss.surfaced.join(' ') || '-'} | ${miss.seen ? 'yes' : 'no'} | ${cell(answer)} |`
      );
    }
  }
  return `${out.join('\n')}\n`;
}

/**
 * A prefetch result (src/behavior/recall-run.ts `prefetch`) as recall-eval scores it: its history
 * excerpts' message ids as the windows, their relevant hits first in excerpt order as the matched
 * ids (scoreQuestion's inputs). A missing result gives none.
 */
export function prefetchWindows(found: { excerpts?: Array<Rec> } | null): {
  windows: Array<Array<Rec>>;
  matched: Array<string>;
} {
  const history = (found?.excerpts ?? []).filter((e) => e?.source === 'history' && Array.isArray(e.ids));
  return {
    windows: history.map((e) => e.ids.map((id: string) => ({ id }))),
    matched: history.flatMap((e) => (Array.isArray(e.hitIds) ? e.hitIds : [])),
  };
}

/** The classifier path and the prefetch side by side: both summed up, and the questions only one of them hit. */
export type PrefetchComparison = {
  classifier: Summary;
  prefetch: Summary;
  onlyClassifier: Array<string>;
  onlyPrefetch: Array<string>;
  noneShown: Array<string>;
  statuses: Record<string, number>;
};

/**
 * The comparison of the classifier path (`score`) and the prefetch (`prefetch.score`) per question
 * (`--prefetch`): both summed up with summarize, the questions where only one of them hit within
 * HIT_AT, and the `none` questions the prefetch still showed an excerpt for (`noneShown`).
 * @param results recall-eval's per-question results, each with `prefetch: { status, excerpts, score }`.
 */
export function comparePrefetch(results: Array<QuestionResult>): PrefetchComparison {
  const classifier = summarize(results);
  const prefetch = summarize(
    results.map((r) => ({
      ...r,
      score: r.prefetch?.score ?? null,
      web: null,
      latencyMs: r.prefetch?.ms ?? null,
      costUsd: 0,
      answer: null,
    }))
  );
  const hit = (score: Untyped) => score?.hit5 === true || score?.inChat === true;
  const answerable = results.filter((r) => r.kind !== 'none');
  return {
    classifier,
    prefetch,
    onlyClassifier: answerable.filter((r) => hit(r.score) && !hit(r.prefetch?.score)).map((r) => r.id),
    onlyPrefetch: answerable.filter((r) => !hit(r.score) && hit(r.prefetch?.score)).map((r) => r.id),
    noneShown: results.filter((r) => r.kind === 'none' && (r.prefetch?.excerpts ?? 0) > 0).map((r) => r.id),
    statuses: results.reduce<Record<string, number>>((acc, r) => {
      const status = r.prefetch?.status ?? 'none-ran';
      acc[status] = (acc[status] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

/** The markdown table of comparePrefetch for stdout: totals, then one row per question. */
export function renderPrefetchCompare(compare: PrefetchComparison, results: Untyped, { reportPath }: Untyped): string {
  const a = compare.classifier;
  const b = compare.prefetch;
  const out = [
    '# Recall evaluation: classifier forms (A) vs automatic prefetch (B)',
    '',
    `Report: ${reportPath}`,
    `Questions: ${a.questions} (answerable ${a.answerable}, not in memory ${a.noneQuestions})`,
    '',
    '| measure | A classifier | B prefetch |',
    '| --- | --- | --- |',
    `| hit@1 | ${share(a.hit1, a.answerable)} | ${share(b.hit1, b.answerable)} |`,
    `| hit@${HIT_AT} | ${share(a.hit5, a.answerable)} | ${share(b.hit5, b.answerable)} |`,
    `| hit@${HIT_AT} or answered by the chat | ${share(a.hit5OrChat, a.answerable)} | ${share(b.hit5OrChat, b.answerable)} |`,
    `| expected line anywhere shown | ${share(a.seen, a.answerable)} | ${share(b.seen, b.answerable)} |`,
    `| latency median / p90 | ${a.latencyMs.median ?? 'N/A'} / ${a.latencyMs.p90 ?? 'N/A'} ms | ${b.latencyMs.median ?? 'N/A'} / ${b.latencyMs.p90 ?? 'N/A'} ms |`,
    `| not-in-memory questions with an excerpt shown (B) | | ${share(compare.noneShown.length, a.noneQuestions)} |`,
    '',
    `Only A hit: ${compare.onlyClassifier.join(' ') || '-'}`,
    `Only B hit: ${compare.onlyPrefetch.join(' ') || '-'}`,
    `B statuses: ${
      Object.entries<number>(compare.statuses)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || '-'
    }`,
    '',
    '| id | kind | A rank | B rank | B status | B excerpts | question |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of results) {
    const prefetchScore = r.prefetch?.score as { rank?: number | null; inChat?: boolean } | undefined;
    out.push(
      `| ${cell(r.id, 40)} | ${r.kind} | ${r.score?.rank ?? (r.score?.inChat ? 'chat' : '-')} | ${prefetchScore?.rank ?? (prefetchScore?.inChat ? 'chat' : '-')} | ${r.prefetch?.status ?? '-'} | ${r.prefetch?.excerpts ?? 0} | ${cell(r.question, 80)} |`
    );
  }
  return `${out.join('\n')}\n`;
}

/**
 * Whether a prefetch found what a live recall run found (`trace`, a recall-trace.jsonl line):
 * `same` when an excerpt holds a message the run kept as a hit (its kept record windows' hits, its
 * kept meaning rows) or overlaps in time a window it kept (a kept Discord cluster or record window,
 * same channel); `partial` when an excerpt sits in the channel of a kept window within `nearMs` of
 * it; `none` when no excerpt does; `n/a` when the run kept nothing. Pure.
 */
export function traceAgreement(
  trace: Rec,
  excerpts: Array<{ source: string; placeId?: string; ids?: Array<string>; startTs?: number; endTs?: number }>,
  { nearMs = DAY_MS }: { nearMs?: number } = {}
): 'same' | 'partial' | 'none' | 'n/a' {
  const spans = [
    ...(trace?.clusters ?? []).filter((c: Rec) => c?.kept),
    ...(trace?.record ?? []).filter((w: Rec) => w?.kept),
  ]
    .map((w) => ({ placeId: w.placeId, from: Date.parse(w.from), to: Date.parse(w.to) }))
    .filter((w) => w.placeId && Number.isFinite(w.from) && Number.isFinite(w.to));
  const hitIds = new Set([
    ...(trace?.record ?? []).filter((w: Rec) => w?.kept).flatMap((w: Rec) => w.hitIds ?? []),
    ...(trace?.meaning?.kept ?? []).filter((row: Untyped) => row?.kind === 'record').map((row: Untyped) => row.id),
  ]);
  if (spans.length === 0 && hitIds.size === 0) return 'n/a';
  const history = (excerpts ?? []).filter((e) => e?.source === 'history');
  const overlaps = (e: Untyped, margin: Untyped) =>
    spans.some(
      (w) =>
        w.placeId === e.placeId &&
        Number.isFinite(e.startTs) &&
        e.startTs <= w.to + margin &&
        (Number.isFinite(e.endTs) ? e.endTs : e.startTs) >= w.from - margin
    );
  if (history.some((e) => (e.ids ?? []).some((id) => hitIds.has(id)) || overlaps(e, 0))) return 'same';
  if (history.some((e) => overlaps(e, nearMs))) return 'partial';
  return 'none';
}

/** The first relevant line of a prefetch's top excerpt, flattened and cut to `max` characters ('' for none). */
export function topExcerptLine(found: Untyped, max = 90): string {
  const first = (found?.excerpts ?? [])[0];
  if (!first) return '';
  const lines = String(first.lines ?? '').split('\n');
  const marked = lines.find((line) => line.startsWith('>> ')) ?? lines[0] ?? '';
  return cell(marked, max);
}

/**
 * The markdown table of the live-trace comparison (`traces`): totals, then one row per trace --
 * its date, the trigger cut short, the classifier's forms, whether the classifier's run found
 * something (`text` answer), whether the prefetch found the same, and the prefetch's top line.
 * @param rows `{ at, trigger, forms, answer, agreement, status, excerpts, top, error? }`
 */
export function renderTraceCompare(rows: Array<Rec>, { reportPath }: Rec): string {
  const ran = rows.filter((r) => !r.error);
  const found = ran.filter((r) => r.answer === 'text');
  const nothing = ran.filter((r) => r.answer !== 'text');
  const day = (at: Untyped) =>
    cell(
      String(at ?? '')
        .slice(0, 16)
        .replace('T', ' '),
      20
    );
  const count = (list: Untyped, pick: Rec) => list.filter(pick).length;
  const out = [
    '# Recall evaluation: live recall traces vs automatic prefetch',
    '',
    `Report: ${reportPath}`,
    `Traces: ${rows.length} (classifier answered ${found.length}, nothing or no summary ${nothing.length}, not replayed ${rows.length - ran.length})`,
    '',
    '| measure | value |',
    '| --- | --- |',
    `| classifier answered: prefetch found the same | ${share(
      count(found, (r: Untyped) => r.agreement === 'same'),
      found.length
    )} |`,
    `| classifier answered: prefetch partial (same channel, near) | ${share(
      count(found, (r: Untyped) => r.agreement === 'partial'),
      found.length
    )} |`,
    `| classifier answered: prefetch found none of it | ${share(
      count(found, (r: Untyped) => r.agreement === 'none' || r.agreement === 'n/a'),
      found.length
    )} |`,
    `| classifier answered: prefetch showed anything | ${share(
      count(found, (r: Untyped) => r.excerpts > 0),
      found.length
    )} |`,
    `| classifier found nothing: prefetch showed anything | ${share(
      count(nothing, (r: Untyped) => r.excerpts > 0),
      nothing.length
    )} |`,
    '',
    '| date | trigger | classifier forms | classifier found | prefetch same | prefetch status | prefetch top hit |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    if (r.error) {
      out.push(
        `| ${day(r.at)} | - | ${cell((r.forms ?? []).join(', '), 60)} | ${r.answer ?? '-'} | - | error: ${cell(r.error, 40)} | - |`
      );
      continue;
    }
    const same =
      r.agreement === 'same' ? 'Y' : r.agreement === 'partial' ? 'partial' : r.agreement === 'n/a' ? '-' : 'N';
    out.push(
      `| ${day(r.at)} | ${cell(r.trigger, 60)} | ${cell((r.forms ?? []).join(', '), 60)} | ${r.answer === 'text' ? 'Y' : 'N'} | ${same} | ${r.status} (${r.excerpts}) | ${cell(r.top || '-', 90)} |`
    );
  }
  return `${out.join('\n')}\n`;
}
