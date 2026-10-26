// The pure parts of tools/recall-eval.mjs: the questions file checked, record lines turned
// into chat messages, the ids a recall run surfaced scored against the expected ones, the run
// summed up (hit@1, hit@5, answered by the chat, false confident recalls, web answers, latency,
// cost), the question loop with its spend stop, the candidate sample for writing questions by
// hand, and the offline guild the local stages run against. Nothing here reads a file, the
// network or the clock.

import { recordMessage } from '../../src/behavior/recall.js';

/** The kinds of a question: the answer is one exact message, a looser stretch, or not in memory at all. */
export const QUESTION_KINDS = Object.freeze(['exact', 'fuzzy', 'none']);
/** How many surfaced ids count for the wide hit. */
export const HIT_AT = 5;
const SNOWFLAKE = /^\d{17,20}$/;
const DAY_MS = 86_400_000;

/** Whether `value` is a Discord id. */
export function isSnowflake(value) {
  return typeof value === 'string' && SNOWFLAKE.test(value);
}

/**
 * The questions of a parsed questions file: `[{ id, channelId, askerId, question, expected:
 * [messageId...], kind: 'exact'|'fuzzy'|'none', note? }]`. `errors` names every problem by the
 * question's position and id (never its text); a file with any error should not be run. A
 * `none` question expects no message (the answer is not in memory); the others expect at
 * least one. Ids are unique.
 * @param {unknown} value
 * @returns {{ questions: object[], errors: string[] }}
 */
export function parseQuestions(value) {
  if (!Array.isArray(value)) return { questions: [], errors: ['the file is not a JSON array'] };
  const questions = [];
  const errors = [];
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
    if (!isSnowflake(raw.channelId)) problems.push('channelId is not a Discord id');
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
      channelId: raw.channelId,
      askerId: raw.askerId,
      question: raw.question,
      expected: [...new Set(expected)],
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
 * @param {Iterable<object>} lines  Record lines (src/memory/record.js).
 * @returns {object[]}
 */
export function latestLines(lines) {
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
 * function (src/behavior/recall.js#recordMessage), so the chat the tool shows the classifier reads
 * as the record windows do. The line needs a channel (latestLines keeps only such lines).
 */
export { recordMessage };

/**
 * The ids a run surfaced, in order: first the matched ones (a search hit, a record match, a
 * meaning row) as the windows come, then every other line of the windows; each id once.
 * `windows` are the message lists the summary read, in its order.
 * @param {object[][]} windows
 * @param {Set<string>|string[]} matched
 * @returns {{ surfaced: string[], matched: string[] }}
 */
export function surfacedIds(windows, matched) {
  const hits = matched instanceof Set ? matched : new Set(matched ?? []);
  const first = [];
  const rest = [];
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
 * @param {{ kind: string, expected: string[] }} question
 * @param {{ windows?: object[][], matched?: Iterable<string>, confident?: boolean, chatIds?: Iterable<string> }} run
 */
export function scoreQuestion(question, { windows = [], matched = [], confident = false, chatIds = [] } = {}) {
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
export function percentile(values, p) {
  const sorted = (values ?? []).filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

/** What one completion cost, in USD: the upstream cost OpenRouter reports (a BYOK key), else its own `cost`, else 0. */
export function costOf(usage) {
  const value = Number(usage?.cost_details?.upstream_inference_cost ?? usage?.cost ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

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
 * @param {object[]} results
 */
export function summarize(results) {
  const answerable = results.filter((r) => r.kind !== 'none');
  const none = results.filter((r) => r.kind === 'none');
  const count = (list, pick) => list.filter(pick).length;
  const inChat = (r) => r.score?.inChat === true;
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
 * @param {object[]} questions
 * @param {{ ask: (q: object) => Promise<object>, maxUsd: number, limit?: number, onResult?: (r: object) => void }} options
 * @returns {Promise<{ results: object[], spentUsd: number, stopped: 'max-usd'|null, skipped: number }>}
 */
export async function runQuestions(questions, { ask, maxUsd, limit = Infinity, onResult = null }) {
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
function shuffle(list, rng) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** A record line as a neighbour or a candidate shows it. */
function sampleLine(line, nameOf) {
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
 * @param {object[]} lines
 * @param {{ n: number, days: number, now: number, rng: () => number, selfId?: string|null, minChars?: number,
 *   recentDays?: number, neighbours?: number, nameOf?: (id: string) => string|null }} options
 */
export function sampleCandidates(
  lines,
  { n, days, now, rng, selfId = null, minChars = 40, recentDays = 2, neighbours = 3, nameOf = null }
) {
  const from = now - days * DAY_MS;
  const until = now - recentDays * DAY_MS;
  const byChannel = new Map();
  for (const line of lines) {
    const channelId = line.scope?.channel;
    if (!byChannel.has(channelId)) byChannel.set(channelId, []);
    byChannel.get(channelId).push(line);
  }
  for (const list of byChannel.values()) list.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));

  // Channel -> its day buckets of eligible messages.
  const buckets = new Map();
  for (const [channelId, list] of byChannel) {
    list.forEach((line, index) => {
      const at = Date.parse(line.occurredAt);
      if (!(at >= from && at < until)) return;
      if (line.kind !== 'seen' || (selfId && line.by === selfId)) return;
      if ([...String(line.text ?? '').trim()].length < minChars) return;
      const day = line.occurredAt.slice(0, 10);
      if (!buckets.has(channelId)) buckets.set(channelId, new Map());
      const days_ = buckets.get(channelId);
      if (!days_.has(day)) days_.set(day, []);
      days_.get(day).push(index);
    });
  }
  const queues = shuffle([...buckets.keys()].sort(), rng).map((channelId) => ({
    channelId,
    days: shuffle(
      [...buckets.get(channelId).entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
      rng
    ),
  }));
  const picked = [];
  while (picked.length < n && queues.some((q) => q.days.length > 0)) {
    for (const queue of queues) {
      if (picked.length >= n) break;
      const bucket = queue.days.shift();
      if (!bucket) continue;
      const [day, indexes] = bucket;
      const index = indexes.splice(Math.floor(rng() * indexes.length), 1)[0];
      picked.push({ channelId: queue.channelId, index });
      if (indexes.length > 0) queue.days.push([day, indexes]);
    }
  }
  return picked
    .map(({ channelId, index }) => {
      const list = byChannel.get(channelId);
      const line = list[index];
      return {
        ...sampleLine(line, nameOf),
        channelId,
        replyTo: typeof line.replyTo === 'string' ? line.replyTo : null,
        before: list.slice(Math.max(0, index - neighbours), index).map((l) => sampleLine(l, nameOf)),
        after: list.slice(index + 1, index + 1 + neighbours).map((l) => sampleLine(l, nameOf)),
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
 * @param {{ guildId: string, selfId?: string|null, channelNameOf?: (id: string) => string|null }} options
 */
export function localGuild({ guildId, selfId = null, channelNameOf = () => null }) {
  const channels = new Map();
  const guild = {
    id: guildId,
    local: true,
    members: { me: { id: selfId ?? '0' }, cache: new Map() },
    roles: { everyone: { id: guildId }, cache: new Map() },
    client: {
      rest: {
        async get(route) {
          if (/\/messages\/search$/.test(String(route))) return { total_results: 0, messages: [] };
          if (/\/members\/search$/.test(String(route))) return [];
          throw new Error('local guild: no Discord route');
        },
      },
    },
  };
  const channelOf = (id) => ({
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
      get(id) {
        if (typeof id !== 'string' || !id) return undefined;
        if (!channels.has(id)) channels.set(id, channelOf(id));
        return channels.get(id);
      },
      has: (id) => typeof id === 'string' && id !== '',
      values: () => channels.values(),
      get size() {
        return channels.size;
      },
    },
  };
  return guild;
}

/** One table cell: pipes escaped, line breaks flattened, cut to `max` characters. */
function cell(value, max = 120) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '\\|');
  return [...text].length > max ? `${[...text].slice(0, max - 1).join('')}~` : text;
}

/** A share as `k/n (p %)`. */
function share(k, n) {
  return n > 0 ? `${k}/${n} (${Math.round((k / n) * 100)} %)` : 'N/A';
}

/**
 * The markdown summary of a run for stdout.
 * @param {ReturnType<typeof summarize>} summary
 * @param {{ reportPath: string, stages: object, stopped: string|null, skipped: number }} meta
 */
export function renderSummary(summary, { reportPath, stages, stopped = null, skipped = 0 }) {
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
 * A prefetch result (src/behavior/recall-run.js `prefetch`) as recall-eval scores it: its history
 * excerpts' message ids as the windows, their relevant hits first in excerpt order as the matched
 * ids (scoreQuestion's inputs). A missing result gives none.
 * @param {{ excerpts?: object[] }|null} found
 * @returns {{ windows: object[][], matched: string[] }}
 */
export function prefetchWindows(found) {
  const history = (found?.excerpts ?? []).filter((e) => e?.source === 'history' && Array.isArray(e.ids));
  return {
    windows: history.map((e) => e.ids.map((id) => ({ id }))),
    matched: history.flatMap((e) => (Array.isArray(e.hitIds) ? e.hitIds : [])),
  };
}

/**
 * The comparison of the classifier path (`score`) and the prefetch (`prefetch.score`) per question
 * (`--prefetch`): both summed up with summarize, the questions where only one of them hit within
 * HIT_AT, and the `none` questions the prefetch still showed an excerpt for (`noneShown`).
 * @param {object[]} results  recall-eval's per-question results, each with `prefetch: { status, excerpts, score }`.
 */
export function comparePrefetch(results) {
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
  const hit = (score) => score?.hit5 === true || score?.inChat === true;
  const answerable = results.filter((r) => r.kind !== 'none');
  return {
    classifier,
    prefetch,
    onlyClassifier: answerable.filter((r) => hit(r.score) && !hit(r.prefetch?.score)).map((r) => r.id),
    onlyPrefetch: answerable.filter((r) => !hit(r.score) && hit(r.prefetch?.score)).map((r) => r.id),
    noneShown: results.filter((r) => r.kind === 'none' && (r.prefetch?.excerpts ?? 0) > 0).map((r) => r.id),
    statuses: results.reduce((acc, r) => {
      const status = r.prefetch?.status ?? 'none-ran';
      acc[status] = (acc[status] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

/** The markdown table of comparePrefetch for stdout: totals, then one row per question. */
export function renderPrefetchCompare(compare, results, { reportPath }) {
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
      Object.entries(compare.statuses)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || '-'
    }`,
    '',
    '| id | kind | A rank | B rank | B status | B excerpts | question |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of results) {
    out.push(
      `| ${cell(r.id, 40)} | ${r.kind} | ${r.score?.rank ?? (r.score?.inChat ? 'chat' : '-')} | ${r.prefetch?.score?.rank ?? (r.prefetch?.score?.inChat ? 'chat' : '-')} | ${r.prefetch?.status ?? '-'} | ${r.prefetch?.excerpts ?? 0} | ${cell(r.question, 80)} |`
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
 * @param {object} trace
 * @param {{ source: string, channelId?: string, ids?: string[], startTs?: number, endTs?: number }[]} excerpts
 * @param {{ nearMs?: number }} [options]
 * @returns {'same'|'partial'|'none'|'n/a'}
 */
export function traceAgreement(trace, excerpts, { nearMs = DAY_MS } = {}) {
  const spans = [...(trace?.clusters ?? []).filter((c) => c?.kept), ...(trace?.record ?? []).filter((w) => w?.kept)]
    .map((w) => ({ channelId: w.channelId, from: Date.parse(w.from), to: Date.parse(w.to) }))
    .filter((w) => w.channelId && Number.isFinite(w.from) && Number.isFinite(w.to));
  const hitIds = new Set([
    ...(trace?.record ?? []).filter((w) => w?.kept).flatMap((w) => w.hitIds ?? []),
    ...(trace?.meaning?.kept ?? []).filter((row) => row?.kind === 'record').map((row) => row.id),
  ]);
  if (spans.length === 0 && hitIds.size === 0) return 'n/a';
  const history = (excerpts ?? []).filter((e) => e?.source === 'history');
  const overlaps = (e, margin) =>
    spans.some(
      (w) =>
        w.channelId === e.channelId &&
        Number.isFinite(e.startTs) &&
        e.startTs <= w.to + margin &&
        (Number.isFinite(e.endTs) ? e.endTs : e.startTs) >= w.from - margin
    );
  if (history.some((e) => (e.ids ?? []).some((id) => hitIds.has(id)) || overlaps(e, 0))) return 'same';
  if (history.some((e) => overlaps(e, nearMs))) return 'partial';
  return 'none';
}

/** The first relevant line of a prefetch's top excerpt, flattened and cut to `max` characters ('' for none). */
export function topExcerptLine(found, max = 90) {
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
 * @param {object[]} rows  `{ at, trigger, forms, answer, agreement, status, excerpts, top, error? }`
 */
export function renderTraceCompare(rows, { reportPath }) {
  const ran = rows.filter((r) => !r.error);
  const found = ran.filter((r) => r.answer === 'text');
  const nothing = ran.filter((r) => r.answer !== 'text');
  const day = (at) =>
    cell(
      String(at ?? '')
        .slice(0, 16)
        .replace('T', ' '),
      20
    );
  const count = (list, pick) => list.filter(pick).length;
  const out = [
    '# Recall evaluation: live recall traces vs automatic prefetch',
    '',
    `Report: ${reportPath}`,
    `Traces: ${rows.length} (classifier answered ${found.length}, nothing or no summary ${nothing.length}, not replayed ${rows.length - ran.length})`,
    '',
    '| measure | value |',
    '| --- | --- |',
    `| classifier answered: prefetch found the same | ${share(
      count(found, (r) => r.agreement === 'same'),
      found.length
    )} |`,
    `| classifier answered: prefetch partial (same channel, near) | ${share(
      count(found, (r) => r.agreement === 'partial'),
      found.length
    )} |`,
    `| classifier answered: prefetch found none of it | ${share(
      count(found, (r) => r.agreement === 'none' || r.agreement === 'n/a'),
      found.length
    )} |`,
    `| classifier answered: prefetch showed anything | ${share(
      count(found, (r) => r.excerpts > 0),
      found.length
    )} |`,
    `| classifier found nothing: prefetch showed anything | ${share(
      count(nothing, (r) => r.excerpts > 0),
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
