#!/usr/bin/env node
// Operations tool: measure recall against questions whose answers are known. Exists so a change
// to the server search (src/behavior/recall-run.ts) can be judged by numbers -- hit@1, hit@5,
// confident answers to questions memory cannot answer, latency, cost -- instead of by a few
// live turns.
//
//   cd /opt/neptunia/app && node scripts/recall-eval.ts [<questions.json>] [--limit N] [--max-usd 3]
//        [--dry] [--discord] [--web] [--guild <id>] [--data <dir>] [--db <memory.db>] [--self-id <id>] [--self-name <name>]
//   cd /opt/neptunia/app && node scripts/recall-eval.ts sample [--n 80] [--days 30]
//        [--guild <id>] [--data <dir>] [--db <memory.db>] [--self-id <id>] [--seed <n>]
//   cd /opt/neptunia/app && node scripts/recall-eval.ts [<questions.json>] --prefetch [--no-deadline] [the flags above]
//   cd /opt/neptunia/app && node scripts/recall-eval.ts traces [<recall-trace.jsonl>] [--limit N] [--dry] [--no-deadline]
//        [--guild <id>] [--data <dir>] [--db <memory.db>] [--self-id <id>] [--self-name <name>]
//
// The memory is the memory database (`--db`, default `<data>/memory.db`), opened read only with no lock: it must be a
// copy or a quiet file. Nothing is written to it.
//
// The questions file (default data/recall-eval/questions.json): `[{ id, placeId, askerId,
// question, expected: [messageId...], kind: 'exact'|'fuzzy'|'none', note? }]`, checked by
// scripts/lib/recall-eval.ts#parseQuestions; `none` means the answer is not in memory.
//
// Each question is asked as a live turn asks it (src/behavior/turn.ts#maybeLookup): the search
// classifier (prompts['query-builder'], purpose `query-builder`) reads the channel's last lines and the question
// as a new message of `askerId` in `placeId`, now; its server part goes to the real recall
// runner (src/behavior/recall-run.ts#createRecall `run`) as the persona's own memory.search does
// (`quotes`: the stretches of src/memory/db/recall.ts, no summary request, so no `confident`
// answer), wired as src/index.ts wires it: the memory database read only, the stored memory, the
// archive and the embedding client. A failed or empty classifier answer takes the live fallback
// (recall.fallbackOnClassifierFailure: the question's own words, fallbackLookupPlan), as for a
// direct call. The channel's lines are the record's last `context.channelMessages` lines of it
// (the live turn reads them from Discord). Not reproduced: the turn planner
// (features.turnPlanner: its lookup block is not asked here), skills discovery (`{{skills}}` is
// empty), pictures, videos and read links in the classifier's transcript, and -- without `--web`
// -- the web search.
//
// `--web`: the classifier's `web:` query, when it gives one, goes to the live web lookup
// (src/web/lookup.ts#createLookup `search`, on the configured web.search.engine: `brave` with
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
// it the guild is scripts/lib/recall-eval.ts#localGuild: every channel readable and viewable by
// everyone (the audience rail lets every channel through). `--dry`: no model or embedding
// request: no classifier (the fallback plan stands in for its answer), no meaning search.
//
// What surfaced: the stretches the search showed, in its order (the runner's `decorate` hook), the
// matched lines first -- the search's hits -- then the rest of each stretch. Cost: OpenRouter's
// upstream cost per completion, else its `cost`; embeddings are not priced.
//
// Rails: concurrency 1; `--limit N` questions; no question is asked once the summed cost has
// passed `--max-usd` (default 3); the model and embedding clients spend the simulation key
// (scripts/lib/cli.ts#simKey), every request `origin: 'recall-eval'`, never counted against
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
// (features.coreTools): the automatic memory prefetch (src/behavior/prefetch.ts#prefetchLanes over
// the question as the trigger and the channel's lines, then the recall runner's `prefetch`: the
// database by words and meaning -- one embedding per question unless `--dry` -- and the stored
// memory and the archive, no classifier, no summary, no Discord request), whatever
// features.coreTools says in the config. Both paths are scored the same way (the prefetch's history
// excerpts as the windows, their relevant lines as the matched ids) and reported side by side per
// question, with the not-in-memory questions the prefetch still showed an excerpt for. The final
// answer is not judged: this tool has no judge of answers, so (c) of the comparison (her reply with
// the prefetch block and her tool loop) is measured by scripts/replay.ts --loop-triggers instead.
// `--no-deadline`: the prefetch runs without its `recall.prefetch.deadlineMs` (retrieval quality
// apart from latency); without it the live deadline applies and a cut search shows in the status.
//
// `traces`: no classifier, no summary. Reads the live recall runs (data/guilds/<id>/recall-trace.jsonl,
// or the file given; read only) and, for each run with a trigger, rebuilds the trigger and the
// channel's lines before it from the record and runs the prefetch as of the trigger's moment (no
// line, row or item after it), then reports per run whether the prefetch found what the classifier's
// run kept (scripts/lib/recall-eval.ts#traceAgreement: the same lines or an overlapping window,
// partial: the same channel within a day), what it found where that run found nothing, and its top
// line. Stored memory and the archive are read as they stand now (they keep no history). Written to
// data/recall-eval/runs/<time>-traces.json, the table on stdout.
//
// `sample`: no request. Writes data/recall-eval/candidates.json: `--n` record messages
// (scripts/lib/recall-eval.ts#sampleCandidates: at least 40 characters of text, not the
// persona's own, from the last `--days` days but not the last two, spread across channels and
// days) with their three neighbours on each side, the raw material for writing questions.
// The record holds no picture captions, so a picture without text is never a candidate.

import { placeOfCommunity } from '../src/memory/addresses.ts';
import { cardAliases } from '../src/behavior/mention.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { interfaceCredential } from '../src/config/files.ts';
import type { Flags } from './lib/cli.ts';
import {
  serviceKeys,
  CliError,
  defaultDataDir,
  parseFlags,
  privateDirOf,
  resolveGuildId,
  runCli,
  simKey,
} from './lib/cli.ts';
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
} from './lib/recall-eval.ts';
import type { Question } from './lib/recall-eval.ts';
import { MAX_MESSAGE_CHARS } from '../src/format.ts';
import type { Untyped } from '../src/tools/types.ts';
import type { Reads } from '../src/interface/reads.ts';

/** An object read by key whose values are not typed yet. */
type Rec = Record<string, Untyped>;

const USAGE =
  'usage: node scripts/recall-eval.ts [<questions.json>] [--limit N] [--max-usd 3] [--dry] [--discord] [--web] [--prefetch] [--no-deadline] [--db <memory.db>] [--guild <id>] [--data <dir>] [--self-id <id>] [--self-name <name>]\n' +
  '       node scripts/recall-eval.ts traces [<recall-trace.jsonl>] [--limit N] [--dry] [--no-deadline] [--guild <id>] [--data <dir>] [--self-id <id>] [--self-name <name>]\n' +
  '       node scripts/recall-eval.ts sample [--n 80] [--days 30] [--guild <id>] [--data <dir>] [--self-id <id>] [--seed <n>]';
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

/** The web lookup's keys from `env`, as src/index.ts passes them: Brave's and Exa's, trimmed, null when blank. */
export function webSearchKeys(env = process.env): { brave: string | null; exa: string | null } {
  const keys = serviceKeys({ env });
  return { brave: keys.brave, exa: keys.exa };
}

/**
 * Whether `--web` can search: the lookup's own `hasSearch()` for the configured
 * `web.search.engine` (`brave` needs BRAVE_SEARCH_API_KEY, `exa` and `openrouter` need no key).
 * Builds the lookup only to ask; nothing is searched, read or written.
 * @param input `createLookup` from src/web/lookup.ts; `searches` the engine clients (`{ brave, exa }`).
 */
export function webSearchReady({
  hot,
  createLookup,
  searches,
  env = process.env,
}: {
  hot: Rec;
  createLookup: (...args: Array<Untyped>) => Untyped;
  searches: Rec;
  env?: Rec;
}): boolean {
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
function numberFlag(value: Untyped, fallback: Untyped, { min = 0, max = Infinity, integer = false }: Rec = {}) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new CliError(USAGE);
  return n;
}

/** A small seeded generator (mulberry32) for a reproducible sample. */
function seeded(seed: Untyped) {
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
function fileTime(ms: Untyped) {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

/** `dir` resolved, refused when it is not under `dataDir/recall-eval`. */
function evalPath(dataDir: Untyped, ...parts: Array<Untyped>) {
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
async function openSources(dataDir: Untyped, dbFile: Untyped) {
  const { readOnlyMemory } = await import('./lib/memory-read.ts');
  const { createAppendStore } = await import('../src/memory/append-store.ts');
  const { createRecord } = await import('../src/memory/record.ts');
  const { createArchive } = await import('../src/memory/archive.ts');
  const { createVectors } = await import('../src/memory/vectors.ts');
  const { createStore } = await import('../src/memory/store.ts');
  if (!fs.existsSync(dbFile)) throw new CliError(`recall-eval: no database at ${dbFile}`);
  // Reads only: no writer, so nothing built here can write the database.
  const { memoryDb, close } = readOnlyMemory(dataDir, { file: dbFile });
  // Iteration only: the archive's append store never gets an append, so it never opens a file for writing.
  const record = createRecord({ dataDir, memoryDb });
  const archive = createArchive({ appendStore: createAppendStore(), dataDir, memoryDb });
  const vectors = createVectors({ dataDir, memoryDb });
  const store = createStore({ dataDir, memoryDb });
  return {
    record: { iterate: (...args: Parameters<typeof record.iterate>) => record.iterate(...args) },
    archive: { iterate: (...args: Parameters<typeof archive.iterate>) => archive.iterate(...args) },
    vectors: { search: (...args: Parameters<typeof vectors.search>) => vectors.search(...args) },
    store,
    memoryDb,
    close,
  };
}

/** The memory database a run reads: `--db`, else `<data>/memory.db`. */
const dbFileOf = (flags: Untyped, { cwd, dataDir }: Rec) =>
  flags['--db'] ? path.resolve(cwd, flags['--db']) : path.join(dataDir, 'memory.db');

/** The stored members' first names by id. */
function namesOf(store: Rec) {
  const names = new Map();
  for (const profile of store.listUserProfiles() ?? []) {
    if (profile?.id && typeof profile.names?.[0] === 'string' && profile.names[0])
      names.set(String(profile.id), profile.names[0]);
  }
  return names;
}

/** The record's messages from `from` on (latestLines), optionally of the given channels. */
async function readRecord(record: Rec, placeId: Untyped, { from, placeIds: conversationIds = null }: Untyped) {
  const lines = [];
  for await (const line of record.iterate(placeId, {
    from: new Date(from).toISOString(),
    ...(conversationIds ? { placeIds: conversationIds } : {}),
  }))
    lines.push(line);
  return latestLines(lines);
}

/**
 * A REST-only Discord connection (no login, no gateway): the guild, its channels, the bot's own
 * user and member. Every request but GET is refused. As scripts/replay.ts connects.
 */
async function connectDiscord({ token, placeId }: Rec) {
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
    const guild = await client.guilds.fetch(placeId);
    await guild.channels.fetch();
    const me: Untyped = await client.rest.get(Routes.user());
    try {
      // @ts-expect-error: discord.js declares the ClientUser constructor protected; the REST-only client needs one for guild.members.me
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

/** Where a subcommand runs: the data folder, the guild, the clock and the folder the flags' paths are read from. */
type RunContext = { dataDir: string; placeId: string; now: () => number; cwd: string };

/** The `sample` subcommand. */
async function sample(flags: Flags, { dataDir, placeId, now, cwd }: RunContext) {
  const n = numberFlag(flags['--n'], DEFAULT_SAMPLE, { min: 1, max: 1000, integer: true });
  const days = numberFlag(flags['--days'], DEFAULT_SAMPLE_DAYS, { min: 3, max: 366, integer: true });
  const seed = numberFlag(flags['--seed'], now() % 2147483647, { min: 0, integer: true });
  const sources = await openSources(dataDir, dbFileOf(flags, { cwd, dataDir }));
  const { record, store } = sources;
  const names = namesOf(store);
  // One extra day back, so the oldest candidates have their neighbours too.
  let lines;
  try {
    lines = await readRecord(record, placeId, { from: now() - (days + 1) * DAY_MS });
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
    `${JSON.stringify({ at: new Date(now()).toISOString(), placeId, days, seed, candidates }, null, 2)}\n`
  );
  const channels = new Set(candidates.map((c) => c.placeId)).size;
  const dayCount = new Set(candidates.map((c) => c.occurredAt.slice(0, 10))).size;
  return `recall-eval: ${candidates.length} candidate(s) from ${lines.length} record message(s), ${channels} channel(s), ${dayCount} day(s), seed ${seed}\n${file}\n`;
}

/**
 * The reads and the scope (`channel` and `snapshot`) a recall run is handed for `channel` of `guild`: the local guild's
 * own, or Discord's over REST.
 */
async function recallParts(
  guild: Untyped,
  channel: Untyped,
  placeId: Untyped,
  config: () => unknown
): Promise<{ reads: Reads; scope: { channel: Untyped; snapshot: Untyped } }> {
  const found: {
    local?: boolean;
    client?: unknown;
    channels: { cache: { get: (id: string) => { name?: string | null } | undefined } };
  } = guild;
  const { id: conversationId } = channel;
  if (found.local === true) {
    const channelNameOf = (id: string) => found.channels.cache.get(id)?.name ?? null;
    return {
      reads: localReads({ placeId, channelNameOf }),
      scope: localScope({ placeId, conversationId: String(conversationId), channelNameOf }),
    };
  }
  const { reads } = discordReads(found.client, config);
  return { reads, scope: await recallScope(reads, channel, String(placeId)) };
}

/** `config` with the prefetch's deadline lifted (`--no-deadline`): a copy, the live config untouched. */
function withoutDeadline(config: Untyped, lifted: Untyped) {
  if (!lifted) return config;
  return {
    ...config,
    recall: { ...(config.recall ?? {}), prefetch: { ...(config.recall?.prefetch ?? {}), deadlineMs: 600000 } },
  };
}

/** One line of a recall-trace.jsonl file, as the engine wrote it (the fields past these are read by name). */
type TraceLine = {
  at: string;
  triggerId: string;
  placeId: string;
  forms?: Array<string>;
  who?: Array<string>;
  summary?: { answer?: string } | null;
  skipped?: string | null;
  [field: string]: Untyped;
};

/** The lines of a recall-trace.jsonl file that parse as objects, in order. */
function traceLines(file: string): Array<TraceLine> {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err: Untyped) {
    throw new CliError(`recall-eval: cannot read the trace file ${file} (${err?.code ?? err?.name ?? 'Error'})`);
  }
  const out: Array<TraceLine> = [];
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
async function traces(flags: Flags, { dataDir, placeId, now, cwd }: RunContext) {
  const dry = flags['--dry'] === true;
  const noDeadline = flags['--no-deadline'] === true;
  const file = flags._[1] ? path.resolve(cwd, flags._[1]) : path.join(dataDir, 'guilds', placeId, 'recall-trace.jsonl');
  const all = traceLines(file).filter(
    (t) => typeof t.triggerId === 'string' && t.triggerId && typeof t.placeId === 'string'
  );
  const limit = numberFlag(flags['--limit'], all.length, { min: 1, integer: true });
  const runs = all.slice(-limit);
  const { createHot } = await import('../src/hot.ts');
  const { createRecall } = await import('../src/behavior/recall-run.ts');
  const { prefetchLanes } = await import('../src/behavior/prefetch.ts');
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
    const settings = await recallSettingsOf(config);
    const meaningOn = !dry;
    process.stderr.write(
      `recall-eval: ${runs.length} live recall run(s)${meaningOn ? `, up to ${runs.length} embedding(s) on the simulator key` : ', no request'}\n`
    );
    let embed = null;
    if (meaningOn) {
      const { createEmbedder } = await import('../src/llm/embed.ts');
      const embedder = createEmbedder({ apiKey: simKey(ORIGIN), env: {}, state: { data: {}, markDirty() {} } });
      embed = (texts: Untyped, options: Untyped = {}) =>
        embedder.embed(texts, { ...options, origin: ORIGIN, countAgainstDailyCap: false });
    }
    sources = await openSources(dataDir, dbFileOf(flags, { cwd, dataDir }));
    const { record, archive, vectors, store, memoryDb } = sources;
    const names = namesOf(store);
    const nameOf = (id: string) => names.get(String(id)) ?? null;
    const channelNames = new Map(
      (store.listChannels?.(placeId) ?? []).filter((c: Rec) => c?.id).map((c: Rec) => [String(c.id), c.name || null])
    );
    const self = { id: flags['--self-id'] ?? null, name: flags['--self-name'] ?? null };
    const guild = localGuild({ placeId, selfId: self.id, channelNameOf: (id) => channelNames.get(id) ?? null });
    const selfName = self.name ?? cardAliases(hot.prompts?.['character-card'])[0] ?? 'bot';
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
        placeId: t.placeId,
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
          placeIds: [t.placeId],
        };
        for await (const line of record.iterate(placeId, query)) lines.push(line);
        const messages = latestLines(lines).map((line) => recordMessage(line, { nameOf, selfName }));
        const at = messages.findIndex((m) => m.id === t.triggerId);
        if (at === -1) throw Object.assign(new Error('no trigger'), { name: 'no-trigger-in-record' });
        const trigger = messages[at];
        const history = messages.slice(Math.max(0, at + 1 - historyCount), at + 1);
        const channel = guild.channels.cache.get(t.placeId);
        const { lanes, skip } = prefetchLanes({
          trigger,
          history,
          settings: settings.prefetch,
          selfId: self.id,
          selfName,
          selfNames: cardAliases(hot.prompts?.['character-card']),
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
        const parts = await recallParts(guild, channel, placeId, () => hot.config);
        const recall = createRecall({
          hot: evalHot,
          store: {
            state: { data: {}, markDirty() {} },
            listUserProfiles: () => store.listUserProfiles(),
            getLore: (id: string) => store.getLore(id),
            getPlace: (id: string) => store.getPlace(id),
            getRecent: (id: string) => store.getRecent(id),
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
          placeId,
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
      } catch (err: Untyped) {
        rows.push({ ...base, error: err?.name ?? 'Error' });
      }
    }
    const reportPath = evalPath(dataDir, 'runs', `${fileTime(now())}-traces.json`);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(
      reportPath,
      `${JSON.stringify({ at: new Date(now()).toISOString(), placeId, traceFile: file, mode: { dry, noDeadline }, settings: settings.prefetch, rows }, null, 2)}\n`
    );
    return renderTraceCompare(rows, { reportPath });
  } finally {
    sources?.close();
    hot.close?.();
  }
}

/** The recall settings of `config`, or the error that says there is nothing to measure. */
async function recallSettingsOf(config: Untyped) {
  const { recallSettings } = await import('../src/behavior/recall.ts');
  const settings = recallSettings(config);
  if (!settings) throw new CliError('recall-eval: recall is not set up: there is no recall to measure');
  // The settings result does not declare `fallbackOnClassifierFailure`, a key the tool has always read off it.
  return settings as typeof settings & { fallbackOnClassifierFailure?: unknown };
}

type Opts = { cwd?: string; now?: () => number };

/** The whole tool: the markdown summary on stdout (or the `sample` line). */
// health: allow function-length until 2027-02-01 -- the place rename widened lines the formatter wraps; split in the slice after the cutover
export async function main(argv: Array<string>, { cwd = process.cwd(), now = Date.now }: Opts = {}): Promise<string> {
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
  const placeId = resolveGuildId(dataDir, flags['--guild']);
  if (flags._[0] === 'sample') return sample(flags, { dataDir, placeId, now, cwd });
  if (flags._.length > 2 || (flags._.length === 2 && flags._[0] !== 'traces')) throw new CliError(USAGE);
  if (flags._[0] === 'traces') return traces(flags, { dataDir, placeId, now, cwd });

  const questionsFile = flags._[0] ? path.resolve(cwd, flags._[0]) : evalPath(dataDir, 'questions.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(questionsFile, 'utf8'));
  } catch (err: Untyped) {
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

  const { createHot } = await import('../src/hot.ts');
  const { createRecall } = await import('../src/behavior/recall-run.ts');
  const { parseQueryPlan } = await import('../src/behavior/query-builder.ts');
  const { fallbackLookupPlan } = await import('../src/behavior/turn.ts');
  const { prefetchLanes } = await import('../src/behavior/prefetch.ts');
  const { classifierTranscript, fillPromptTemplate } = await import('../src/behavior/prompt.ts');
  const { createLlm, roleRequestOptions, railReason } = await import('../src/llm/openrouter.ts');
  const { createEmbedder } = await import('../src/llm/embed.ts');
  const { createCalibrator } = await import('../src/llm/tokens.ts');
  const { roleModel } = await import('../src/llm/roles.ts');
  const { zonedDay } = await import('../src/time.ts');

  const hot = createHot({ rootDir: ROOT, privateDir: privateDirOf(ROOT) });
  // The recall's own trace switched on for this process only: its lines are caught in memory below.
  const evalHot = {
    get config() {
      const live = hot.config;
      return withoutDeadline(live, noDeadline);
    },
    get prompts() {
      return hot.prompts;
    },
  };
  const config = hot.config;
  const settings = await recallSettingsOf(config);
  if (!dry && !hot.prompts?.['query-builder']) throw new CliError('recall-eval: prompts.query-builder is missing');
  if (useWeb && !hot.prompts?.['search-summary']) throw new CliError('recall-eval: --web needs prompts.search-summary');
  const meaningOn = !dry;
  const stages = { classifier: !dry, database: true, meaning: meaningOn, discord: useDiscord, web: useWeb };
  const asking = Math.min(limit, questions.length);
  process.stderr.write(
    `recall-eval: ${asking} question(s); ${dry ? 'dry: no model request' : `up to ${asking * (REQUESTS_PER_QUESTION + (useWeb ? 1 : 0))} model request(s)${useWeb ? ` and ${asking} web search(es)` : ''}${meaningOn ? ` and ${asking} embedding(s)` : ''}, none asked once the cost passes ${maxUsd} USD`}\n`
  );

  // The keys (the simulation key from the store, DISCORD_TOKEN, the search engine's) only when something is sent.
  let webParts: Untyped = null;
  if (useWeb) {
    const { createLookup } = await import('../src/web/lookup.ts');
    const { createBraveSearch } = await import('../src/web/brave.ts');
    const { createExaSearch } = await import('../src/web/exa.ts');
    webParts = { createLookup, searches: { brave: createBraveSearch(), exa: createExaSearch() } };
    if (!webSearchReady({ hot: evalHot, ...webParts })) {
      throw new CliError(
        'recall-eval: --web needs a web search that can run (web.search.engine brave needs BRAVE_SEARCH_API_KEY in .env)'
      );
    }
  }
  const sources = await openSources(dataDir, dbFile);
  const { record, archive, vectors, store, memoryDb } = sources;
  const names = namesOf(store);
  const nameOf = (id: Untyped) => names.get(String(id)) ?? null;

  // The model clients on throwaway counters; per-role keys are not looked up (env {}): the simulator key pays.
  const counters = { data: {}, markDirty() {} };
  let usage: Untyped = null;
  let llm: Untyped;
  let embed: Untyped = null;
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
      async complete(messages: Untyped, options: Untyped = {}) {
        const completion: Untyped = await realLlm.complete(messages, {
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
      embed = async (texts: Untyped, options: Untyped = {}) => {
        if (usage) usage.embeddings += 1;
        return embedder.embed(texts, { ...options, origin: ORIGIN, countAgainstDailyCap: false });
      };
    }
  }

  // The web lookup (--web): the live module over an in-memory copy of the media cache, a fresh
  // daily counter per question (webSearch), nothing written back.
  let webSearch: Untyped = null;
  if (useWeb) {
    const { createLookup, searches } = webParts;
    const { createPageFetcher } = await import('../src/web/fetch-page.ts');
    const media = { ...(store.getMediaCache(placeOfCommunity(store, placeId)) ?? {}) };
    const webStore = { getMediaCache: () => media, markMediaCacheDirty() {} };
    const pageFetcher = createPageFetcher();
    const keys = webSearchKeys(process.env);
    webSearch = (query: Rec) =>
      createLookup({
        hot: evalHot,
        store: webStore,
        llm,
        state: { data: {}, markDirty() {} },
        pageFetcher,
        searches,
        keys,
        now,
      }).search(placeId, query);
  }

  // The guild: Discord over REST, or the local one.
  let connection = null;
  let guild: Untyped;
  let self = { id: flags['--self-id'] ?? null, name: flags['--self-name'] ?? null };
  if (useDiscord) {
    const token = interfaceCredential(hot.privateDir, 'discord');
    if (!token) throw new CliError('recall-eval: --discord needs data/interfaces/discord/credentials.json');
    connection = await connectDiscord({ token, placeId });
    guild = connection.guild;
    self = { id: self.id ?? connection.self.id, name: self.name ?? connection.self.name };
  } else {
    const channelNames = new Map(
      (store.listChannels?.(placeId) ?? []).filter((c: Rec) => c?.id).map((c: Rec) => [String(c.id), c.name || null])
    );
    guild = localGuild({ placeId, selfId: self.id, channelNameOf: (id) => channelNames.get(id) ?? null });
  }
  const selfName = self.name ?? cardAliases(hot.prompts?.['character-card'])[0] ?? 'bot';
  const historyCount = Math.max(1, Math.floor(config.context?.channelMessages ?? 100));
  const historyOf = new Map();

  /** The channel's last lines from the record, as the turn's chat. */
  async function channelHistory(conversationId: Untyped) {
    if (!historyOf.has(conversationId)) {
      const lines = await readRecord(record, placeId, {
        from: now() - HISTORY_DAYS * DAY_MS,
        placeIds: [conversationId],
      });
      historyOf.set(
        conversationId,
        lines.slice(-historyCount).map((line) => recordMessage(line, { nameOf, selfName }))
      );
    }
    return historyOf.get(conversationId);
  }

  /** The search classifier's server part for `trigger`, as maybeLookup asks it; `fallback` on a failed or empty answer. */
  async function classify(trigger: Rec, history: Rec) {
    const searchCfg = hot.config.web?.search ?? {};
    const contextMessages = Math.max(0, Math.floor(searchCfg.contextMessages ?? 50));
    const context = contextMessages > 0 ? history.filter((m: Rec) => m.id !== trigger.id).slice(-contextMessages) : [];
    const triggerText = [...String(trigger.content ?? '')].slice(0, MAX_MESSAGE_CHARS).join('');
    const transcript =
      context.length === 0
        ? ''
        : `<transcript>\n${classifierTranscript(context, { config: hot.config, selfName, labels: hot.prompts.labels })}\n</transcript>\n`;
    // A dry run has no classifier: the fallback plan always stands in for its answer.
    const fallback = (reason: Untyped) => {
      if (!dry && !settings.fallbackOnClassifierFailure) return { server: null, how: 'failed', reason };
      const plan = fallbackLookupPlan({
        text: triggerText,
        profiles: store.listUserProfiles() ?? [],
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
            content: fillPromptTemplate(hot.prompts['query-builder'], {
              today: zonedDay(now(), hot.config.bot?.timezone),
              name: selfName,
              skills: '',
            }),
          },
          { role: 'user', content: `${transcript}<candidate>\n${trigger.authorName}: ${triggerText}\n</candidate>` },
        ],
        {
          model: roleModel(hot.config, 'analyzer', 'query-builder'),
          ...roleRequestOptions(hot.config, {
            role: 'analyzer',
            maxOutputTokens: searchCfg.classifierMaxOutputTokens ?? 2000,
            purpose: 'query-builder',
          }),
        }
      );
    } catch (err) {
      return fallback(railReason(err, 'classifier-failed'));
    }
    if (!String(completion?.text ?? '').trim()) return fallback('empty');
    const parsed = parseQueryPlan(completion.text, {
      timezone: hot.config.bot?.timezone,
      now: now(),
      maxForms: settings.maxForms,
    });
    return {
      server: parsed.history ?? null,
      web: parsed.web ?? null,
      how: 'classifier',
      reason: parsed.reason ?? null,
      raw: completion.text,
    };
  }

  /** The trigger a question is asked as: a new message of `askerId` in its channel, now. */
  const triggerOf = (q: Question, index: number) => ({
    id: `recall-eval-${index + 1}`,
    placeId: q.placeId,
    authorId: q.askerId,
    authorName: nameOf(q.askerId) ?? '-',
    content: q.question,
    ts: now(),
    self: false,
    bot: false,
    replyToId: null,
    mentionedAccountIds: [],
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    forwarded: [],
    reactions: [],
  });

  /** The question asked the way a turn of her tool loop asks it: the automatic memory prefetch, scored. */
  async function askPrefetch(q: Question, index: number) {
    const started = now();
    try {
      const channel = guild.channels.cache.get(q.placeId);
      if (!channel) return { status: 'error', error: 'no-channel', excerpts: 0, score: null, ms: 0 };
      const trigger = triggerOf(q, index);
      const chat = await channelHistory(q.placeId);
      const history = [...chat, trigger];
      const { lanes, skip } = prefetchLanes({
        trigger,
        history,
        settings: settings.prefetch,
        selfId: self.id,
        selfName,
        selfNames: cardAliases(hot.prompts?.['character-card']),
        nameOf,
      });
      if (skip)
        return {
          status: `skipped:${skip}`,
          excerpts: 0,
          score: scoreQuestion(q, { chatIds: chat.map((m: Rec) => m.id) }),
          ms: now() - started,
        };
      const parts = await recallParts(guild, channel, placeId, () => hot.config);
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
      const found = await recall.prefetch({ placeId, ...parts.scope, selfId: self.id, selfName, history, lanes });
      const { windows, matched } = prefetchWindows(found);
      return {
        status: found?.status ?? 'none-ran',
        partial: found?.partial === true,
        basis: found?.basis ?? [],
        excerpts: found?.excerpts?.length ?? 0,
        score: scoreQuestion(q, { windows, matched, confident: false, chatIds: chat.map((m: Rec) => m.id) }),
        found: found?.excerpts ?? [],
        stats: found?.stats ?? null,
        ms: now() - started,
      };
    } catch (err: Untyped) {
      return { status: 'error', error: err?.name ?? 'Error', excerpts: 0, score: null, ms: now() - started };
    }
  }

  /** One question asked and scored; with `--prefetch` also through the automatic prefetch. */
  async function ask(q: Question, index: number) {
    const result = await askClassifier(q, index);
    if (!usePrefetch) return result;
    return { ...result, prefetch: await askPrefetch(q, index) };
  }

  /** The store's read methods for one run: a fresh daily recall counter, no trace written. */
  function readStore(onTrace: Untyped = null) {
    return {
      state: { data: {}, markDirty() {} },
      listUserProfiles: () => store.listUserProfiles(),
      getLore: (id: string) => store.getLore(id),
      getPlace: (id: string) => store.getPlace(id),
      getRecent: (id: string) => store.getRecent(id),
      appendRecallTrace: (id: string, line: Untyped) => onTrace?.(line),
    };
  }

  /** One question asked through the classifier path and scored. */
  async function askClassifier(q: Question, index: number) {
    const started = now();
    usage = { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, embeddings: 0 };
    const base = {
      id: q.id,
      kind: q.kind,
      placeId: q.placeId,
      question: q.question,
      expected: q.expected,
      ...(q.note ? { note: q.note } : {}),
    };
    const finish = (extra: Rec) => {
      const out = { ...base, ...extra, latencyMs: now() - started, usage: { ...usage }, costUsd: usage.costUsd };
      usage = null;
      return out;
    };
    try {
      const channel = guild.channels.cache.get(q.placeId);
      if (!channel) return finish({ error: 'no-channel', score: null });
      const trigger = triggerOf(q, index);
      const chat = await channelHistory(q.placeId);
      // The asking channel's visible chat: an expected line in it is answered by the chat.
      const chatIds = chat.map((m: Rec) => m.id);
      const history = [...chat, trigger];
      const classified: Untyped = await classify(trigger, history);
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
              (result: Rec) => ({
                query: result?.query ?? classified.web,
                found: Boolean(result?.text),
                sources: Array.isArray(result?.sources) ? result.sources.length : 0,
                text: result?.text ?? null,
              }),
              (e: Rec) => ({ query: classified.web, found: false, sources: 0, text: null, error: e?.name ?? 'Error' })
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
      let trace: Untyped = null;
      const recallStore = readStore((line: Untyped) => {
        trace = line;
      });
      const parts = await recallParts(guild, channel, placeId, () => hot.config);
      const recall: Untyped = createRecall({
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
      const windows: Array<Untyped> = [];
      const found: Untyped = await recall.run({
        placeId,
        ...parts.scope,
        selfId: self.id,
        selfName,
        history,
        candidate: trigger,
        server: classified.server,
        quotes: true,
        decorate: (messages: Untyped) => {
          windows.push(messages);
          return messages;
        },
      });
      const matched = new Set<string>(found?.hitIds ?? []);
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
          w.map((m: Untyped) => ({
            id: m.id,
            placeId: m.placeId ?? null,
            authorId: m.authorId ?? null,
            ts: m.ts ?? null,
            self: m.self === true,
            text: m.content ?? '',
          }))
        ),
        memory: trace?.memory ?? [],
        stats: found?.stats ?? null,
      });
    } catch (err: Untyped) {
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
    placeId,
    questionsFile,
    mode: { dry, discord: useDiscord, web: useWeb, prefetch: usePrefetch, noDeadline },
    stages,
    settings: { recall: settings, meaningSearch: true, channelMessages: historyCount },
    stopped: outcome.stopped,
    skipped: outcome.skipped,
    summary,
    ...(usePrefetch ? { prefetch: comparePrefetch(outcome.results) } : {}),
    results: outcome.results,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const text = renderSummary(summary, { reportPath, stages, stopped: outcome.stopped, skipped: outcome.skipped });
  return usePrefetch ? `${text}\n${renderPrefetchCompare(report.prefetch!, outcome.results, { reportPath })}` : text;
}

runCli(import.meta.url, main);
