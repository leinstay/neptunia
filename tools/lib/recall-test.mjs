// The pure parts of tools/recall-test.mjs: the questions file checked, record lines turned
// into chat messages, the ids a recall run surfaced scored against the expected ones, the run
// summed up (hit@1, hit@5, false confident recalls, latency, cost), the question loop with its
// spend stop, the candidate sample for writing questions by hand, and the offline guild the
// local stages run against. Nothing here reads a file, the network or the clock.

/** The kinds of a question: the answer is one exact message, a looser stretch, or not in memory at all. */
export const QUESTION_KINDS = Object.freeze(['exact', 'fuzzy', 'none']);
/** How many surfaced ids count for the wide hit. */
export const HIT_AT = 5;
const SNOWFLAKE = /^\d{17,20}$/;
const DAY_MS = 86_400_000;
/** The author mark of a line whose author has no stored name (src/behavior/recall.js NO_FIELD). */
const NO_NAME = '-';

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
    else if (raw.kind !== 'none' && QUESTION_KINDS.includes(raw.kind) && expected.length === 0) problems.push('expected is empty');
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
 * A record line as a normalized chat message (the shape src/behavior/recall.js reads its record
 * windows in): the persona's own `said` line marked `self` under `selfName`, any other author
 * under `nameOf(by)`, else `-`.
 * @param {object} line
 * @param {{ nameOf?: (id: string) => string|null, selfName?: string }} [options]
 */
export function recordMessage(line, { nameOf = null, selfName = '' } = {}) {
  const self = line.kind === 'said';
  const by = typeof line.by === 'string' && line.by ? line.by : null;
  const name = self ? String(selfName ?? '') : by && typeof nameOf === 'function' ? String(nameOf(by) ?? '') : '';
  return {
    id: line.messageId,
    channelId: line.scope?.channel ?? null,
    authorId: by,
    authorName: name || NO_NAME,
    self,
    bot: false,
    content: typeof line.text === 'string' ? line.text : '',
    ts: Date.parse(line.occurredAt),
    replyToId: typeof line.replyTo === 'string' && line.replyTo ? line.replyTo : null,
    mentionedUserIds: Array.isArray(line.mentions) ? line.mentions : [],
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    forwarded: [],
    reactions: [],
  };
}

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
 * A `none` question has no hits (null) and counts a confident answer as a false one.
 * @param {{ kind: string, expected: string[] }} question
 * @param {{ windows?: object[][], matched?: Iterable<string>, confident?: boolean }} run
 */
export function scoreQuestion(question, { windows = [], matched = [], confident = false } = {}) {
  const { surfaced, matched: hitOrder } = surfacedIds(windows, new Set(matched));
  if (question.kind === 'none') {
    return { surfaced, rank: null, hit1: null, hit5: null, seen: null, windowRank: null, falseConfident: confident === true };
  }
  const expected = new Set(question.expected);
  const at = hitOrder.findIndex((id) => expected.has(id));
  const rank = at === -1 ? null : at + 1;
  const windowAt = (windows ?? []).findIndex((window) => (window ?? []).some((m) => expected.has(m?.id)));
  return {
    surfaced,
    rank,
    hit1: rank === 1,
    hit5: rank !== null && rank <= HIT_AT,
    seen: windowAt !== -1,
    windowRank: windowAt === -1 ? null : windowAt + 1,
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
 * expected id anywhere in the windows, the confident answers on `none` questions, the latency
 * median and p90, the total cost, and the misses (no hit in the first five).
 * @param {object[]} results
 */
export function summarize(results) {
  const answerable = results.filter((r) => r.kind !== 'none');
  const none = results.filter((r) => r.kind === 'none');
  const count = (list, pick) => list.filter(pick).length;
  return {
    questions: results.length,
    answerable: answerable.length,
    hit1: count(answerable, (r) => r.score?.hit1 === true),
    hit5: count(answerable, (r) => r.score?.hit5 === true),
    seen: count(answerable, (r) => r.score?.seen === true),
    noneQuestions: none.length,
    falseConfident: count(none, (r) => r.score?.falseConfident === true),
    failed: count(results, (r) => Boolean(r.error)),
    latencyMs: {
      median: percentile(results.map((r) => r.latencyMs), 50),
      p90: percentile(results.map((r) => r.latencyMs), 90),
    },
    costUsd: Math.round(results.reduce((sum, r) => sum + (Number.isFinite(r.costUsd) ? r.costUsd : 0), 0) * 1e6) / 1e6,
    misses: answerable
      .filter((r) => r.score?.hit5 !== true)
      .map((r) => ({ id: r.id, question: r.question, surfaced: (r.score?.surfaced ?? []).slice(0, HIT_AT), seen: r.score?.seen === true, answer: r.answer ?? null, error: r.error ?? null })),
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
    authorName: line.kind === 'said' ? null : (by && typeof nameOf === 'function' ? nameOf(by) : null) ?? null,
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
export function sampleCandidates(lines, { n, days, now, rng, selfId = null, minChars = 40, recentDays = 2, neighbours = 3, nameOf = null }) {
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
    days: shuffle([...buckets.get(channelId).entries()].sort(([a], [b]) => (a < b ? -1 : 1)), rng),
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
  const text = String(value ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|');
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
  const ran = Object.entries(stages).map(([name, on]) => `${name} ${on ? 'on' : 'off'}`).join(', ');
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
      out.push(`| ${cell(miss.id, 40)} | ${cell(miss.question)} | ${miss.surfaced.join(' ') || '-'} | ${miss.seen ? 'yes' : 'no'} | ${cell(answer)} |`);
    }
  }
  return `${out.join('\n')}\n`;
}
