#!/usr/bin/env node
// Operations tool: the persona's reply turns from before the journal, imported into it.
// The journal (src/memory/journal.js) started after the bot had been talking for weeks; those
// earlier turns -- what she thought and what she posted -- exist only in OpenRouter's stored
// request logs. The owner exports a CSV of the voice model's generation ids; this tool reads each
// stored generation once (`GET <llm.baseUrl>/generation/content?id=<id>`, the bot's key from
// .env, never printed), keeps a small cache entry per generation (its output, its timing, the
// first SYSTEM_SAMPLE_CHARS characters of its system prompt and its task line; never the rest of
// the input) in a cache directory outside data/, so a rerun fetches only what is missing, and:
//
//   1. classifies it: a reply turn is a generation whose system prompt is the reply one (the first
//      line of prompts/system-prompt.md as the live layers have it, rendered with `--name` or the
//      backfill's saved name, or `--reply-prefix`) and whose output holds an action tag; the rest
//      (analyzer batches, warmup, portraits, ...) is counted by the start of its system prompt;
//   2. parses a reply turn's output with the live parser (src/llm/parse.js#parseOutput);
//   3. matches its `<msg>` texts to her posted messages in the record (`said` lines, and `seen`
//      lines by her own id when the backfill saved it), every channel and private record, posted
//      within [created_at, created_at + generation time + --slack-min] (tools/lib/import-turns.mjs
//      #matchTurns); a turn whose messages match nothing is only counted, unless
//      `--include-unmatched` imports it too, with `importMatch.unmatched` (off by default: a mentor
//      replay or a private chat's turn would land in the guild journal with no participants);
//   4. with `--write`, appends one `turn` record per turn through the journal's own writer
//      (`journal.turn`: `origin: 'imported'`, `sourceGenerationId`, `mode: 'reply'`, the think
//      capped at `journal.thinkChars`, the posted message ids), so `/nep memory journal message:`
//      finds it. A generation already imported (its `sourceGenerationId` in any journal) or at or
//      after the journal's first live record is never written.
//
//   cd /opt/neptunia/app && node tools/import-turns.mjs --csv <file> [--from <day|iso>] [--to <day|iso>]
//     [--cache <dir>] [--concurrency 3] [--rate 5] [--reply-prefix <text>] [--name <name>]
//     [--key-name <api key name>] [--min-similarity 0.6] [--slack-min 3] [--self-id <id>]
//     [--guild <id>] [--data <dir>] [--include-unmatched] [--write]
//
// `--key-name` keeps only the CSV rows of that `api_key_name` (the live persona's key); without it
// every key's rows are read, and the summary counts the generations per key name.
//
// A dry run is the default (`--dry` says so explicitly): it fetches into the cache and prints the
// counts, writing nothing under data/. `--write` refuses while the bot runs (the journal's
// `.running` marker) or a forget is under way, and leaves out a turn the deletion ledger would
// drop. Fetching spends no model request; it keeps to `--concurrency` requests at once and
// `--rate` per second, retries a 429 or a 5xx twice, and stops after ten failures in a row or when
// the first three answers carry no readable output (their shape is printed, never a text).
//
// Output: counts per kind and per day and five sample matches as ids and similarity, never a
// message's or a think's text. Logs go to stderr.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simKey, CliError, defaultDataDir, parseFlags, privateDirOf, resolveGuildId, runCli } from './lib/cli.mjs';
import {
  DEFAULT_GEN_MS, cacheEntryOf, classify, contentOf, generationsOf, kindKey, matchTurns, parseCsv, replyMatcher, shapeOf,
} from './lib/import-turns.mjs';
import { log as defaultLog } from '../src/log.js';
import { apiUrl } from '../src/llm/openrouter.js';
import { parseOutput } from '../src/llm/parse.js';
import { createAppendStore } from '../src/memory/append-store.js';
import { createJournal, journalDrops } from '../src/memory/journal.js';
import { createRecord, forgettingIds } from '../src/memory/record.js';
import { readLedger } from '../src/memory/store.js';
import { MINUTE_MS, utcDay } from '../src/time.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE =
  'usage: node tools/import-turns.mjs --csv <file> [--from <day|iso>] [--to <day|iso>] [--cache <dir>] [--concurrency 3] [--rate 5]\n' +
  '       [--reply-prefix <text>] [--name <name>] [--key-name <name>] [--min-similarity 0.6] [--slack-min 3] [--self-id <id>]\n' +
  '       [--guild <id>] [--data <dir>] [--include-unmatched] [--dry | --write]   (cwd: the bot directory)';
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_RATE = 5;
const DEFAULT_MIN_SIMILARITY = 0.6;
const DEFAULT_SLACK_MIN = 3;
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
/** Attempts per generation (a 429, a 5xx, a network error) and the wait before the second. */
const ATTEMPTS = 3;
const BACKOFF_MS = 2_000;
const FETCH_TIMEOUT_MS = 30_000;
/** Failures in a row before the fetching stops. */
const MAX_FAILURES_IN_A_ROW = 10;
/** Answers without a readable output, with none readable yet, before the run stops. */
const MAX_UNREADABLE_FIRST = 3;
const SAMPLES = 5;
const OTHER_KINDS_SHOWN = 12;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A number from a flag inside [min, max], `fallback` when absent; a CliError otherwise. */
function numberFlag(value, fallback, { min = 0, max = Infinity, integer = false } = {}) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new CliError(USAGE);
  return n;
}

/** A bound flag (`YYYY-MM-DD`: that day's start, or with `end` the next day's; an ISO time as is) in epoch ms. */
function boundFlag(value, { end = false } = {}) {
  if (value === undefined) return null;
  const ms = DAY_RE.test(value) ? Date.parse(`${value}T00:00:00Z`) + (end ? 86_400_000 : 0) : Date.parse(value);
  if (!Number.isFinite(ms)) throw new CliError(USAGE);
  return ms;
}

/** A JSON file's value, `fallback` when missing or unreadable. */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Whether `inner` is `outer` or lies under it. */
function isInside(inner, outer) {
  const rel = path.relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The parsed lines of a JSONL file, unreadable ones skipped. */
function* jsonLines(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object') yield value;
    } catch {
      // a torn or foreign line: not ours to read
    }
  }
}

/** The day files of a journal directory, oldest first. */
function dayFilesOf(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  return names.filter((name) => DAY_FILE_RE.test(name)).sort().map((name) => path.join(dir, name));
}

/** The private member directories of the guild that hold `sub` (`journal`, `record`). */
function privateIdsWith(guildDir, sub) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(guildDir, 'private'));
  } catch {
    names = [];
  }
  return names.filter((name) => USER_ID_RE.test(name) && fs.existsSync(path.join(guildDir, 'private', name, sub)));
}

/**
 * The journal's state for the import: the time of the guild journal's first record that was not
 * imported (null when there is none), and every `sourceGenerationId` already imported, in the
 * guild journal and every private one.
 */
function journalState(guildDir) {
  const guildJournal = path.join(guildDir, 'journal');
  let firstLiveMs = null;
  for (const file of dayFilesOf(guildJournal)) {
    for (const record of jsonLines(file)) {
      if (record.origin === 'imported') continue;
      const at = Date.parse(record.occurredAt);
      if (Number.isFinite(at) && (firstLiveMs === null || at < firstLiveMs)) firstLiveMs = at;
    }
    if (firstLiveMs !== null) break;
  }
  const imported = new Set();
  const dirs = [guildJournal, ...privateIdsWith(guildDir, 'journal').map((id) => path.join(guildDir, 'private', id, 'journal'))];
  for (const dir of dirs) {
    for (const file of dayFilesOf(dir)) {
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!text.includes('"sourceGenerationId"')) continue;
      for (const record of jsonLines(file)) {
        if (record.origin === 'imported' && typeof record.sourceGenerationId === 'string') imported.add(record.sourceGenerationId);
      }
    }
  }
  return { firstLiveMs, imported };
}

/** The cache file of a generation id. */
const cacheFileOf = (cacheDir, id) => path.join(cacheDir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

/** Write a cache entry whole (a `.tmp` file and a rename). */
function writeCache(cacheDir, entry) {
  const file = cacheFileOf(cacheDir, entry.id);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(entry));
  fs.renameSync(`${file}.tmp`, file);
}

/**
 * Fetch every generation of `gens` into the cache: at most `concurrency` at once, `rate` per
 * second, retries on a 429, a 5xx or a network error. Returns the counts.
 */
async function fetchAll(ctx, gens) {
  const counts = { fetched: 0, missing: 0, failed: 0, unreadable: 0, stopped: null };
  if (gens.length === 0) return counts;
  const key = ctx.apiKey();
  const spacing = 1000 / ctx.rate;
  let nextAt = 0;
  let inRow = 0;
  let readable = 0;
  let shapeLogged = false;
  let fatal = null;
  const slot = async () => {
    const t = ctx.now();
    const wait = Math.max(0, nextAt - t);
    nextAt = Math.max(t, nextAt) + spacing;
    if (wait > 0) await ctx.sleep(wait);
  };
  const failed = () => {
    counts.failed += 1;
    inRow += 1;
    if (inRow >= MAX_FAILURES_IN_A_ROW && !counts.stopped) counts.stopped = 'failures-in-a-row';
  };
  async function one(gen) {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      await slot();
      let response;
      try {
        response = await ctx.fetchImpl(apiUrl(ctx.baseUrl, `generation/content?id=${encodeURIComponent(gen.id)}`), {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (error) {
        ctx.log.warn('import-turns: fetch failed', { code: error?.code ?? error?.name ?? null, attempt });
        if (attempt < ATTEMPTS) await ctx.sleep(BACKOFF_MS * attempt);
        continue;
      }
      const status = response?.status;
      if (status === 404) {
        writeCache(ctx.cacheDir, { v: 1, id: gen.id, status: 'missing', createdAt: new Date(gen.createdAt).toISOString(), genMs: gen.genMs });
        counts.missing += 1;
        inRow = 0;
        return;
      }
      if (status === 401 || status === 403) {
        fatal = new CliError(`import-turns: OpenRouter refused the key (status ${status})`);
        return;
      }
      if (status === 429 || status >= 500) {
        ctx.log.warn('import-turns: fetch retry', { status, attempt });
        if (attempt < ATTEMPTS) await ctx.sleep(BACKOFF_MS * attempt);
        continue;
      }
      if (!response.ok) {
        ctx.log.warn('import-turns: fetch failed', { status });
        failed();
        return;
      }
      let body;
      try {
        body = await response.json();
      } catch {
        ctx.log.warn('import-turns: answer unreadable', { reason: 'not-json' });
        counts.unreadable += 1;
        return;
      }
      if (!shapeLogged) {
        shapeLogged = true;
        ctx.log.info('import-turns: response shape', { shape: shapeOf(body) });
      }
      const content = contentOf(body);
      if (content.output === null) {
        counts.unreadable += 1;
        if (readable === 0 && counts.unreadable >= MAX_UNREADABLE_FIRST) {
          fatal = new CliError(`import-turns: the answers carry no readable output; their shape: ${JSON.stringify(shapeOf(body))}`);
        }
        return;
      }
      readable += 1;
      inRow = 0;
      writeCache(ctx.cacheDir, cacheEntryOf(gen, content));
      counts.fetched += 1;
      return;
    }
    failed();
  }
  let next = 0;
  const worker = async () => {
    while (next < gens.length && !fatal && !counts.stopped) {
      const gen = gens[next];
      next += 1;
      await one(gen);
    }
  };
  await Promise.all(Array.from({ length: Math.min(ctx.concurrency, gens.length) }, worker));
  if (fatal) throw fatal;
  return counts;
}

/**
 * The persona's own posted messages in the record between `fromMs` and `toMs` (`said` lines, and
 * `seen` lines by `selfId`), from the guild record and every private one, the first revision of
 * each; and the author of every other message seen, for the reply targets.
 */
async function ownLines(ctx, fromMs, toMs) {
  const store = createAppendStore({ log: ctx.log, now: ctx.now });
  const record = createRecord({ appendStore: store, dataDir: ctx.dataDir, log: ctx.log, now: ctx.now });
  const mine = new Map(); // messageId -> line
  const authors = new Map(); // messageId -> by
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  try {
    for (const privateUserId of [null, ...privateIdsWith(ctx.guildDir, 'record')]) {
      for await (const line of record.iterate(ctx.guildId, { from, to, privateUserId })) {
        if (typeof line.messageId !== 'string' || !line.messageId) continue;
        const own = line.kind === 'said' || (line.kind === 'seen' && ctx.selfId && line.by === ctx.selfId);
        if (!own) {
          if (line.kind === 'seen' && typeof line.by === 'string') authors.set(line.messageId, line.by);
          continue;
        }
        const revision = Number.isInteger(line.revision) ? line.revision : 1;
        const known = mine.get(line.messageId);
        if (known && known.revision <= revision) continue;
        mine.set(line.messageId, {
          messageId: line.messageId,
          revision,
          at: Date.parse(line.occurredAt),
          channelId: typeof line.scope?.channel === 'string' ? line.scope.channel : null,
          privateUserId,
          text: typeof line.text === 'string' ? line.text : '',
          replyTo: typeof line.replyTo === 'string' && line.replyTo ? line.replyTo : null,
          participants: Array.isArray(line.participants) ? line.participants.filter((id) => typeof id === 'string') : [],
        });
      }
    }
  } finally {
    await store.close();
  }
  return { lines: [...mine.values()], authors };
}

/** The journal turn record of one imported reply turn (journal.turn adds the envelope and caps the think). */
function turnRecordOf(entry, parsed, match, authors) {
  const createdAt = Date.parse(entry.createdAt);
  const posted = match?.posted ?? [];
  const lines = match?.lines ?? [];
  const lastAt = posted.length > 0 ? Math.max(...posted.map((post) => post.at)) : null;
  // The message lookup reads the post's UTC day and the next: a turn whose post crossed midnight
  // is dated at its last post, so it is found.
  const occurredAt = lastAt !== null && utcDay(lastAt) > utcDay(createdAt) ? new Date(lastAt).toISOString() : entry.createdAt;
  const participants = [];
  const replyTargets = [];
  for (const line of lines) {
    for (const id of line.participants) if (!participants.includes(id)) participants.push(id);
    if (line.replyTo) {
      if (!replyTargets.includes(line.replyTo)) replyTargets.push(line.replyTo);
      const author = authors.get(line.replyTo);
      if (author && !participants.includes(author)) participants.push(author);
    }
  }
  const spoke = !parsed.skip;
  return {
    turnId: `t-imp-${entry.id}`,
    attemptId: 1,
    startedAt: entry.createdAt,
    occurredAt,
    channelId: match?.channelId ?? null,
    privateUserId: match?.privateUserId ?? null,
    mode: 'reply',
    outcome: spoke ? 'spoke' : 'skip',
    reason: null,
    participants,
    sourceMessageIds: replyTargets,
    think: parsed.think ? parsed.think : null,
    posted: lines.map((line) => ({ messageId: line.messageId, replyTo: line.replyTo })),
    reactions: [],
    actions: [],
    origin: 'imported',
    sourceGenerationId: entry.id,
    importMatch: { scores: match?.scores ?? [], unmatched: spoke && parsed.messages.length > 0 && posted.length === 0 },
  };
}

/**
 * The whole tool: the report (or a refusal, as a CliError).
 * @param {string[]} argv
 * @param {{ cwd?: string, rootDir?: string, now?: () => number, hot?: object, fetchImpl?: Function,
 *   apiKey?: string|null, log?: object, sleep?: (ms: number) => Promise<void> }} [options]  `hot`,
 *   `fetchImpl`, `apiKey` and `sleep` stand in for the live config, the network, .env and the
 *   clock's waits (test fakes).
 * @returns {Promise<string>}
 */
export async function main(argv, {
  cwd = process.cwd(), rootDir = ROOT, now = Date.now, hot: givenHot = null, fetchImpl = globalThis.fetch, apiKey = null, log = defaultLog,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const flags = parseFlags(argv, {
    values: ['--csv', '--from', '--to', '--cache', '--concurrency', '--rate', '--reply-prefix', '--name', '--key-name', '--min-similarity', '--slack-min', '--self-id', '--guild', '--data'],
    switches: ['--write', '--dry', '--include-unmatched'],
    usage: USAGE,
  });
  if (flags._.length > 0 || typeof flags['--csv'] !== 'string' || (flags['--write'] && flags['--dry'])) throw new CliError(USAGE);
  const write = flags['--write'] === true;
  const includeUnmatched = flags['--include-unmatched'] === true;
  const concurrency = numberFlag(flags['--concurrency'], DEFAULT_CONCURRENCY, { min: 1, max: 16, integer: true });
  const rate = numberFlag(flags['--rate'], DEFAULT_RATE, { min: 0.1, max: 50 });
  const minSimilarity = numberFlag(flags['--min-similarity'], DEFAULT_MIN_SIMILARITY, { min: 0, max: 1 });
  const slackMs = numberFlag(flags['--slack-min'], DEFAULT_SLACK_MIN, { max: 60 }) * MINUTE_MS;
  const fromFlag = boundFlag(flags['--from']);
  const toFlag = boundFlag(flags['--to'], { end: true });

  const dataDir = flags['--data'] !== undefined ? path.resolve(cwd, flags['--data']) : defaultDataDir(cwd);
  const cacheDir = path.resolve(cwd, flags['--cache'] ?? path.join(os.tmpdir(), 'nep-import-turns'));
  if (isInside(cacheDir, dataDir)) throw new CliError('import-turns: the cache directory must not be under data/');
  let hot = givenHot;
  if (!hot) {
    const { createHot } = await import('../src/hot.js');
    hot = createHot({ rootDir, privateDir: privateDirOf(rootDir) });
  }
  const guildId = resolveGuildId(dataDir, flags['--guild'] ?? (hot.config?.bot?.guildId || undefined));
  const guildDir = path.join(dataDir, 'guilds', guildId);
  if (write) {
    if (fs.existsSync(path.join(guildDir, 'journal', '.running'))) {
      throw new CliError('import-turns: the bot is running (the journal\'s .running marker); stop it first: sudo systemctl stop neptunia-bot');
    }
    if ((await forgettingIds(fs.promises, dataDir, guildId)).size > 0) throw new CliError('import-turns: a forget is under way; run again once it is done');
  }

  const { firstLiveMs, imported } = journalState(guildDir);
  const toMs = Math.min(toFlag ?? Infinity, firstLiveMs ?? Infinity);
  let csvText;
  try {
    csvText = fs.readFileSync(path.resolve(cwd, flags['--csv']), 'utf8');
  } catch (error) {
    throw new CliError(`import-turns: cannot read the CSV (${error?.code ?? 'error'})`);
  }
  const gens = generationsOf(parseCsv(csvText), { fromMs: fromFlag, toMs: Number.isFinite(toMs) ? toMs : null, keyName: flags['--key-name'] ?? null });

  // Fetch what the cache does not hold yet.
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachedBefore = gens.filter((gen) => fs.existsSync(cacheFileOf(cacheDir, gen.id)));
  const toFetch = gens.filter((gen) => !fs.existsSync(cacheFileOf(cacheDir, gen.id)));
  let key = apiKey;
  if (!key && toFetch.length > 0) {
    // Read as the bot reads it (src/config.js); never printed.
    const { loadDotEnv } = await import('../src/config.js');
    loadDotEnv(privateDirOf(rootDir));
    key = simKey('import-turns');
  }
  const ctx = { now, sleep, log, fetchImpl, cacheDir, concurrency, rate, apiKey: () => key, baseUrl: hot.config?.llm?.baseUrl || DEFAULT_BASE_URL };
  const fetchCounts = await fetchAll(ctx, toFetch);

  // Classify every cached generation.
  const prompts = hot.prompts ?? {};
  const saved = readJson(path.join(guildDir, 'record', 'backfill.json'), {}) ?? {};
  const name = flags['--name'] ?? (typeof saved.selfName === 'string' && saved.selfName ? saved.selfName : null);
  const isReply = replyMatcher({ prefix: flags['--reply-prefix'] ?? null, template: prompts['system-prompt'] ?? null, name });
  const replies = [];
  const otherKinds = new Map();
  for (const gen of gens) {
    const entry = readJson(cacheFileOf(cacheDir, gen.id), null);
    if (!entry || entry.status !== 'ok') continue;
    if (classify(entry, isReply) !== 'reply') {
      const kind = kindKey(entry);
      otherKinds.set(kind, (otherKinds.get(kind) ?? 0) + 1);
      continue;
    }
    const parsed = parseOutput(entry.output, { maxDrawChars: hot.config?.image?.maxPromptChars ?? 1600 });
    replies.push({ gen, entry: { ...entry, createdAt: new Date(gen.createdAt).toISOString() }, parsed });
  }

  // Match them to her posted messages.
  let matches = new Map();
  let authors = new Map();
  if (replies.length > 0) {
    const selfId = flags['--self-id'] ?? (typeof saved.selfId === 'string' && saved.selfId ? saved.selfId : null);
    const first = replies[0].gen.createdAt;
    const last = Math.max(...replies.map(({ gen }) => gen.createdAt + (Number.isFinite(gen.genMs) ? gen.genMs : DEFAULT_GEN_MS)));
    const own = await ownLines({ dataDir, guildDir, guildId, selfId, log, now }, first - MINUTE_MS, last + slackMs + MINUTE_MS);
    authors = own.authors;
    const turns = replies.map(({ gen, parsed }) => ({ id: gen.id, createdAt: gen.createdAt, genMs: gen.genMs, messages: parsed.messages.map((message) => message.text) }));
    matches = matchTurns(turns, own.lines, { slackMs, minSimilarity });
  }

  // The records, counted per day; written with --write.
  const ledger = readLedger(dataDir, guildId);
  const counts = { matched: 0, unmatched: 0, noText: 0, skip: 0, already: 0, forgotten: 0, unmatchedLeftOut: 0, toWrite: 0 };
  const days = new Map();
  const records = [];
  const samples = [];
  for (const { gen, entry, parsed } of replies) {
    const match = matches.get(gen.id);
    const record = turnRecordOf(entry, parsed, match, authors);
    const day = utcDay(gen.createdAt);
    const row = days.get(day) ?? { reply: 0, matched: 0, unmatched: 0, skip: 0 };
    row.reply += 1;
    if (record.outcome === 'skip') {
      counts.skip += 1;
      row.skip += 1;
    } else if (record.posted.length > 0) {
      counts.matched += 1;
      row.matched += 1;
      if (samples.length < SAMPLES) samples.push({ id: gen.id, posted: record.posted.map((post) => post.messageId), scores: match.scores });
    } else if (record.importMatch.unmatched) {
      counts.unmatched += 1;
      row.unmatched += 1;
    } else {
      counts.noText += 1;
    }
    days.set(day, row);
    if (imported.has(gen.id)) {
      counts.already += 1;
      continue;
    }
    // Only a turn matched to a posted message is known to be live; skips and turns with no text may be replays.
    if (record.posted.length === 0 && !includeUnmatched) {
      counts.unmatchedLeftOut += 1;
      continue;
    }
    const at = Date.parse(record.occurredAt);
    if (ledger.some((item) => journalDrops({ participants: record.participants, occurredAt: record.occurredAt }, item.userId, Date.parse(item.at)))) {
      counts.forgotten += 1;
      continue;
    }
    if (Number.isFinite(firstLiveMs) && gen.createdAt >= firstLiveMs) continue;
    if (!Number.isFinite(at)) continue;
    records.push(record);
  }
  counts.toWrite = records.length;

  let written = 0;
  if (write && records.length > 0) {
    const store = createAppendStore({ log, now });
    const journal = createJournal({ appendStore: store, dataDir, config: () => hot.config?.journal ?? {}, now, log });
    try {
      for (const record of records) await journal.turn(guildId, record);
      await store.flush();
    } finally {
      await store.close();
    }
    const failedWrites = store.stats()?.failed ?? 0;
    written = Math.max(0, records.length - failedWrites);
    if (failedWrites > 0) log.warn('import-turns: journal writes failed', { failed: failedWrites });
  }

  const keyCounts = new Map();
  for (const gen of gens) keyCounts.set(gen.keyName ?? '(none)', (keyCounts.get(gen.keyName ?? '(none)') ?? 0) + 1);
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : '-');
  const lines = [
    write ? 'import-turns: write' : 'import-turns: dry run (nothing written; --write imports)',
    `range: ${iso(fromFlag)} .. ${iso(toMs)} (the journal's first live record: ${iso(firstLiveMs)})`,
    `generations: ${gens.length}`,
    ...[...keyCounts].sort((a, b) => b[1] - a[1]).map(([keyName, n]) => `  key ${keyName}: ${n}`),
    `fetched: ${fetchCounts.fetched}, cached: ${cachedBefore.length}, missing: ${fetchCounts.missing}, failed: ${fetchCounts.failed}, unreadable: ${fetchCounts.unreadable}${fetchCounts.stopped ? `, stopped: ${fetchCounts.stopped}` : ''}`,
    `reply turns: ${replies.length}`,
    `other kinds: ${[...otherKinds.values()].reduce((sum, n) => sum + n, 0)}`,
    ...[...otherKinds].sort((a, b) => b[1] - a[1]).slice(0, OTHER_KINDS_SHOWN).map(([kind, n]) => `  ${String(n).padStart(6)}  ${kind}`),
    `matched: ${counts.matched}, unmatched: ${counts.unmatched}, no text: ${counts.noText}, skip: ${counts.skip}`,
    `already imported: ${counts.already}, left out by the deletion ledger: ${counts.forgotten}, unmatched left out: ${counts.unmatchedLeftOut}${includeUnmatched ? '' : ' (--include-unmatched imports them)'}`,
    write ? `written: ${written}` : `would write: ${counts.toWrite}`,
    '',
    'day         reply  matched  unmatched  skip',
    ...[...days].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, row]) =>
      `${day}  ${String(row.reply).padStart(5)}  ${String(row.matched).padStart(7)}  ${String(row.unmatched).padStart(9)}  ${String(row.skip).padStart(4)}`),
    '',
    'samples:',
    ...(samples.length > 0 ? samples.map((sample) => `  ${sample.id} -> ${sample.posted.join(', ')} (similarity ${sample.scores.join(', ')})`) : ['  none']),
  ];
  return `${lines.join('\n')}\n`;
}

runCli(import.meta.url, (argv) => main(argv));
