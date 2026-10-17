#!/usr/bin/env node
// Operations tool: the meaning index (src/memory/vectors.js) built for history. The live queue
// (src/memory/embedder.js) embeds what the record takes from the moment it is on; this tool embeds
// whole months of the record and the archive that came before, or builds a month again (a model
// or a dimension change). One vector per record message (with the lines before it in the same
// channel, src/memory/chunks.js) and one per archive item, in the guild index and in each private
// layer's own.
//
//   cd /opt/neptunia/app && node tools/embed-index.mjs <subcommand> [--guild <id>] [flags]
//
//   estimate [--from YYYY-MM] [--to YYYY-MM] [--usd-per-mtok 0.13]
//            Per month: the record and archive chunks, their tokens (characters / 3.5) and the
//            cost at `--usd-per-mtok` (USD per million tokens), and the rows already indexed.
//            Reads only.
//   build    --max-usd <n> [--from YYYY-MM] [--to YYYY-MM] [--rebuild] [--include-live] [--dry-run] [--usd-per-mtok 0.13]
//            Embeds the months in the range not indexed yet (every one with `--rebuild`), in
//            batches of `embed.batch` within `llm.maxRequestTokens`, on the `embedding`
//            model. The estimate comes first; the run is refused (exit 2) when it exceeds
//            `--max-usd`, and stops before a month that would pass it. A month is written whole as
//            a new generation of the index and switched in at its end (rows the live queue added
//            meanwhile are kept), so the index never shows half a month. `--dry-run` prints the
//            plan and the estimate and sends nothing.
//   stats    [--coverage [--hours N]]
//            The index per month: rows, bytes, model, dimensions; the private layers summed.
//            `--coverage` adds the record of the last `--hours` (default `embed.catchUpHours`)
//            against the index, guild and private layers together: messages, indexed, missing,
//            the oldest missing time.
//
// Range: `--from` / `--to` default to the first month the record or the archive holds and the
// current month. Safe while the bot runs: refused while a forget is under way (a `forgetting/`
// marker); lines of a member the deletion ledger forgot after them are never sent; and while the
// bot runs with its live queue on, the current month (and the previous one during the first day)
// is left to the queue, whose catch-up covers the last `embed.catchUpHours` after any gap. For a
// live month the queue's catch-up does not reach (the switches turned on mid-month),
// `--include-live` embeds only its rows missing from the index (the record lines older than the
// catch-up window, and the archive items) and appends them, never replacing the month, so it
// cannot clash with the queue's appends. Requests keep the embedding client's rails (the
// per-request token cap, the daily request cap counted from today's count without writing it
// back).
//
// Output: counts, tokens and USD only, never a message's text.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simKey, CliError, REFUSED_EXIT, defaultDataDir, parseFlags, privateDirOf, resolveGuildId, runCli } from './lib/cli.mjs';
import { log as defaultLog } from '../src/log.js';
import { roleModel } from '../src/llm/roles.js';
import { EMBED_ROLE } from '../src/llm/embed.js';
import { createAppendStore } from '../src/memory/append-store.js';
import { createArchive } from '../src/memory/archive.js';
import { archiveChunk, chunkKey, isEmbeddableArchive, recordChunks } from '../src/memory/chunks.js';
import { createEmbedder as createEmbedQueue } from '../src/memory/embedder.js';
import { createJournal } from '../src/memory/journal.js';
import { createRecord, forgettingIds, recordDrops } from '../src/memory/record.js';
import { readLedger } from '../src/memory/store.js';
import { createVectors } from '../src/memory/vectors.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE =
  'usage: node tools/embed-index.mjs estimate [--from YYYY-MM] [--to YYYY-MM] [--usd-per-mtok 0.13] [--guild <id>]\n' +
  '       node tools/embed-index.mjs build --max-usd <n> [--from YYYY-MM] [--to YYYY-MM] [--rebuild] [--include-live] [--dry-run] [--usd-per-mtok 0.13] [--guild <id>]\n' +
  '       node tools/embed-index.mjs stats [--coverage [--hours N]] [--guild <id>]   (cwd: the bot directory)';
const SUBCOMMANDS = ['estimate', 'build', 'stats'];
const MONTH_RE = /^\d{4}-\d{2}$/;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** `embed.catchUpHours` when missing or invalid: config.json's value. */
const CATCH_UP_HOURS_FALLBACK = 72;
/** USD per million tokens of the embedding model (`--usd-per-mtok`): text-embedding-3-large's price. */
const DEFAULT_USD_PER_MTOK = 0.13;
/** Characters per token in the estimate. */
const CHARS_PER_TOKEN = 3.5;
/** `embed.batch` when missing or invalid: config.json's value. */
const BATCH_FALLBACK = 64;
/** `llm.maxRequestTokens` when missing: config.json's value. */
const MAX_REQUEST_TOKENS_FALLBACK = 50000;

/** A non-negative number from a flag, `fallback` when absent; a CliError otherwise. */
function numberFlag(value, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new CliError(USAGE);
  return n;
}

/** A JSON file's value, `fallback` when missing or unreadable. */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** The directory names under `dir`, sorted; [] when missing. */
function dirsUnder(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

/** The tokens of a text as the estimate counts them. */
const tokensOf = (text) => Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN);

/** The month before `month`. */
function previousMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/**
 * The whole tool: the subcommand's report (or a refusal, as a CliError).
 * @param {string[]} argv
 * @param {{ cwd?: string, now?: () => number, hot?: object, embedClient?: { embed: Function },
 *   log?: object, rootDir?: string }} [options]  `hot` and `embedClient` stand in for the live
 *   config and the OpenRouter embedding client (test fakes); the gates still apply.
 * @returns {Promise<string>}
 */
export async function main(argv, { cwd = process.cwd(), now = Date.now, hot: givenHot = null, embedClient = null, log = defaultLog, rootDir = ROOT } = {}) {
  const flags = parseFlags(argv, {
    values: ['--guild', '--data', '--from', '--to', '--max-usd', '--usd-per-mtok', '--hours'],
    switches: ['--rebuild', '--dry-run', '--include-live', '--coverage'],
    usage: USAGE,
  });
  const sub = flags._[0];
  if (!SUBCOMMANDS.includes(sub) || flags._.length > 1) throw new CliError(USAGE);
  if ((flags['--rebuild'] || flags['--dry-run'] || flags['--include-live'] || flags['--max-usd'] !== undefined) && sub !== 'build') throw new CliError(USAGE);
  if ((flags['--coverage'] && sub !== 'stats') || (flags['--hours'] !== undefined && !flags['--coverage'])) throw new CliError(USAGE);
  const hours = flags['--hours'] === undefined ? undefined : numberFlag(flags['--hours'], undefined);
  if (hours === 0) throw new CliError(USAGE);
  for (const key of ['--from', '--to']) if (flags[key] !== undefined && (!MONTH_RE.test(flags[key]) || sub === 'stats')) throw new CliError(USAGE);
  if (flags['--from'] && flags['--to'] && flags['--from'] > flags['--to']) throw new CliError(USAGE);
  const usdPerMtok = numberFlag(flags['--usd-per-mtok'], DEFAULT_USD_PER_MTOK);
  const maxUsd = sub === 'build' ? numberFlag(flags['--max-usd'], undefined) : undefined;
  if (sub === 'build' && maxUsd === undefined) throw new CliError(`${USAGE}\n(build needs --max-usd)`);

  let hot = givenHot;
  if (!hot) {
    const { createHot } = await import('../src/hot.js');
    hot = createHot({ rootDir, privateDir: privateDirOf(rootDir) });
  }
  const dataDir = flags['--data'] !== undefined ? path.resolve(cwd, flags['--data']) : defaultDataDir(cwd);
  const guildId = resolveGuildId(dataDir, flags['--guild'] ?? (hot.config.bot?.guildId || undefined));
  const guildDir = path.join(dataDir, 'guilds', guildId);
  const recordStore = createAppendStore({ log, now });
  const archiveStore = createAppendStore({ log, now });
  const journalStore = createAppendStore({ log, now });
  let journal = null;
  const writerGate = () => journal.waitUnlocked();
  const record = createRecord({ appendStore: recordStore, dataDir, log, now, writerGate });
  const archive = createArchive({ appendStore: archiveStore, dataDir, log, now, writerGate });
  journal = createJournal({ appendStore: journalStore, dataDir, config: () => ({}), now, log, lockStores: [recordStore, archiveStore] });
  const vectors = createVectors({ dataDir, log, now, writerGate });
  const ctx = { flags, sub, hot, dataDir, guildId, guildDir, now, log, rootDir, record, archive, vectors, embedClient, usdPerMtok, maxUsd, hours };
  try {
    if (sub === 'stats') return await cmdStats(ctx);
    if (sub === 'estimate') return await cmdEstimate(ctx);
    return await cmdBuild(ctx);
  } finally {
    await Promise.all([recordStore.close(), archiveStore.close(), journalStore.close()]);
    if (!givenHot) hot.close?.();
  }
}

// ---- what there is to embed ---------------------------------------------------------------------

/** The layers of the guild: its own (null), then each member's private layer with a record or an archive. */
function layersOf(ctx) {
  const out = [null];
  for (const userId of dirsUnder(path.join(ctx.guildDir, 'private'))) {
    const base = path.join(ctx.guildDir, 'private', userId);
    if (fs.existsSync(path.join(base, 'record')) || fs.existsSync(path.join(base, 'archive'))) out.push(userId);
  }
  return out;
}

/** A member's stored display name (their profile's first name), read once. */
function nameResolver(ctx) {
  const cache = new Map();
  return (id) => {
    if (!cache.has(id)) {
      const names = readJson(path.join(ctx.guildDir, 'users', `${id}.json`), null)?.names;
      cache.set(id, Array.isArray(names) && typeof names[0] === 'string' && names[0] ? names[0] : null);
    }
    return cache.get(id);
  };
}

/** The persona's name: the backfill fetch's, else the config's first name trigger. */
function selfNameOf(ctx) {
  const saved = readJson(path.join(ctx.guildDir, 'record', 'backfill.json'), {});
  return typeof saved?.selfName === 'string' && saved.selfName ? saved.selfName : (ctx.hot.config.bot?.nameTriggers?.[0] ?? 'bot');
}

/** The deletion ledger: each forgotten member's latest time (epoch ms). */
function ledgerOf(ctx) {
  const latest = new Map();
  for (const entry of readLedger(ctx.dataDir, ctx.guildId)) {
    const at = Date.parse(entry.at);
    if (Number.isFinite(at) && !(latest.get(entry.userId) >= at)) latest.set(entry.userId, at);
  }
  return latest;
}

/** Whether the ledger leaves a chunk out: a member of it (or its private layer's member) forgotten after it. */
function ledgerDrops(meta, privateUserId, ledger) {
  for (const [id, at] of ledger) if (recordDrops(meta, id, at)) return true;
  const own = privateUserId ? ledger.get(privateUserId) : undefined;
  return own !== undefined && !(Date.parse(meta.occurredAt) >= own);
}

/** The months the record of a layer holds. */
function recordMonths(ctx, privateUserId) {
  const base = privateUserId ? path.join(ctx.guildDir, 'private', privateUserId, 'record') : path.join(ctx.guildDir, 'record');
  return dirsUnder(base).filter((name) => MONTH_RE.test(name));
}

/** Every archive chunk of a layer (the newest entry of each item), by month. */
async function archiveChunksOf(ctx, privateUserId, nameOf) {
  const newest = new Map();
  for await (const entry of ctx.archive.iterate(ctx.guildId, { privateUserId })) {
    if (!isEmbeddableArchive(entry)) continue;
    const held = newest.get(entry.itemId);
    if (!held || String(entry.recordedAt) >= String(held.recordedAt)) newest.set(entry.itemId, entry);
  }
  const byMonth = new Map();
  for (const entry of newest.values()) {
    const chunk = archiveChunk(entry, { nameOf });
    if (!chunk.text || !chunk.meta.occurredAt) continue;
    const month = chunk.meta.occurredAt.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(chunk);
  }
  return byMonth;
}

/**
 * The record chunks of one month of a layer, each line with its context (a day back into the
 * month before); a line the ledger leaves out is neither embedded nor anyone's context.
 */
async function recordChunksOf(ctx, month, privateUserId, nameOf, selfName, ledger) {
  const [y, m] = month.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1) - DAY_MS).toISOString();
  const to = new Date(Date.UTC(y, m, 1) - 1).toISOString();
  const lines = [];
  for await (const line of ctx.record.iterate(ctx.guildId, { from, to, privateUserId })) {
    if (!ledgerDrops(line, privateUserId, ledger)) lines.push(line);
  }
  return recordChunks(lines, { nameOf, selfName }).filter((chunk) => chunk.meta.occurredAt?.slice(0, 7) === month);
}

/** The rows a layer's month holds in the index now (its manifest), 0 when none. */
function indexedRows(ctx, month, privateUserId) {
  const base = privateUserId ? path.join(ctx.guildDir, 'private', privateUserId, 'vectors') : path.join(ctx.guildDir, 'vectors');
  const manifest = readJson(path.join(base, month, 'manifest.json'), null);
  return Number.isInteger(manifest?.rows) ? manifest.rows : 0;
}

/**
 * The plan: for each month in range and each layer, the chunks to embed (the ledger's left out)
 * and the rows already indexed.
 * @returns {Promise<Array<{ month: string, privateUserId: string|null, records: object[], archived: object[], indexed: number }>>}
 */
async function planOf(ctx) {
  const nameOf = nameResolver(ctx);
  const selfName = selfNameOf(ctx);
  const ledger = ledgerOf(ctx);
  const current = new Date(ctx.now()).toISOString().slice(0, 7);
  const layers = layersOf(ctx);
  const archives = new Map();
  const months = new Set();
  for (const layer of layers) {
    for (const month of recordMonths(ctx, layer)) months.add(month);
    const byMonth = await archiveChunksOf(ctx, layer, nameOf);
    archives.set(layer, byMonth);
    for (const month of byMonth.keys()) months.add(month);
  }
  const sorted = [...months].sort();
  const from = ctx.flags['--from'] ?? sorted[0] ?? current;
  const to = ctx.flags['--to'] ?? current;
  const plan = [];
  for (const month of sorted.filter((value) => value >= from && value <= to)) {
    for (const layer of layers) {
      const keep = (chunk) => !ledgerDrops(chunk.meta, layer, ledger);
      const records = (await recordChunksOf(ctx, month, layer, nameOf, selfName, ledger)).filter(keep);
      const archived = (archives.get(layer).get(month) ?? []).filter(keep);
      if (records.length === 0 && archived.length === 0) continue;
      plan.push({ month, privateUserId: layer, records, archived, indexed: indexedRows(ctx, month, layer) });
    }
  }
  return plan;
}

/** The tokens and USD of a set of chunks. */
function costOf(ctx, chunks) {
  const tokens = chunks.reduce((sum, chunk) => sum + tokensOf(chunk.text), 0);
  return { tokens, usd: (tokens / 1e6) * ctx.usdPerMtok };
}

/** The plan as rows, one per month and layer kind (private layers summed): counts only. */
function planRows(ctx, plan) {
  const rows = new Map();
  for (const item of plan) {
    const key = `${item.month} ${item.privateUserId ? 'private' : 'guild'}`;
    const row = rows.get(key) ?? { key, records: 0, archived: 0, tokens: 0, usd: 0, indexed: 0 };
    const cost = costOf(ctx, [...item.records, ...item.archived]);
    row.records += item.records.length;
    row.archived += item.archived.length;
    row.tokens += cost.tokens;
    row.usd += cost.usd;
    row.indexed += item.indexed;
    rows.set(key, row);
  }
  const lines = ['month   layer    records  archive   tokens      usd  indexed'];
  for (const row of rows.values()) {
    const [month, layer] = row.key.split(' ');
    lines.push(
      `${month} ${layer.padEnd(7)} ${String(row.records).padStart(8)} ${String(row.archived).padStart(8)} ${String(row.tokens).padStart(8)} ${row.usd.toFixed(4).padStart(8)} ${String(row.indexed).padStart(8)}`,
    );
  }
  return lines;
}

async function cmdEstimate(ctx) {
  const plan = await planOf(ctx);
  const total = costOf(ctx, plan.flatMap((item) => [...item.records, ...item.archived]));
  return [...planRows(ctx, plan), `total: ${plan.reduce((n, item) => n + item.records.length + item.archived.length, 0)} chunks, ${total.tokens} tokens, ~${total.usd.toFixed(4)} USD at ${ctx.usdPerMtok} USD per million tokens`, ''].join('\n');
}

// ---- build --------------------------------------------------------------------------------------

/** Whether the bot runs on this data/ with its live queue on: then it writes the current months itself. */
function liveQueueRuns(ctx) {
  const features = ctx.hot.config.features ?? {};
  return fs.existsSync(path.join(ctx.guildDir, 'journal', '.running')) && features.meaningSearch === true && features.embedIndex === true;
}

/** The embedding client: the given fake, else the bot's with a copy of today's request count (never written back). */
async function embedClientOf(ctx) {
  if (ctx.embedClient) return ctx.embedClient;
  const { loadDotEnv } = await import('../src/config.js');
  loadDotEnv(privateDirOf(ctx.rootDir));
  const apiKey = simKey('embed-index');
  const { createEmbedder } = await import('../src/llm/embed.js');
  const stateData = readJson(path.join(ctx.dataDir, 'state.json'), {}) ?? {};
  const state = { data: { llmDay: stateData.llmDay, llmCount: stateData.llmCount }, markDirty() {} };
  return createEmbedder({ apiKey, state });
}

/** `chunks` in request batches: at most `embed.batch` each, within `llm.maxRequestTokens` by the estimate. */
function batchesOf(ctx, chunks) {
  const size = Number.isInteger(ctx.hot.config.embed?.batch) && ctx.hot.config.embed.batch > 0 ? ctx.hot.config.embed.batch : BATCH_FALLBACK;
  const cap = Number.isFinite(ctx.hot.config.llm?.maxRequestTokens) ? ctx.hot.config.llm.maxRequestTokens : MAX_REQUEST_TOKENS_FALLBACK;
  const out = [];
  let batch = [];
  let tokens = 0;
  for (const chunk of chunks) {
    const cost = tokensOf(chunk.text);
    if (batch.length > 0 && (batch.length >= size || tokens + cost > cap)) {
      out.push(batch);
      batch = [];
      tokens = 0;
    }
    batch.push(chunk);
    tokens += cost;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

/**
 * Which current rows of a rebuilt month stay beside the new ones: those of a message or item the
 * build does not hold, and a record row of a newer revision than the build's (the live queue's,
 * written meanwhile).
 */
function keepBeside(chunks) {
  const built = new Map();
  for (const { meta } of chunks) built.set(`${meta.kind}:${meta.id}`, meta.revision);
  return (meta) => {
    const key = `${meta?.kind === 'archive' ? 'archive' : 'record'}:${meta?.id}`;
    if (!built.has(key)) return true;
    return meta.kind !== 'archive' && Number.isInteger(meta.revision) && meta.revision > built.get(key);
  };
}

/** `embed.catchUpHours` now: the window the live queue's catch-up covers. */
function catchUpHoursOf(ctx) {
  const value = ctx.hot.config.embed?.catchUpHours;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : CATCH_UP_HOURS_FALLBACK;
}

/**
 * The live months' plan items cut to what the index misses: the record chunks older than the
 * catch-up window and the archive chunks, neither held at their revision; items left empty go.
 */
async function missingOfLive(ctx, items) {
  const cutoff = ctx.now() - catchUpHoursOf(ctx) * HOUR_MS;
  const out = [];
  for (const item of items) {
    const held = await ctx.vectors.has(ctx.guildId, item.month, { privateUserId: item.privateUserId });
    const records = item.records.filter((chunk) => Date.parse(chunk.meta.occurredAt) < cutoff && !held.has(chunkKey(chunk.meta)));
    const archived = item.archived.filter((chunk) => !held.has(chunkKey(chunk.meta)));
    if (records.length + archived.length > 0) out.push({ ...item, records, archived, append: true });
  }
  return out;
}

async function cmdBuild(ctx) {
  const marked = await forgettingIds(fs.promises, ctx.dataDir, ctx.guildId);
  if (marked.size > 0) throw new CliError(`embed-index: a forget is under way (${marked.size} forgetting marker(s)); run again once it has finished`);
  const model = roleModel(ctx.hot.config, EMBED_ROLE);
  if (!model) throw new CliError('embed-index: no embedding model is configured (roles.embedding)');
  const plan = await planOf(ctx);
  const current = new Date(ctx.now()).toISOString().slice(0, 7);
  const live = new Set();
  if (liveQueueRuns(ctx)) {
    live.add(current);
    if (new Date(ctx.now() - DAY_MS).toISOString().slice(0, 7) !== current) live.add(previousMonth(current));
  }
  const rebuild = ctx.flags['--rebuild'] === true;
  const includeLive = ctx.flags['--include-live'] === true;
  const todo = plan.filter((item) => !live.has(item.month) && (rebuild || item.indexed === 0));
  const liveItems = plan.filter((item) => live.has(item.month));
  if (includeLive) todo.push(...(await missingOfLive(ctx, liveItems)));
  const skipped = { indexed: plan.filter((item) => !rebuild && item.indexed > 0).length, live: includeLive ? 0 : liveItems.length };
  const estimate = costOf(ctx, todo.flatMap((item) => [...item.records, ...item.archived]));
  const head = [
    ...planRows(ctx, todo),
    `plan: ${todo.length} month layer(s) to ${rebuild ? 'rebuild' : 'build'}, ${skipped.indexed} already indexed, ${skipped.live} left to the live queue`,
    ...(includeLive && liveItems.length > 0 ? [`live months: only the rows missing from the index, the record before the last ${catchUpHoursOf(ctx)} h (the queue's catch-up has those), appended`] : []),
    `estimate: ${estimate.tokens} tokens, ~${estimate.usd.toFixed(4)} USD on ${model} (at ${ctx.usdPerMtok} USD per million tokens)`,
  ];
  if (ctx.flags['--dry-run'] === true) return [...head, 'dry run: nothing sent, nothing written', ''].join('\n');
  if (estimate.usd > ctx.maxUsd) {
    throw new CliError([...head, `refused: the estimate is above --max-usd ${ctx.maxUsd}`].join('\n'), { exitCode: REFUSED_EXIT });
  }
  const client = await embedClientOf(ctx);
  let spentUsd = 0;
  let spentTokens = 0;
  let requests = 0;
  const done = [];
  let stopped = null;
  for (const item of todo) {
    const chunks = [...item.records, ...item.archived];
    const cost = costOf(ctx, chunks);
    if (spentUsd + cost.usd > ctx.maxUsd) {
      stopped = `${item.month}: --max-usd ${ctx.maxUsd} reached`;
      break;
    }
    const rows = [];
    for (const batch of batchesOf(ctx, chunks)) {
      const out = await client.embed(batch.map((chunk) => chunk.text), { config: ctx.hot.config, origin: 'embed-index' });
      requests += 1;
      batch.forEach((chunk, i) => rows.push({ meta: chunk.meta, vector: out[i] }));
    }
    spentUsd += cost.usd;
    spentTokens += cost.tokens;
    if (item.append) {
      // A live month: appended beside the queue's rows, each checked against the index again.
      const held = await ctx.vectors.has(ctx.guildId, item.month, { privateUserId: item.privateUserId });
      const fresh = rows.filter((row) => !held.has(chunkKey(row.meta)));
      try {
        const { written } = await ctx.vectors.append(ctx.guildId, fresh, { privateUserId: item.privateUserId, model });
        done.push({ month: item.month, layer: item.privateUserId ? 'private' : 'guild', written, kept: item.indexed, dropped: 0 });
      } catch (error) {
        if (error?.code !== 'vectors-shape') throw error;
        stopped = `${item.month}: the index holds rows of another model or length; rebuild the month with the bot stopped`;
        break;
      }
      continue;
    }
    const result = await ctx.vectors.replace(ctx.guildId, item.month, rows, { privateUserId: item.privateUserId, model, keep: keepBeside(chunks) });
    done.push({ month: item.month, layer: item.privateUserId ? 'private' : 'guild', ...result });
  }
  const lines = [...head, 'month   layer    written     kept  dropped'];
  for (const row of done) {
    lines.push(`${row.month} ${row.layer.padEnd(7)} ${String(row.written).padStart(8)} ${String(row.kept).padStart(8)} ${String(row.dropped).padStart(8)}`);
  }
  lines.push(`built: ${done.length} month layer(s), ${requests} request(s), ~${spentTokens} tokens, ~${spentUsd.toFixed(4)} USD`);
  if (stopped) lines.push(`stopped: ${stopped}`);
  return [...lines, ''].join('\n');
}

// ---- stats --------------------------------------------------------------------------------------

async function cmdStats(ctx) {
  const base = path.join(ctx.guildDir, 'vectors');
  const lines = ['month   rows     bytes  dims  model'];
  for (const month of dirsUnder(base).filter((name) => MONTH_RE.test(name))) {
    const manifest = readJson(path.join(base, month, 'manifest.json'), null);
    if (!manifest) continue;
    lines.push(`${month} ${String(manifest.rows).padStart(6)} ${String(manifest.bytes + manifest.metaBytes).padStart(9)} ${String(manifest.dims).padStart(5)}  ${manifest.model ?? '-'}`);
  }
  const total = await ctx.vectors.stats(ctx.guildId);
  lines.push(`guild: ${total.months} month(s), ${total.rows} rows, ${total.bytes} bytes`);
  let layers = 0;
  let rows = 0;
  let bytes = 0;
  for (const userId of dirsUnder(path.join(ctx.guildDir, 'private'))) {
    const stats = await ctx.vectors.stats(ctx.guildId, { privateUserId: userId });
    if (stats.months === 0) continue;
    layers += 1;
    rows += stats.rows;
    bytes += stats.bytes;
  }
  lines.push(`private: ${layers} layer(s), ${rows} rows, ${bytes} bytes`);
  if (ctx.flags['--coverage'] === true) {
    // The live queue's own coverage check, read only: nothing is queued or sent.
    const queue = createEmbedQueue({ hot: ctx.hot, vectors: ctx.vectors, embed: null, record: ctx.record, dataDir: ctx.dataDir, log: ctx.log, now: ctx.now });
    const hours = ctx.hours ?? catchUpHoursOf(ctx);
    const found = await queue.coverage(ctx.guildId, { hours });
    lines.push(`coverage, last ${hours} h: ${found.messages} messages, ${found.indexed} indexed, ${found.missing} missing, oldest missing ${found.oldestMissing ?? 'none'}`);
  }
  return [...lines, ''].join('\n');
}

runCli(import.meta.url, (argv) => main(argv));
