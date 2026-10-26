#!/usr/bin/env node
// Operations tool: measure recall against questions whose answers are known. Exists so a change
// to the server search (src/behavior/recall-run.js) can be judged by numbers -- hit@1, hit@5,
// confident answers to questions memory cannot answer, latency, cost -- instead of by a few
// live turns.
//
//   cd /opt/neptunia/app && node tools/recall-eval.mjs [<questions.json>] [--limit N] [--max-usd 3]
//        [--dry] [--discord] [--web] [--guild <id>] [--data <dir>] [--db <memory.db>] [--self-id <id>] [--self-name <name>]
//   cd /opt/neptunia/app && node tools/recall-eval.mjs sample [--n 80] [--days 30]
//        [--guild <id>] [--data <dir>] [--db <memory.db>] [--self-id <id>] [--seed <n>]
//   cd /opt/neptunia/app && node tools/recall-eval.mjs [<questions.json>] --prefetch [--no-deadline] [the flags above]
//   cd /opt/neptunia/app && node tools/recall-eval.mjs traces [<recall-trace.jsonl>] [--limit N] [--dry] [--no-deadline]
//        [--guild <id>] [--data <dir>] [--db <memory.db>] [--self-id <id>] [--self-name <name>]
//
// The memory is the memory database (`--db`, default `<data>/memory.db`), opened read only with no lock: it must be a
// copy or a quiet file. Nothing is written to it.
//
// The questions file (default data/recall-eval/questions.json): `[{ id, channelId, askerId,
// question, expected: [messageId...], kind: 'exact'|'fuzzy'|'none', note? }]`, checked by
// tools/lib/recall-eval.mjs#parseQuestions; `none` means the answer is not in memory.
//
// Each question is asked as a live turn asks it (src/behavior/turn.js#maybeLookup): the search
// classifier (prompts.lookup, purpose `lookup`) reads the channel's last lines and the question
// as a new message of `askerId` in `channelId`, now; its server part goes to the real recall
// runner (src/behavior/recall-run.js#createRecall `run`) as the persona's own memory.search does
// (`quotes`: the stretches of src/memory/db/recall.js, no summary request, so no `confident`
// answer), wired as src/index.js wires it: the memory database read only, the stored memory, the
// archive and the embedding client. A failed or empty classifier answer takes the live fallback
// (recall.fallbackOnClassifierFailure: the question's own words, fallbackLookupPlan), as for a
// direct call. The channel's lines are the record's last `context.channelMessages` lines of it
// (the live turn reads them from Discord). Not reproduced: the turn planner
// (features.turnPlanner: its lookup block is not asked here), skills discovery (`{{skills}}` is
// empty), pictures, videos and read links in the classifier's transcript, and -- without `--web`
// -- the web search.
//
// `--web`: the classifier's `web:` query, when it gives one, goes to the live web lookup
// (src/web/lookup.js#createLookup `search`, on the configured web.search.engine: `brave` with
// BRAVE_SEARCH_API_KEY from .env and `exa` condensed through prompts.search-summary, `openrouter`
// through its web plugin; `--web` refuses to start when that engine cannot run), as the live turn runs it
// beside the server part, with features.webLookup switched on for this process only; its daily
// counter is a throwaway copy per question and its media cache an in-memory copy of the stored
// one (a cached search answers as it would live; nothing is written back). The result is kept per
// question (`web`: query, found, the number of sources, the text) and counted as answered by the
// web; it never counts as a hit.
//
// Answered by the chat: an expected line among the asking channel's chat lines (the record's last
// `context.channelMessages` lines below) is visible to the live voice whether a search runs or
// not; such a question is `in-chat`, not a miss, and the hits are reported with and without it.
//
// Stages: the database's words, letters and people, and -- with features.meaningSearch exactly true
// and not `--dry` -- its meaning search. `--discord`: the guild's channels and permissions over
// REST with DISCORD_TOKEN (no gateway session, GET only), so the audience rail reads them. Without
// it the guild is tools/lib/recall-eval.mjs#localGuild: every channel readable and viewable by
// everyone (the audience rail lets every channel through). `--dry`: no model or embedding
// request: no classifier (the fallback plan stands in for its answer), no meaning search.
//
// What surfaced: the stretches the search showed, in its order (the runner's `decorate` hook), the
// matched lines first -- the search's hits -- then the rest of each stretch. Cost: OpenRouter's
// upstream cost per completion, else its `cost`; embeddings are not priced.
//
// Rails: concurrency 1; `--limit N` questions; no question is asked once the summed cost has
// passed `--max-usd` (default 3); the model and embedding clients spend OPENROUTER_SIM_KEY
// (tools/lib/cli.mjs#simKey), every request `origin: 'recall-eval'`, never counted against
// llm.maxRequestsPerDay, no calibration, no prompt-cache marker; the daily counters (the
// requests, recall.maxPerDay) are throwaway copies, fresh per question. Nothing under
// data/guilds/ is written: the store is read through its read methods only and never flushed,
// the record and the archive are only iterated, the database only read.
//
// Output: the whole run to data/recall-eval/runs/<time>.json (question texts, answers and
// stretches: memory about real people, it stays on the server), a markdown summary on stdout.
// Logs carry ids and counts only.
//
// `--prefetch`: every question is also asked the way a turn of her tool loop asks it
// (features.coreTools): the automatic memory prefetch (src/behavior/prefetch.js#prefetchLanes over
// the question as the trigger and the channel's lines, then the recall runner's `prefetch`: the
// database by words and meaning -- one embedding per question unless `--dry` -- and the stored
// memory and the archive, no classifier, no summary, no Discord request), whatever
// features.coreTools says in the config. Both paths are scored the same way (the prefetch's history
// excerpts as the windows, their relevant lines as the matched ids) and reported side by side per
// question, with the not-in-memory questions the prefetch still showed an excerpt for. The final
// answer is not judged: this tool has no judge of answers, so (c) of the comparison (her reply with
// the prefetch block and her tool loop) is measured by tools/replay.mjs --loop-triggers instead.
// `--no-deadline`: the prefetch runs without its `recall.prefetch.deadlineMs` (retrieval quality
// apart from latency); without it the live deadline applies and a cut search shows in the status.
//
// `traces`: no classifier, no summary. Reads the live recall runs (data/guilds/<id>/recall-trace.jsonl,
// or the file given; read only) and, for each run with a trigger, rebuilds the trigger and the
// channel's lines before it from the record and runs the prefetch as of the trigger's moment (no
// line, row or item after it), then reports per run whether the prefetch found what the classifier's
// run kept (tools/lib/recall-eval.mjs#traceAgreement: the same lines or an overlapping window,
// partial: the same channel within a day), what it found where that run found nothing, and its top
// line. Stored memory and the archive are read as they stand now (they keep no history). Written to
// data/recall-eval/runs/<time>-traces.json, the table on stdout.
//
// `sample`: no request. Writes data/recall-eval/candidates.json: `--n` record messages
// (tools/lib/recall-eval.mjs#sampleCandidates: at least 40 characters of text, not the
// persona's own, from the last `--days` days but not the last two, spread across channels and
// days) with their three neighbours on each side, the raw material for writing questions.
// The record holds no picture captions, so a picture without text is never a candidate.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, defaultDataDir, parseFlags, privateDirOf, resolveGuildId, runCli, simKey } from './lib/cli.mjs';
import { discordReads, recallScope } from './lib/platform-objects.ts';
import {
  HIT_AT,
  latestLines,
  localGuild,
  localReads,
  localScope,
  parseQuestions,
  recordMessage,
  renderSummary,
  runQuestions,
  sampleCandidates,
  scoreQuestion,
  summarize,
  costOf,
  comparePrefetch,
  prefetchWindows,
  renderPrefetchCompare,
  renderTraceCompare,
  topExcerptLine,
  traceAgreement,
} from './lib/recall-eval.mjs';

const USAGE =
  'usage: node tools/recall-eval.mjs [<questions.json>] [--limit N] [--max-usd 3] [--dry] [--discord] [--web] [--prefetch] [--no-deadline] [--db <memory.db>] [--guild <id>] [--data <dir>] [--self-id <id>] [--self-name <name>]\n' +
  '       node tools/recall-eval.mjs traces [<recall-trace.jsonl>] [--limit N] [--dry] [--no-deadline] [--guild <id>] [--data <dir>] [--self-id <id>] [--self-name <name>]\n' +
  '       node tools/recall-eval.mjs sample [--n 80] [--days 30] [--guild <id>] [--data <dir>] [--self-id <id>] [--seed <n>]';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'recall-eval';
const DEFAULT_MAX_USD = 3;
const DEFAULT_SAMPLE = 80;
const DEFAULT_SAMPLE_DAYS = 30;
/** How far back the record is read for a channel's last lines. */
const HISTORY_DAYS = 30;
const DAY_MS = 86_400_000;
/** The requests one question may send: the classifier and the summary. */
const REQUESTS_PER_QUESTION = 2;

/** The web lookup's keys from `env`, as src/index.js passes them: Brave's and Exa's, trimmed, null when blank. */
export function webSearchKeys(env = process.env) {
  return { brave: (env.BRAVE_SEARCH_API_KEY || '').trim() || null, exa: (env.EXA_API_KEY || '').trim() || null };
}

/**
 * Whether `--web` can search: the lookup's own `hasSearch()` for the configured
 * `web.search.engine` (`brave` needs BRAVE_SEARCH_API_KEY, `exa` and `openrouter` need no key).
 * Builds the lookup only to ask; nothing is searched, read or written.
 * @param {{ hot: object, createLookup: Function, searches: object, env?: object }} input
 *   `createLookup` from src/web/lookup.js; `searches` the engine clients (`{ brave, exa }`).
 * @returns {boolean}
 */
export function webSearchReady({ hot, createLookup, searches, env = process.env }) {
  const refuse = () => {
    throw new Error('recall-eval: no search from the readiness check');
  };
  const lookup = createLookup({
    hot,
    store: { getMediaCache: refuse, markMediaCacheDirty: refuse },
    llm: { complete: async () => refuse() },
    searches,
    keys: webSearchKeys(env),
  });
  return lookup.hasSearch() === true;
}

/** A number from a flag in [min, max], `fallback` when absent; a CliError otherwise. */
function numberFlag(value, fallback, { min = 0, max = Infinity, integer = false } = {}) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new CliError(USAGE);
  return n;
}

/** A small seeded generator (mulberry32) for a reproducible sample. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The file time of a report: an ISO time with `:` and `.` replaced. */
function fileTime(ms) {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

/** `dir` resolved, refused when it is not under `dataDir/recall-eval`. */
function evalPath(dataDir, ...parts) {
  const base = path.join(dataDir, 'recall-eval');
  const file = path.join(base, ...parts);
  if (!file.startsWith(`${base}${path.sep}`))
    throw new CliError('recall-eval: the output must stay under data/recall-eval/');
  return file;
}

/**
 * The read-only sources: the memory database `dbFile` opened read only (no lock), and over it the record, the
 * archive, the vector index and the store's read methods; `memoryDb` is the recall runner's. `close()` closes it.
 */
async function openSources(dataDir, dbFile) {
  const { readOnlyMemory } = await import('./lib/memory-read.mjs');
  const { createAppendStore } = await import('../src/memory/append-store.js');
  const { createRecord } = await import('../src/memory/record.js');
  const { createArchive } = await import('../src/memory/archive.js');
  const { createVectors } = await import('../src/memory/vectors.js');
  const { createStore } = await import('../src/memory/store.js');
  if (!fs.existsSync(dbFile)) throw new CliError(`recall-eval: no database at ${dbFile}`);
  // Reads only: no writer, so nothing built here can write the database.
  const { memoryDb, close } = readOnlyMemory(dataDir, { file: dbFile });
  // Iteration only: the archive's append store never gets an append, so it never opens a file for writing.
  const record = createRecord({ dataDir, memoryDb });
  const archive = createArchive({ appendStore: createAppendStore(), dataDir, memoryDb });
  const vectors = createVectors({ dataDir, memoryDb });
  const store = createStore({ dataDir, memoryDb });
  return {
    record: { iterate: (...args) => record.iterate(...args) },
    archive: { iterate: (...args) => archive.iterate(...args) },
    vectors: { search: (...args) => vectors.search(...args) },
    store,
    memoryDb,
    close,
  };
}

/** The memory database a run reads: `--db`, else `<data>/memory.db`. */
const dbFileOf = (flags, { cwd, dataDir }) =>
  flags['--db'] ? path.resolve(cwd, flags['--db']) : path.join(dataDir, 'memory.db');

/** The stored members' first names by id. */
function namesOf(store, guildId) {
  const names = new Map();
  for (const profile of store.listUserProfiles(guildId) ?? []) {
    if (profile?.id && typeof profile.names?.[0] === 'string' && profile.names[0])
      names.set(String(profile.id), profile.names[0]);
  }
  return names;
}

/** The record's messages from `from` on (latestLines), optionally of the given channels. */
async function readRecord(record, guildId, { from, channelIds = null }) {
  const lines = [];
  for await (const line of record.iterate(guildId, {
    from: new Date(from).toISOString(),
    ...(channelIds ? { channelIds } : {}),
  }))
    lines.push(line);
  return latestLines(lines);
}

/**
 * A REST-only Discord connection (no login, no gateway): the guild, its channels, the bot's own
 * user and member. Every request but GET is refused. As tools/replay.mjs connects.
 */
async function connectDiscord({ token, guildId }) {
  const discord = await import('discord.js');
  const { Client, Routes } = discord;
  const client = new Client({ intents: [] });
  client.rest.setToken(token);
  const restRequest = client.rest.request.bind(client.rest);
  client.rest.request = (options) => {
    if (String(options?.method ?? 'GET').toUpperCase() !== 'GET')
      throw new Error('recall-eval: only GET requests reach Discord');
    return restRequest(options);
  };
  try {
    const guild = await client.guilds.fetch(guildId);
    await guild.channels.fetch();
    const me = await client.rest.get(Routes.user());
    try {
      client.user = new discord.ClientUser(client, me);
    } catch {
      // Only guild.members.me needs it.
    }
    let member = null;
    try {
      member = await guild.members.fetch(me.id);
    } catch {
      member = null;
    }
    return { client, guild, self: { id: String(me.id), name: member?.displayName ?? me.username ?? null } };
  } catch (err) {
    await client.destroy().catch(() => {});
    throw err;
  }
}

/** The `sample` subcommand. */
async function sample(flags, { dataDir, guildId, now, cwd }) {
  const n = numberFlag(flags['--n'], DEFAULT_SAMPLE, { min: 1, max: 1000, integer: true });
  const days = numberFlag(flags['--days'], DEFAULT_SAMPLE_DAYS, { min: 3, max: 366, integer: true });
  const seed = numberFlag(flags['--seed'], now() % 2147483647, { min: 0, integer: true });
  const sources = await openSources(dataDir, dbFileOf(flags, { cwd, dataDir }));
  const { record, store } = sources;
  const names = namesOf(store, guildId);
  // One extra day back, so the oldest candidates have their neighbours too.
  let lines;
  try {
    lines = await readRecord(record, guildId, { from: now() - (days + 1) * DAY_MS });
  } finally {
    sources.close();
  }
  const candidates = sampleCandidates(lines, {
    n,
    days,
    now: now(),
    rng: seeded(seed),
    selfId: flags['--self-id'] ?? null,
    nameOf: (id) => names.get(id) ?? null,
  });
  const file = evalPath(dataDir, 'candidates.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ at: new Date(now()).toISOString(), guildId, days, seed, candidates }, null, 2)}\n`
  );
  const channels = new Set(candidates.map((c) => c.channelId)).size;
  const dayCount = new Set(candidates.map((c) => c.occurredAt.slice(0, 10))).size;
  return `recall-eval: ${candidates.length} candidate(s) from ${lines.length} record message(s), ${channels} channel(s), ${dayCount} day(s), seed ${seed}\n${file}\n`;
}

/**
 * The reads and the scope (`channel` and `snapshot`) a recall run is handed for `channel` of `guild`: the local guild's
 * own, or Discord's over REST.
 */
async function recallParts(guild, channel, guildId, config) {
  if (guild.local === true) {
    const channelNameOf = (id) => guild.channels.cache.get(id)?.name ?? null;
    return {
      reads: localReads({ guildId, channelNameOf }),
      scope: localScope({ guildId, channelId: String(channel.id), channelNameOf }),
    };
  }
  const { reads } = discordReads(guild.client, config);
  return { reads, scope: await recallScope(reads, channel, String(guildId)) };
}

/** `config` with the prefetch's deadline lifted (`--no-deadline`): a copy, the live config untouched. */
function withoutDeadline(config, lifted) {
  if (!lifted) return config;
  return {
    ...config,
    recall: { ...(config.recall ?? {}), prefetch: { ...(config.recall?.prefetch ?? {}), deadlineMs: 600000 } },
  };
}

/** The lines of a recall-trace.jsonl file that parse as objects, in order. */
function traceLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new CliError(`recall-eval: cannot read the trace file ${file} (${err?.code ?? err?.name ?? 'Error'})`);
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object') out.push(value);
    } catch {
      // A torn line is skipped.
    }
  }
  return out;
}

/** The `traces` subcommand (see the header). */
async function traces(flags, { dataDir, guildId, now, cwd }) {
  const dry = flags['--dry'] === true;
  const noDeadline = flags['--no-deadline'] === true;
  const file = flags._[1] ? path.resolve(cwd, flags._[1]) : path.join(dataDir, 'guilds', guildId, 'recall-trace.jsonl');
  const all = traceLines(file).filter(
    (t) => typeof t.triggerId === 'string' && t.triggerId && typeof t.channelId === 'string'
  );
  const limit = numberFlag(flags['--limit'], all.length, { min: 1, integer: true });
  const runs = all.slice(-limit);
  const { createHot } = await import('../src/hot.js');
  const { loadDotEnv } = await import('../src/config.js');
  const { createRecall } = await import('../src/behavior/recall-run.js');
  const { recallSettings } = await import('../src/behavior/recall.js');
  const { prefetchLanes } = await import('../src/behavior/prefetch.js');
  const hot = createHot({ rootDir: ROOT, privateDir: privateDirOf(ROOT) });
  let sources = null;
  try {
    const evalHot = {
      get config() {
        return withoutDeadline(hot.config, noDeadline);
      },
      get prompts() {
        return hot.prompts;
      },
    };
    const config = hot.config;
    const settings = recallSettings(config);
    if (!settings) throw new CliError('recall-eval: features.recall is off: there is no recall to measure');
    const meaningOn = !dry && config.features?.meaningSearch === true;
    process.stderr.write(
      `recall-eval: ${runs.length} live recall run(s)${meaningOn ? `, up to ${runs.length} embedding(s) on the simulator key` : ', no request'}\n`
    );
    let embed = null;
    if (meaningOn) {
      loadDotEnv(privateDirOf(ROOT));
      const { createEmbedder } = await import('../src/llm/embed.js');
      const embedder = createEmbedder({ apiKey: simKey(ORIGIN), env: {}, state: { data: {}, markDirty() {} } });
      embed = (texts, options = {}) =>
        embedder.embed(texts, { ...options, origin: ORIGIN, countAgainstDailyCap: false });
    }
    sources = await openSources(dataDir, dbFileOf(flags, { cwd, dataDir }));
    const { record, archive, vectors, store, memoryDb } = sources;
    const names = namesOf(store, guildId);
    const nameOf = (id) => names.get(String(id)) ?? null;
    const channelNames = new Map(
      (store.listChannels?.(guildId) ?? []).filter((c) => c?.id).map((c) => [String(c.id), c.name || null])
    );
    const self = { id: flags['--self-id'] ?? null, name: flags['--self-name'] ?? null };
    const guild = localGuild({ guildId, selfId: self.id, channelNameOf: (id) => channelNames.get(id) ?? null });
    const selfName = self.name ?? config.bot?.nameTriggers?.[0] ?? 'bot';
    const historyCount = Math.max(1, Math.floor(config.context?.channelMessages ?? 100));
    const llm = {
      capLeft: () => Infinity,
      complete: async () => {
        throw new Error('recall-eval: no model request in traces');
      },
    };
    const rows = [];
    for (const t of runs) {
      const base = {
        at: t.at ?? null,
        triggerId: t.triggerId,
        channelId: t.channelId,
        forms: [...(t.forms ?? []), ...(t.who ?? [])],
        answer: t.summary?.answer ?? null,
        skipped: t.skipped ?? null,
      };
      const atMs = Date.parse(t.at);
      try {
        if (!Number.isFinite(atMs)) throw Object.assign(new Error('no time'), { name: 'no-time' });
        const lines = [];
        const query = {
          from: new Date(atMs - HISTORY_DAYS * DAY_MS).toISOString(),
          to: new Date(atMs + 60 * 60 * 1000).toISOString(),
          channelIds: [t.channelId],
        };
        for await (const line of record.iterate(guildId, query)) lines.push(line);
        const messages = latestLines(lines).map((line) => recordMessage(line, { nameOf, selfName }));
        const at = messages.findIndex((m) => m.id === t.triggerId);
        if (at === -1) throw Object.assign(new Error('no trigger'), { name: 'no-trigger-in-record' });
        const trigger = messages[at];
        const history = messages.slice(Math.max(0, at + 1 - historyCount), at + 1);
        const channel = guild.channels.cache.get(t.channelId);
        const { lanes, skip } = prefetchLanes({
          trigger,
          history,
          settings: settings.prefetch,
          selfId: self.id,
          selfName,
          selfNames: config.bot?.nameTriggers ?? [],
          nameOf,
        });
        if (skip) {
          rows.push({
            ...base,
            trigger: trigger.content,
            status: `skipped:${skip}`,
            excerpts: 0,
            agreement: traceAgreement(t, []),
            top: '',
          });
          continue;
        }
        const parts = await recallParts(guild, channel, guildId, () => hot.config);
        const recall = createRecall({
          hot: evalHot,
          store: {
            state: { data: {}, markDirty() {} },
            listUserProfiles: (id) => store.listUserProfiles(id),
            getLore: (id) => store.getLore(id),
            getGuild: (id) => store.getGuild(id),
            getRecent: (id) => store.getRecent(id),
          },
          llm,
          reads: parts.reads,
          archive,
          record,
          vectors,
          embed,
          memoryDb,
          now,
        });
        const found = await recall.prefetch({
          guildId,
          ...parts.scope,
          selfId: self.id,
          selfName,
          history,
          lanes,
          at: trigger.ts,
        });
        const row = {
          ...base,
          trigger: trigger.content,
          status: found?.status ?? 'none-ran',
          partial: found?.partial === true,
          basis: found?.basis ?? [],
          excerpts: found?.excerpts?.length ?? 0,
          agreement: traceAgreement(t, found?.excerpts ?? []),
          top: topExcerptLine(found),
          found: found?.excerpts ?? [],
          ms: found?.ms ?? null,
          stages: found?.stats?.stages ?? null,
        };
        rows.push(row);
        process.stderr.write(
          `recall-eval: ${t.triggerId} classifier ${base.answer ?? '-'} prefetch ${row.status} (${row.excerpts}) ${row.agreement} ${row.ms} ms\n`
        );
      } catch (err) {
        rows.push({ ...base, error: err?.name ?? 'Error' });
      }
    }
    const reportPath = evalPath(dataDir, 'runs', `${fileTime(now())}-traces.json`);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(
      reportPath,
      `${JSON.stringify({ at: new Date(now()).toISOString(), guildId, traceFile: file, mode: { dry, noDeadline }, settings: settings.prefetch, rows }, null, 2)}\n`
    );
    return renderTraceCompare(rows, { reportPath });
  } finally {
    sources?.close();
    hot.close?.();
  }
}

/**
 * The whole tool: the markdown summary on stdout (or the `sample` line).
 * @param {string[]} argv
 * @param {{ cwd?: string, now?: () => number }} [options]
 * @returns {Promise<string>}
 */
export async function main(argv, { cwd = process.cwd(), now = Date.now } = {}) {
  const flags = parseFlags(argv, {
    values: [
      '--limit',
      '--max-usd',
      '--guild',
      '--data',
      '--self-id',
      '--self-name',
      '--n',
      '--days',
      '--seed',
      '--db',
    ],
    switches: ['--dry', '--discord', '--web', '--prefetch', '--no-deadline'],
    usage: USAGE,
  });
  const dataDir = flags['--data'] ? path.resolve(cwd, flags['--data']) : defaultDataDir(ROOT);
  if (!fs.existsSync(path.join(dataDir, 'guilds'))) throw new CliError(`recall-eval: no guilds/ under ${dataDir}`);
  const guildId = resolveGuildId(dataDir, flags['--guild']);
  if (flags._[0] === 'sample') return sample(flags, { dataDir, guildId, now, cwd });
  if (flags._.length > 2 || (flags._.length === 2 && flags._[0] !== 'traces')) throw new CliError(USAGE);
  if (flags._[0] === 'traces') return traces(flags, { dataDir, guildId, now, cwd });

  const questionsFile = flags._[0] ? path.resolve(cwd, flags._[0]) : evalPath(dataDir, 'questions.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(questionsFile, 'utf8'));
  } catch (err) {
    throw new CliError(`recall-eval: cannot read the questions file ${questionsFile} (${err?.name ?? 'Error'})`);
  }
  const { questions, errors } = parseQuestions(raw);
  if (errors.length > 0)
    throw new CliError(
      `recall-eval: the questions file has ${errors.length} problem(s):\n${errors.slice(0, 20).join('\n')}`
    );
  const limit = numberFlag(flags['--limit'], questions.length, { min: 1, integer: true });
  const maxUsd = numberFlag(flags['--max-usd'], DEFAULT_MAX_USD);
  const dry = flags['--dry'] === true;
  const useDiscord = flags['--discord'] === true;
  const useWeb = flags['--web'] === true;
  const usePrefetch = flags['--prefetch'] === true;
  const noDeadline = flags['--no-deadline'] === true;
  if (useWeb && dry) throw new CliError(`recall-eval: --web needs the classifier, which --dry leaves out\n${USAGE}`);
  const dbFile = dbFileOf(flags, { cwd, dataDir });
  if (!fs.existsSync(dbFile)) throw new CliError(`recall-eval: no database at ${dbFile}`);

  const { createHot } = await import('../src/hot.js');
  const { loadDotEnv } = await import('../src/config.js');
  const { createRecall } = await import('../src/behavior/recall-run.js');
  const { recallSettings, parseLookupAnswer } = await import('../src/behavior/recall.js');
  const { fallbackLookupPlan } = await import('../src/behavior/turn.js');
  const { prefetchLanes } = await import('../src/behavior/prefetch.js');
  const { classifierTranscript, fillPromptTemplate } = await import('../src/behavior/prompt.js');
  const { createLlm, helperRequestOptions, railReason } = await import('../src/llm/openrouter.js');
  const { createEmbedder } = await import('../src/llm/embed.js');
  const { createCalibrator } = await import('../src/llm/tokens.js');
  const { roleModel } = await import('../src/llm/roles.js');
  const { zonedDay } = await import('../src/time.js');

  const hot = createHot({ rootDir: ROOT, privateDir: privateDirOf(ROOT) });
  // The recall's own trace switched on for this process only: its lines are caught in memory below.
  const evalHot = {
    get config() {
      const live = hot.config;
      return withoutDeadline(
        {
          ...live,
          features: { ...(live.features ?? {}), recallTrace: true, ...(useWeb ? { webLookup: true } : {}) },
        },
        noDeadline
      );
    },
    get prompts() {
      return hot.prompts;
    },
  };
  const config = hot.config;
  const settings = recallSettings(config);
  if (!settings) throw new CliError('recall-eval: features.recall is off: there is no recall to measure');
  if (!dry && !hot.prompts?.lookup) throw new CliError('recall-eval: prompts.lookup is missing');
  if (useWeb && !hot.prompts?.['search-summary']) throw new CliError('recall-eval: --web needs prompts.search-summary');
  const meaningOn = !dry && config.features?.meaningSearch === true;
  const stages = {
    classifier: !dry,
    database: true,
    meaning: meaningOn,
    discord: useDiscord,
    web: useWeb,
  };
  const asking = Math.min(limit, questions.length);
  process.stderr.write(
    `recall-eval: ${asking} question(s); ${dry ? 'dry: no model request' : `up to ${asking * (REQUESTS_PER_QUESTION + (useWeb ? 1 : 0))} model request(s)${useWeb ? ` and ${asking} web search(es)` : ''}${meaningOn ? ` and ${asking} embedding(s)` : ''}, none asked once the cost passes ${maxUsd} USD`}\n`
  );

  // The keys (OPENROUTER_SIM_KEY, DISCORD_TOKEN, the search engine's) only when something is sent.
  if (!dry || useDiscord) loadDotEnv(privateDirOf(ROOT));
  let webParts = null;
  if (useWeb) {
    const { createLookup } = await import('../src/web/lookup.js');
    const { createBraveSearch } = await import('../src/web/brave.js');
    const { createExaSearch } = await import('../src/web/exa.js');
    webParts = { createLookup, searches: { brave: createBraveSearch(), exa: createExaSearch() } };
    if (!webSearchReady({ hot: evalHot, ...webParts })) {
      throw new CliError(
        'recall-eval: --web needs a web search that can run (web.search.engine brave needs BRAVE_SEARCH_API_KEY in .env)'
      );
    }
  }
  const sources = await openSources(dataDir, dbFile);
  const { record, archive, vectors, store, memoryDb } = sources;
  const names = namesOf(store, guildId);
  const nameOf = (id) => names.get(String(id)) ?? null;

  // The model clients on throwaway counters; per-role keys are not looked up (env {}): the simulator key pays.
  const counters = { data: {}, markDirty() {} };
  let usage = null;
  let llm;
  let embed = null;
  if (dry) {
    llm = {
      capLeft: () => Infinity,
      complete: async () => {
        throw Object.assign(new Error('recall-eval: dry run, no model request'), { name: 'DryRun' });
      },
    };
  } else {
    const apiKey = simKey(ORIGIN);
    const calibrator = createCalibrator(store.state.data?.calibration);
    const realLlm = createLlm({ apiKey, env: {}, getConfig: () => hot.config, calibrator, state: counters });
    llm = {
      capLeft: () => Infinity,
      async complete(messages, options = {}) {
        const completion = await realLlm.complete(messages, {
          ...options,
          origin: ORIGIN,
          countAgainstDailyCap: false,
          skipCalibration: true,
          cache: false,
        });
        if (usage) {
          usage.requests += 1;
          usage.promptTokens += Number(completion?.usage?.prompt_tokens) || 0;
          usage.completionTokens += Number(completion?.usage?.completion_tokens) || 0;
          usage.costUsd += costOf(completion?.usage);
        }
        return completion;
      },
    };
    if (meaningOn) {
      const embedder = createEmbedder({ apiKey, env: {}, state: counters });
      embed = async (texts, options = {}) => {
        if (usage) usage.embeddings += 1;
        return embedder.embed(texts, { ...options, origin: ORIGIN, countAgainstDailyCap: false });
      };
    }
  }

  // The web lookup (--web): the live module over an in-memory copy of the media cache, a fresh
  // daily counter per question (webSearch), nothing written back.
  let webSearch = null;
  if (useWeb) {
    const { createLookup, searches } = webParts;
    const { createPageFetcher } = await import('../src/web/fetch-page.js');
    const media = { ...(store.getMediaCache(guildId) ?? {}) };
    const webStore = { getMediaCache: () => media, markMediaCacheDirty() {} };
    const pageFetcher = createPageFetcher();
    const keys = webSearchKeys(process.env);
    webSearch = (query) =>
      createLookup({
        hot: evalHot,
        store: webStore,
        llm,
        state: { data: {}, markDirty() {} },
        pageFetcher,
        searches,
        keys,
        now,
      }).search(guildId, query);
  }

  // The guild: Discord over REST, or the local one.
  let connection = null;
  let guild;
  let self = { id: flags['--self-id'] ?? null, name: flags['--self-name'] ?? null };
  if (useDiscord) {
    const token = process.env.DISCORD_TOKEN;
    if (!token) throw new CliError('recall-eval: --discord needs DISCORD_TOKEN (.env)');
    connection = await connectDiscord({ token, guildId });
    guild = connection.guild;
    self = { id: self.id ?? connection.self.id, name: self.name ?? connection.self.name };
  } else {
    const channelNames = new Map(
      (store.listChannels?.(guildId) ?? []).filter((c) => c?.id).map((c) => [String(c.id), c.name || null])
    );
    guild = localGuild({ guildId, selfId: self.id, channelNameOf: (id) => channelNames.get(id) ?? null });
  }
  const selfName = self.name ?? config.bot?.nameTriggers?.[0] ?? 'bot';
  const historyCount = Math.max(1, Math.floor(config.context?.channelMessages ?? 100));
  const historyOf = new Map();

  /** The channel's last lines from the record, as the turn's chat. */
  async function channelHistory(channelId) {
    if (!historyOf.has(channelId)) {
      const lines = await readRecord(record, guildId, { from: now() - HISTORY_DAYS * DAY_MS, channelIds: [channelId] });
      historyOf.set(
        channelId,
        lines.slice(-historyCount).map((line) => recordMessage(line, { nameOf, selfName }))
      );
    }
    return historyOf.get(channelId);
  }

  /** The search classifier's server part for `trigger`, as maybeLookup asks it; `fallback` on a failed or empty answer. */
  async function classify(trigger, history) {
    const searchCfg = hot.config.web?.search ?? {};
    const contextMessages = Math.max(0, Math.floor(searchCfg.contextMessages ?? 50));
    const context = contextMessages > 0 ? history.filter((m) => m.id !== trigger.id).slice(-contextMessages) : [];
    const triggerText = [...String(trigger.content ?? '')]
      .slice(0, hot.config.context?.maxMessageChars ?? 2000)
      .join('');
    const transcript =
      context.length === 0
        ? ''
        : `<transcript>\n${classifierTranscript(context, { config: hot.config, selfName, labels: hot.prompts.labels })}\n</transcript>\n`;
    // A dry run has no classifier: the fallback plan always stands in for its answer.
    const fallback = (reason) => {
      if (!dry && !settings.fallbackOnClassifierFailure) return { server: null, how: 'failed', reason };
      const plan = fallbackLookupPlan({
        text: triggerText,
        profiles: store.listUserProfiles(guildId) ?? [],
        selfId: self.id,
        selfName,
        maxForms: settings.maxForms,
      });
      return { server: plan, how: 'fallback', reason };
    };
    if (dry) return fallback('dry');
    let completion;
    try {
      completion = await llm.complete(
        [
          {
            role: 'system',
            content: fillPromptTemplate(hot.prompts.lookup, {
              today: zonedDay(now(), hot.config.bot?.timezone),
              name: selfName,
              skills: '',
            }),
          },
          { role: 'user', content: `${transcript}<candidate>\n${trigger.authorName}: ${triggerText}\n</candidate>` },
        ],
        {
          model: roleModel(hot.config, 'analyzer', 'lookup'),
          ...helperRequestOptions(hot.config, {
            role: 'analyzer',
            maxOutputTokens: searchCfg.classifierMaxOutputTokens ?? 2000,
            purpose: 'lookup',
          }),
        }
      );
    } catch (err) {
      return fallback(railReason(err, 'classifier-failed'));
    }
    if (!String(completion?.text ?? '').trim()) return fallback('empty');
    const parsed = parseLookupAnswer(completion.text, {
      timezone: hot.config.bot?.timezone,
      now: now(),
      maxForms: settings.maxForms,
    });
    return {
      server: parsed.server ?? null,
      web: parsed.web ?? null,
      how: 'classifier',
      reason: parsed.reason ?? null,
      raw: completion.text,
    };
  }

  /** The trigger a question is asked as: a new message of `askerId` in its channel, now. */
  const triggerOf = (q, index) => ({
    id: `recall-eval-${index + 1}`,
    channelId: q.channelId,
    authorId: q.askerId,
    authorName: nameOf(q.askerId) ?? '-',
    content: q.question,
    ts: now(),
    self: false,
    bot: false,
    replyToId: null,
    mentionedUserIds: [],
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    forwarded: [],
    reactions: [],
  });

  /** The question asked the way a turn of her tool loop asks it: the automatic memory prefetch, scored. */
  async function askPrefetch(q, index) {
    const started = now();
    try {
      const channel = guild.channels.cache.get(q.channelId);
      if (!channel) return { status: 'error', error: 'no-channel', excerpts: 0, score: null, ms: 0 };
      const trigger = triggerOf(q, index);
      const chat = await channelHistory(q.channelId);
      const history = [...chat, trigger];
      const { lanes, skip } = prefetchLanes({
        trigger,
        history,
        settings: settings.prefetch,
        selfId: self.id,
        selfName,
        selfNames: config.bot?.nameTriggers ?? [],
        nameOf,
      });
      if (skip)
        return {
          status: `skipped:${skip}`,
          excerpts: 0,
          score: scoreQuestion(q, { chatIds: chat.map((m) => m.id) }),
          ms: now() - started,
        };
      const parts = await recallParts(guild, channel, guildId, () => hot.config);
      const recall = createRecall({
        hot: evalHot,
        store: readStore(),
        llm,
        reads: parts.reads,
        archive,
        record,
        vectors,
        embed,
        memoryDb,
        now,
      });
      const found = await recall.prefetch({ guildId, ...parts.scope, selfId: self.id, selfName, history, lanes });
      const { windows, matched } = prefetchWindows(found);
      return {
        status: found?.status ?? 'none-ran',
        partial: found?.partial === true,
        basis: found?.basis ?? [],
        excerpts: found?.excerpts?.length ?? 0,
        score: scoreQuestion(q, { windows, matched, confident: false, chatIds: chat.map((m) => m.id) }),
        found: found?.excerpts ?? [],
        stats: found?.stats ?? null,
        ms: now() - started,
      };
    } catch (err) {
      return { status: 'error', error: err?.name ?? 'Error', excerpts: 0, score: null, ms: now() - started };
    }
  }

  /** One question asked and scored; with `--prefetch` also through the automatic prefetch. */
  async function ask(q, index) {
    const result = await askClassifier(q, index);
    if (!usePrefetch) return result;
    return { ...result, prefetch: await askPrefetch(q, index) };
  }

  /** The store's read methods for one run: a fresh daily recall counter, no trace written. */
  function readStore(onTrace = null) {
    return {
      state: { data: {}, markDirty() {} },
      listUserProfiles: (id) => store.listUserProfiles(id),
      getLore: (id) => store.getLore(id),
      getGuild: (id) => store.getGuild(id),
      getRecent: (id) => store.getRecent(id),
      appendRecallTrace: (id, line) => onTrace?.(line),
    };
  }

  /** One question asked through the classifier path and scored. */
  async function askClassifier(q, index) {
    const started = now();
    usage = { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, embeddings: 0 };
    const base = {
      id: q.id,
      kind: q.kind,
      channelId: q.channelId,
      question: q.question,
      expected: q.expected,
      ...(q.note ? { note: q.note } : {}),
    };
    const finish = (extra) => {
      const out = { ...base, ...extra, latencyMs: now() - started, usage: { ...usage }, costUsd: usage.costUsd };
      usage = null;
      return out;
    };
    try {
      const channel = guild.channels.cache.get(q.channelId);
      if (!channel) return finish({ error: 'no-channel', score: null });
      const trigger = triggerOf(q, index);
      const chat = await channelHistory(q.channelId);
      // The asking channel's visible chat: an expected line in it is answered by the chat.
      const chatIds = chat.map((m) => m.id);
      const history = [...chat, trigger];
      const classified = await classify(trigger, history);
      const lookup = {
        how: classified.how,
        reason: classified.reason ?? null,
        raw: classified.raw ?? null,
        server: classified.server ?? null,
        web: classified.web ?? null,
      };
      // The web part runs beside the server part, as the live turn runs both.
      const webRun =
        webSearch && classified.web
          ? webSearch(classified.web).then(
              (result) => ({
                query: result?.query ?? classified.web,
                found: Boolean(result?.text),
                sources: Array.isArray(result?.sources) ? result.sources.length : 0,
                text: result?.text ?? null,
              }),
              (err) => ({ query: classified.web, found: false, sources: 0, text: null, error: err?.name ?? 'Error' })
            )
          : null;
      if (!classified.server) {
        const web = webRun ? await webRun : null;
        return finish({
          lookup,
          ran: false,
          score: scoreQuestion(q, { chatIds }),
          confident: false,
          answer: null,
          ...(web ? { web } : {}),
        });
      }
      // A fresh store view per question: the daily recall counter starts at zero, the trace is caught here.
      let trace = null;
      const recallStore = readStore((line) => {
        trace = line;
      });
      const parts = await recallParts(guild, channel, guildId, () => hot.config);
      const recall = createRecall({
        hot: evalHot,
        store: recallStore,
        llm,
        reads: parts.reads,
        archive,
        record,
        vectors,
        embed,
        memoryDb,
        now,
      });
      const windows = [];
      const found = await recall.run({
        guildId,
        ...parts.scope,
        selfId: self.id,
        selfName,
        history,
        candidate: trigger,
        server: classified.server,
        quotes: true,
        decorate: (messages) => {
          windows.push(messages);
          return messages;
        },
      });
      const matched = new Set(found?.hitIds ?? []);
      const confident = typeof found?.text === 'string' && found.text.length > 0;
      const web = webRun ? await webRun : null;
      return finish({
        lookup,
        ran: true,
        ...(web ? { web } : {}),
        skipped: trace?.skipped ?? null,
        score: scoreQuestion(q, { windows, matched, confident, chatIds }),
        confident,
        answer: found?.text ?? null,
        summary: found?.stats?.summary ?? null,
        stretch: found?.stretch ?? null,
        windows: windows.map((w) =>
          w.map((m) => ({
            id: m.id,
            channelId: m.channelId ?? null,
            authorId: m.authorId ?? null,
            ts: m.ts ?? null,
            self: m.self === true,
            text: m.content ?? '',
          }))
        ),
        memory: trace?.memory ?? [],
        stats: found?.stats ?? null,
      });
    } catch (err) {
      return finish({ error: err?.name ?? 'Error', score: null });
    }
  }

  let outcome;
  try {
    let index = 0;
    outcome = await runQuestions(questions, {
      limit,
      maxUsd,
      ask: (q) => ask(q, index++),
      onResult: (r) =>
        process.stderr.write(
          `recall-eval: ${r.id} ${r.error ? `error ${r.error}` : `${r.score?.outcome ?? r.kind} rank ${r.score?.rank ?? '-'} hit@${HIT_AT} ${r.score?.hit5 ?? '-'} confident ${r.confident === true}${r.web ? ` web ${r.web.found}` : ''}`}${r.prefetch ? ` prefetch ${r.prefetch.status} rank ${r.prefetch.score?.rank ?? '-'}` : ''} ${r.latencyMs} ms ${r.costUsd.toFixed(4)} USD\n`
        ),
    });
  } finally {
    if (connection) await connection.client.destroy().catch(() => {});
    sources.close();
    hot.close?.();
  }

  const summary = summarize(outcome.results);
  const reportPath = evalPath(dataDir, 'runs', `${fileTime(now())}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const report = {
    at: new Date(now()).toISOString(),
    guildId,
    questionsFile,
    mode: { dry, discord: useDiscord, web: useWeb, prefetch: usePrefetch, noDeadline },
    stages,
    settings: {
      recall: settings,
      meaningSearch: config.features?.meaningSearch === true,
      channelMessages: historyCount,
    },
    stopped: outcome.stopped,
    skipped: outcome.skipped,
    summary,
    ...(usePrefetch ? { prefetch: comparePrefetch(outcome.results) } : {}),
    results: outcome.results,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const text = renderSummary(summary, { reportPath, stages, stopped: outcome.stopped, skipped: outcome.skipped });
  return usePrefetch ? `${text}\n${renderPrefetchCompare(report.prefetch, outcome.results, { reportPath })}` : text;
}

runCli(import.meta.url, main);
