#!/usr/bin/env node
// Operations tool: the persona's past before the live record started, from Discord's history.
// The live record (src/memory/record.js) begins on the day it was deployed; everything before it
// is only on Discord. This tool reads that history once and keeps it apart from what she lived:
//
//   1. her own historical messages become `said` lines and the messages she could have read
//      become `seen` lines of the record, both with `origin: 'backfill'`;
//   2. new interpretations of them (episodes, lessons) are reconstructions: archived with
//      `event: 'backfill'`, `recordedAt` the day they were made, `observedAt` the conversation's
//      day, `sourceRefs` the exact messages the model cited. Never hot memory, never a `felt` line:
//      a feeling she did not have then is not invented. The optional voice step words a
//      present-day reconstruction, stored as the archived episode's `feeling` with `reconstructedAt`.
//
//   cd /opt/neptunia/app && node tools/backfill.mjs <subcommand> [--guild <id>] [flags]
//
//   fetch    --since <day> [--until <day>] [--dry-run]
//            Reads every channel and thread the bot can read today over REST (no gateway, the bot
//            token from .env), pages each one forward through the range and appends its messages
//            through the record (slimmed by src/memory/update.js#slimMessage and
//            src/memory/record.js#toRecordLine). A per-channel cursor in
//            data/guilds/<id>/record/backfill.json moves only after a durable append (written and
//            fsynced); a later run starts with the last page again (one page of overlap) and the
//            record's id index refuses what is already there. Channels it cannot read are listed as
//            gaps. No model request. `--dry-run` lists the channels and writes nothing.
//   merge    --since <day> [--until <day>]
//            One chronological stream of the record's lines (live and backfill) for every month the
//            range touches: data/guilds/<id>/backfill/manifest-<YYYY-MM>.json (message ids in order
//            with their channel ids).
//   extract  --since <day> [--until <day>] --max-usd <n> --max-windows <n> --max-tokens <n>
//            [--pilot <day>] [--redo <day>] [--include-thin] [--window-max 120] [--usd-per-ktok 0.005] [--dry-run]
//            Windows of connected lines (tools/lib/backfill.mjs#windowsOf: reply chains and
//            `recall.clusterGapMinutes` gaps, at most `--window-max` lines), each sent with the
//            roster of its members (stored names and aliases only) and prompts/backfill.md to the
//            extractor model (`models.helpers.extractor`). The answers' items go to
//            data/guilds/<id>/backfill/candidates.jsonl (quotes checked against their message,
//            items citing a line outside the window dropped; tools/lib/backfill.mjs
//            #readExtractAnswer). The estimate is printed first; the run is refused (exit 2) when
//            it exceeds `--max-usd` or `--max-tokens`, and stops once the spent tokens or USD reach
//            them. Windows already extracted are never sent again; thin windows (few content
//            lines, no line by the persona, no question or mention) are skipped and counted.
//            `--pilot <day>`: only that day's windows, and the candidates are printed.
//            `--redo <day>`: only that day's windows, extracted again: that day's candidates and
//            done marks are removed first (once the estimate passes).
//            `--include-thin`: thin windows are sent too.
//            `--dry-run`: the window plan and the estimate, nothing written, nothing sent.
//   dedupe   Candidates against the hot episodes (the same moment, or the same member and the
//            same meaning) and the archive (a shared source message with an entry of the same
//            kind, or the same member or teacher and the same meaning); candidates that repeat
//            one another are merged; the rest are archived with stable item ids (`ep-bf-...`,
//            `ln-bf-...`), event `backfill`. Running it again archives nothing new.
//   voice    --spend <usd> [--min-weight 4]
//            For each archived backfill episode of at least `--min-weight`, not yet worded: a
//            present-day first-person reconstruction through the voice pass (prompts/memory-voice.md,
//            src/memory/voice.js#buildVoiceRequest), archived as a new line of the same item with
//            `feeling` and `reconstructedAt`. Its own spend gate (~0.05 USD per item).
//   report   [--since <day>] [--until <day>]
//            Per channel the lines recorded by the backfill, the gaps, windows, candidates,
//            archived items per kind, duplicates dropped, tokens and USD spent. Read only.
//   links    [--since <day>] [--until <day>] [--write]
//            Link previews for record lines written before the record kept them (`links`,
//            src/memory/record.js#recordLinks). The candidates are the newest revisions of the
//            range's messages whose text has a URL (not only a GIF site's) and that have no
//            `links` (tools/lib/backfill.mjs#linkCandidates). Each is fetched again over REST by
//            its id (no gateway, GET only, the bot token from .env; discord.js waits out the rate
//            limits), one at a time, grouped by channel; its links are built as the live record
//            builds them (interfaces/discord/collect.js#normalizeMessage, src/memory/update.js
//            #slimMessage, src/memory/record.js#toRecordLine). A message with a preview gets a new
//            revision (revision + 1, every other field of the newest revision, plus `links`:
//            tools/lib/backfill.mjs#linkRevision) through the record's append, so recall reads it.
//            The vector index (a row per `messageId:revision`) takes it only from
//            `embed-index.mjs build`: `--rebuild` for a month already indexed, `--include-live`
//            for a month the live queue manages (its catch-up reads only recent lines). A
//            deleted or unreachable message, or one with no preview, is skipped and counted. Dry
//            run by default (counts, nothing written); `--write` appends, with the bot stopped.
//            No model request. A rerun finds only the lines still without `links`.
//
// Before writing anything every subcommand but `report` (and a dry run) refuses while a forget is
// under way (a `forgetting/` marker) and re-applies the deletion ledger (src/memory/store.js
// #applyLedger) when data/ still holds something it takes out; while the bot runs (its journal's
// `.running` marker) that is refused instead, since a restart applies it. A forgotten member's
// messages from before their forget are never fetched back, and candidates naming them are
// dropped. Model requests go through the bot's client with its rails (the per-request token
// cap), marked `origin: 'backfill'`, never counted against `llm.maxRequestsPerDay`.
//
// `links --write` also refuses while the bot runs (its journal's `.running` marker): the running
// bot holds the record's id index in memory.
//
// Output: the report or summary on stdout; logs and estimates on stderr. `--pilot` and `report`
// print what members said and what the model made of it: for the owner's eyes on the server.
// `links` prints and logs counts only.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { simKey, CliError, REFUSED_EXIT, daysBetween, defaultDataDir, parseFlags, privateDirOf, resolveGuildId, runCli, spendGate } from './lib/cli.mjs';
import {
  WINDOW_MAX_LINES, advanceCursor, archiveItemOf, buildExtractRequest, candidateItemId, dedupeCandidates, estimate,
  DEDUPE_REASONS, ledgerDrops, linkCandidates, linkRevision, readExtractAnswer, rosterOf, snowflakeAt, windowsOf,
} from './lib/backfill.mjs';
import { isPlainObject } from '../src/config.js';
import { log as defaultLog } from '../src/log.js';
import { MEMORY_VOICE_REQUEST } from '../src/llm/openrouter.js';
import { roleModel } from '../src/llm/roles.js';
import { estimateTokens } from '../src/llm/tokens.js';
import { createAppendStore } from '../src/memory/append-store.js';
import { archiveDrops, archiveEntry, createArchive } from '../src/memory/archive.js';
import { clampText } from '../src/memory/clamp.js';
import { createJournal } from '../src/memory/journal.js';
import { createRecord, forgettingIds, recordDrops, toRecordLine } from '../src/memory/record.js';
import { createStore, readLedger, writeJsonAtomic } from '../src/memory/store.js';
import { analyzerTemperature, characterText, slimMessage } from '../src/memory/update.js';
import { FEELING_CHARS, buildVoiceRequest, parseVoiceAnswer, voiceSettings } from '../src/memory/voice.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE =
  'usage: node tools/backfill.mjs fetch --since <day> [--until <day>] [--guild <id>] [--dry-run]\n' +
  '       node tools/backfill.mjs merge --since <day> [--until <day>] [--guild <id>]\n' +
  '       node tools/backfill.mjs extract --since <day> [--until <day>] --max-usd <n> --max-windows <n> --max-tokens <n> [--pilot <day>] [--redo <day>] [--include-thin] [--window-max 120] [--usd-per-ktok 0.005] [--dry-run] [--guild <id>]\n' +
  '       node tools/backfill.mjs dedupe [--guild <id>]\n' +
  '       node tools/backfill.mjs voice --spend <usd> [--min-weight 4] [--guild <id>]\n' +
  '       node tools/backfill.mjs report [--since <day>] [--until <day>] [--guild <id>]\n' +
  '       node tools/backfill.mjs links [--since <day>] [--until <day>] [--write] [--guild <id>]   (cwd: the bot directory)';
const SUBCOMMANDS = ['fetch', 'merge', 'extract', 'dedupe', 'voice', 'report', 'links'];
const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Price of a thousand tokens on the analyzer model, for the estimate and the spend count (`--usd-per-ktok`). */
const DEFAULT_USD_PER_KTOK = 0.005;
/** The answer of one extract request, in tokens, as the estimate counts it. */
const EXTRACT_OUTPUT_TOKENS = 1500;
/** One voice reconstruction on the voice model, in USD, as the estimate counts it. */
const VOICE_USD_PER_ITEM = 0.05;
const DEFAULT_MIN_WEIGHT = 4;
/** Extract requests (and `links` fetches failing with `error`) in a row before the run stops. */
const MAX_FAILURES_IN_A_ROW = 3;
/** The reasons `links` skips a candidate for, in the order its summary lists them. */
const LINK_SKIPS = ['forgotten', 'deleted', 'no-channel', 'no-access', 'no-preview', 'error'];

/** A non-negative number from a flag, `fallback` when absent; a CliError otherwise. */
function numberFlag(value, fallback, { integer = false } = {}) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) throw new CliError(USAGE);
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

/** The parsed lines of a JSONL file (unreadable ones skipped), [] when missing. */
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const text of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!text.trim()) continue;
    try {
      out.push(JSON.parse(text));
    } catch {
      // a torn or hand-broken line: skipped
    }
  }
  return out;
}

const compareIds = (a, b) => {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Every month (`YYYY-MM`) from the month of `firstDay` to the month of `lastDay`. */
function monthsBetween(firstDay, lastDay) {
  const out = [];
  let [y, m] = firstDay.slice(0, 7).split('-').map(Number);
  const end = lastDay.slice(0, 7);
  for (;;) {
    const month = `${y}-${String(m).padStart(2, '0')}`;
    out.push(month);
    if (month >= end) return out;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
}

/** The options of interfaces/discord/collect.js#normalizeMessage the live gateway path passes, from the config. */
function normalizeOptions(config) {
  return { embedTextChars: config.media?.embedTextChars, videoSites: config.media?.video?.sites ?? [], maxUrlChars: config.context?.maxUrlChars };
}

/** Why a Discord REST fetch failed, as a `links` skip reason. */
function restSkipReason(err, what) {
  const code = Number(err?.code);
  const status = Number(err?.status);
  if (code === 10008) return 'deleted';
  if (code === 10003) return 'no-channel';
  if (code === 50001 || code === 50013 || status === 403) return 'no-access';
  if (status === 404) return what === 'message' ? 'deleted' : 'no-channel';
  return 'error';
}

/**
 * The Discord side of `links` over REST: no login, no gateway, GET only. The served guild and the
 * bot's own user, then one message by its channel and id, normalized as a live message is
 * (`{ status: 'ok', message }`), or the reason it cannot be read (`{ status }`: `deleted`,
 * `no-channel`, `no-access`, `error`). Each channel is fetched once.
 */
function restMessageSource({ root, token }) {
  return {
    async connect({ config, guildId }) {
      const discord = createRequire(path.join(root, 'package.json'))('discord.js');
      const { normalizeMessage } = await import('../src/interface/discord.js');
      const { Client, Routes } = discord;
      const client = new Client({ intents: [] });
      client.rest.setToken(token);
      const restRequest = client.rest.request.bind(client.rest);
      client.rest.request = (options) => {
        if (String(options?.method ?? 'GET').toUpperCase() !== 'GET') throw new Error('backfill: only GET requests reach Discord');
        return restRequest(options);
      };
      try {
        // The guild first: a channel fetched by id resolves only in a cached guild.
        await client.guilds.fetch(guildId);
        const me = await client.rest.get(Routes.user());
        const selfId = String(me.id);
        const options = normalizeOptions(config);
        const channels = new Map(); // id -> the channel, or { failed: reason }
        return {
          self: { id: selfId },
          async message(channelId, messageId) {
            if (!channels.has(channelId)) {
              try {
                const channel = await client.channels.fetch(channelId);
                channels.set(channelId, channel?.messages?.fetch ? channel : { failed: 'no-channel' });
              } catch (err) {
                channels.set(channelId, { failed: restSkipReason(err, 'channel') });
              }
            }
            const channel = channels.get(channelId);
            if (channel.failed) return { status: channel.failed };
            try {
              const message = await channel.messages.fetch({ message: messageId, cache: false, force: true });
              return message?.id === messageId ? { status: 'ok', message: normalizeMessage(message, selfId, options) } : { status: 'deleted' };
            } catch (err) {
              return { status: restSkipReason(err, 'message') };
            }
          },
          async close() {
            await client.destroy().catch(() => {});
          },
        };
      } catch (err) {
        await client.destroy().catch(() => {});
        throw err;
      }
    },
  };
}

/**
 * The Discord side of `fetch` over REST: no login, no gateway. The served guild, the bot's own
 * user and member, every channel and thread (active ones and archived public ones; archived
 * private ones when the bot may list them) with whether the bot can read it, and one page of a
 * channel's messages after an id, normalized as a live history is.
 */
function restSource({ root, token, log }) {
  return {
    async connect({ config, guildId }) {
      const discord = createRequire(path.join(root, 'package.json'))('discord.js');
      const { canRead, normalizeMessage } = await import('../src/interface/discord.js');
      const { Client, Routes } = discord;
      const client = new Client({ intents: [] });
      client.rest.setToken(token);
      try {
        const guild = await client.guilds.fetch(guildId);
        const fetched = await guild.channels.fetch();
        const me = await client.rest.get(Routes.user());
        try {
          client.user = new discord.ClientUser(client, me);
        } catch {
          // `guild.members.me` needs it; without it no channel reads as readable.
        }
        const member = await guild.members.fetch(me.id);
        const self = { id: String(me.id), name: member?.displayName ?? me.username ?? 'bot' };
        const all = [...fetched.values()].filter((channel) => channel && typeof channel.isTextBased === 'function' && channel.isTextBased());
        const threads = new Map();
        try {
          const active = await guild.channels.fetchActiveThreads();
          for (const thread of active.threads.values()) threads.set(thread.id, thread);
        } catch (err) {
          log.warn('backfill: active threads cannot be listed', { errorName: err?.name, statusCode: err?.status });
        }
        for (const parent of fetched.values()) {
          if (!parent?.threads?.fetchArchived) continue;
          for (const type of ['public', 'private']) {
            let before;
            for (;;) {
              let page;
              try {
                page = await parent.threads.fetchArchived({ type, before, limit: 100 });
              } catch {
                break; // private archived threads need Manage Threads; a channel without threads refuses
              }
              for (const thread of page.threads.values()) threads.set(thread.id, thread);
              if (!page.hasMore || page.threads.size === 0) break;
              before = [...page.threads.values()].at(-1);
            }
          }
        }
        const mirrorId = config.bot?.dryRunChannelId;
        const channels = [];
        const byId = new Map();
        for (const channel of [...all, ...threads.values()]) {
          if (byId.has(channel.id) || (mirrorId && channel.id === mirrorId)) continue;
          const parent = channel.isThread?.() ? channel.parent : null;
          byId.set(channel.id, channel);
          channels.push({ id: channel.id, name: channel.name ?? null, parentId: parent?.id ?? null, thread: Boolean(parent), readable: canRead(channel) });
        }
        const options = normalizeOptions(config);
        return {
          guildId,
          self,
          channels,
          async page(channelId, { after }) {
            const channel = byId.get(channelId);
            const raw = [...(await channel.messages.fetch({ limit: 100, after })).values()].sort((a, b) => compareIds(a.id, b.id));
            const kept = raw.filter((message) => !message.system && !message.webhookId);
            return {
              messages: kept.map((message) => normalizeMessage(message, self.id, options)),
              count: raw.length,
              lastId: raw.at(-1)?.id ?? null,
              lastTs: raw.at(-1)?.createdTimestamp ?? null,
              full: raw.length >= 100,
            };
          },
          async close() {
            await client.destroy().catch(() => {});
          },
        };
      } catch (err) {
        await client.destroy().catch(() => {});
        throw err;
      }
    },
  };
}

/** The tool's own view of data/: the record, the archive, a journal for the writer lock, the store. */
function openStores(dataDir, now, log) {
  const journalStore = createAppendStore({ log, now });
  const recordStore = createAppendStore({ log, now });
  const archiveStore = createAppendStore({ log, now });
  let journal = null;
  const writerGate = () => journal.waitUnlocked();
  const record = createRecord({ appendStore: recordStore, dataDir, log, now, writerGate });
  const archive = createArchive({ appendStore: archiveStore, dataDir, log, now, writerGate });
  journal = createJournal({ appendStore: journalStore, dataDir, config: () => ({}), now, log, lockStores: [recordStore, archiveStore] });
  const store = createStore({ dataDir });
  return {
    record, archive, journal, store, recordStore,
    async close() {
      await Promise.all([recordStore.close(), archiveStore.close(), journalStore.close()]);
    },
  };
}

/**
 * The whole tool: the subcommand's report (or a refusal, as a CliError).
 * @param {string[]} argv
 * @param {{ cwd?: string, now?: () => number, hot?: object, llmClient?: { complete: Function },
 *   source?: { connect: Function }, log?: object, rootDir?: string, uuid?: () => string }} [options]
 *   `hot` stands in for the live config and prompts, `llmClient` for the OpenRouter client,
 *   `source` for Discord (test fakes: `page` for `fetch`, `message` for `links`); the gates still
 *   apply. `uuid` makes the ids of the lines `links` appends.
 * @returns {Promise<string>}
 */
export async function main(argv, { cwd = process.cwd(), now = Date.now, hot: givenHot = null, llmClient = null, source = null, log = defaultLog, rootDir = ROOT, uuid = randomUUID } = {}) {
  const flags = parseFlags(argv, {
    values: ['--guild', '--since', '--until', '--max-usd', '--max-windows', '--max-tokens', '--pilot', '--redo', '--spend', '--min-weight', '--window-max', '--usd-per-ktok', '--data'],
    switches: ['--dry-run', '--include-thin', '--write'],
    usage: USAGE,
  });
  const sub = flags._[0];
  if (!SUBCOMMANDS.includes(sub) || flags._.length > 1) throw new CliError(USAGE);
  const dryRun = flags['--dry-run'] === true;
  if (dryRun && !['fetch', 'extract'].includes(sub)) throw new CliError(USAGE);

  let hot = givenHot;
  if (!hot) {
    const { createHot } = await import('../src/hot.js');
    hot = createHot({ rootDir, privateDir: privateDirOf(rootDir) });
  }
  const dataDir = flags['--data'] !== undefined ? path.resolve(cwd, flags['--data']) : defaultDataDir(cwd);
  const guildId = resolveGuildId(dataDir, flags['--guild'] ?? (hot.config.bot?.guildId || undefined));
  const today = new Date(now()).toISOString().slice(0, 10);
  const pilot = flags['--pilot'];
  const redo = flags['--redo'];
  for (const day of [pilot, redo]) if (day !== undefined && (sub !== 'extract' || !DAY_RE.test(day))) throw new CliError(USAGE);
  if (flags['--include-thin'] === true && sub !== 'extract') throw new CliError(USAGE);
  if (flags['--write'] === true && sub !== 'links') throw new CliError(USAGE);
  if (pilot !== undefined && redo !== undefined && pilot !== redo) throw new CliError(USAGE);
  const single = pilot ?? redo;
  const needsRange = ['fetch', 'merge', 'extract'].includes(sub);
  if (needsRange && !flags['--since'] && !single) throw new CliError(USAGE);
  const days = flags['--since'] || single ? daysBetween(flags['--since'] ?? single, flags['--until'] ?? (single && !flags['--since'] ? single : today), USAGE) : null;

  const guildDir = path.join(dataDir, 'guilds', guildId);
  const ctx = {
    flags, sub, dryRun, hot, dataDir, guildId, guildDir, days, now, log, llmClient, source, rootDir, pilot, redo, uuid,
    cursorFile: path.join(guildDir, 'record', 'backfill.json'),
    workDir: path.join(guildDir, 'backfill'),
  };
  ctx.candidatesFile = path.join(ctx.workDir, 'candidates.jsonl');
  ctx.stateFile = path.join(ctx.workDir, 'state.json');
  const stores = openStores(dataDir, now, log);
  Object.assign(ctx, stores);
  try {
    if (sub === 'fetch') return await cmdFetch(ctx);
    if (sub === 'merge') return await cmdMerge(ctx);
    if (sub === 'extract') return await cmdExtract(ctx);
    if (sub === 'dedupe') return await cmdDedupe(ctx);
    if (sub === 'voice') return await cmdVoice(ctx);
    if (sub === 'links') return await cmdLinks(ctx);
    return await cmdReport(ctx);
  } finally {
    await stores.close();
    if (!givenHot) hot.close?.();
  }
}

// ---- before any write: a forget under way stops it, the ledger is applied ----------------------

/** Whether the bot is running on this data/: its journal's `.running` marker (src/memory/journal.js#markRunning). */
function botRunning(ctx) {
  return fs.existsSync(path.join(ctx.guildDir, 'journal', '.running'));
}

/** Refuse while a forget is under way. */
async function refuseWhileForgetting(ctx) {
  const marked = await forgettingIds(fs.promises, ctx.dataDir, ctx.guildId);
  if (marked.size > 0) throw new CliError(`backfill: a forget is under way (${marked.size} forgetting marker(s)); run again once it has finished`);
}

/** The newest forget time of each member of the ledger (epoch ms). */
export function ledgerTimes(ledger) {
  const latest = new Map();
  for (const entry of ledger) {
    const at = Date.parse(entry?.at);
    const id = String(entry?.userId ?? '');
    if (id && Number.isFinite(at) && !(latest.get(id) >= at)) latest.set(id, at);
  }
  return latest;
}

/** Whether data/ still holds something the ledger takes out: an earlier profile, record line or archive entry of a forgotten member. */
export async function ledgerStale(ctx, latest) {
  for (const [id, at] of latest) {
    const profile = readJson(path.join(ctx.guildDir, 'users', `${id}.json`), null);
    if (isPlainObject(profile) && !(Date.parse(profile.firstSeen) >= at)) return true;
  }
  for await (const line of ctx.record.iterate(ctx.guildId)) {
    for (const [id, at] of latest) if (recordDrops(line, id, at)) return true;
  }
  for await (const entry of ctx.archive.iterate(ctx.guildId)) {
    for (const [id, at] of latest) if (archiveDrops(entry, id, at)) return true;
  }
  return false;
}

/**
 * The guard of every writing subcommand: refuse while a forget is under way, take the ledger's
 * members out of the tool's candidates, and apply the ledger to data/ when it still holds
 * something it takes out (refused while the bot runs: its start applies it).
 * @returns {Promise<{ userId: string, at: string }[]>}  The ledger.
 */
async function guard(ctx) {
  await refuseWhileForgetting(ctx);
  const ledger = readLedger(ctx.dataDir, ctx.guildId);
  if (ledger.length === 0) return ledger;
  const candidates = readJsonl(ctx.candidatesFile);
  const kept = candidates.filter((candidate) => !ledgerDrops(candidate, ledger));
  if (kept.length < candidates.length) {
    writeLines(ctx.candidatesFile, kept);
    ctx.log.info('backfill: candidates of forgotten members dropped', { guildId: ctx.guildId, dropped: candidates.length - kept.length });
  }
  if (!(await ledgerStale(ctx, ledgerTimes(ledger)))) return ledger;
  if (botRunning(ctx)) {
    throw new CliError('backfill: data/ still holds lines the deletion ledger takes out and the bot is running; restart the bot (its start applies the ledger), then run again');
  }
  const counts = await ctx.store.applyLedger(ctx.guildId, { journal: ctx.journal, record: ctx.record, archive: ctx.archive });
  ctx.store.flush();
  ctx.log.info('backfill: ledger applied', { guildId: ctx.guildId, ...counts });
  return ledger;
}

/** Rewrite a JSONL file whole (through a temp file and a rename). */
function writeLines(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, values.map((value) => `${JSON.stringify(value)}\n`).join(''));
  fs.renameSync(tmp, file);
}

function readState(ctx) {
  const state = readJson(ctx.stateFile, {});
  return isPlainObject(state) ? state : {};
}

function saveState(ctx, state) {
  fs.mkdirSync(ctx.workDir, { recursive: true });
  writeJsonAtomic(ctx.stateFile, state);
}

const rangeOf = (days) => ({ fromMs: Date.parse(`${days[0]}T00:00:00Z`), toMs: Date.parse(`${days.at(-1)}T00:00:00Z`) + DAY_MS - 1 });

// ---- fetch -------------------------------------------------------------------------------------

/** Append `lines` to the record and confirm them on disk: written, fsynced, nothing left for a retry. */
async function durableAppend(ctx, lines) {
  if (lines.length === 0) return { durable: true, written: 0, duplicates: 0 };
  const before = ctx.recordStore.stats();
  try {
    const { written, duplicates } = await ctx.record.append(ctx.guildId, lines);
    await ctx.recordStore.flush();
    const after = ctx.recordStore.stats();
    return { durable: after.pending === 0 && after.failed === before.failed, written, duplicates };
  } catch (err) {
    ctx.log.warn('backfill: record append failed', { guildId: ctx.guildId, code: err?.code ?? null });
    return { durable: false, written: 0, duplicates: 0 };
  }
}

async function cmdFetch(ctx) {
  const { days, now, log } = ctx;
  const { fromMs, toMs } = rangeOf(days);
  const until = days.at(-1);
  if (ctx.dryRun) await refuseWhileForgetting(ctx);
  const ledger = ctx.dryRun ? readLedger(ctx.dataDir, ctx.guildId) : await guard(ctx);
  const latest = ledgerTimes(ledger);
  let source = ctx.source;
  if (!source) {
    const { loadDotEnv } = await import('../src/config.js');
    loadDotEnv(privateDirOf(ctx.rootDir));
    if (!process.env.DISCORD_TOKEN) throw new CliError('backfill: DISCORD_TOKEN is not set (.env)');
    source = restSource({ root: ctx.rootDir, token: process.env.DISCORD_TOKEN, log });
  }
  const conn = await source.connect({ config: ctx.hot.config, guildId: ctx.guildId });
  try {
    const readable = conn.channels.filter((channel) => channel.readable);
    const gaps = conn.channels.filter((channel) => !channel.readable).map(({ id, name }) => ({ id, name: name ?? null }));
    if (ctx.dryRun) {
      return [
        `backfill fetch (dry run): ${days[0]}..${until}, nothing written`,
        `channels to read: ${readable.length}`,
        ...readable.map((channel) => `- ${channel.id} ${channel.name ?? ''}${channel.thread ? ' (thread)' : ''}`),
        `gaps (not readable): ${gaps.length}`,
        ...gaps.map((channel) => `- ${channel.id} ${channel.name ?? ''}`),
        '',
      ].join('\n');
    }
    const saved = readJson(ctx.cursorFile, {});
    const state = {
      ...(isPlainObject(saved) ? saved : {}),
      selfId: conn.self.id,
      selfName: conn.self.name,
      channels: { ...(isPlainObject(saved?.channels) ? saved.channels : {}), ...Object.fromEntries(conn.channels.map((channel) => [channel.id, channel.name ?? null])) },
      gaps,
    };
    let cursors = isPlainObject(saved?.cursors) ? saved.cursors : {};
    const totals = { channels: 0, pages: 0, written: 0, duplicates: 0, forgotten: 0 };
    const start = snowflakeAt(fromMs);
    const forgotten = (line) => [...latest].some(([id, at]) => recordDrops(line, id, at));
    for (const channel of readable) {
      const cursor = cursors[channel.id];
      if (cursor?.doneUntil && cursor.doneUntil >= until) continue;
      totals.channels += 1;
      let after = cursor?.resume && compareIds(cursor.resume, start) > 0 ? cursor.resume : start;
      for (;;) {
        // A forget started meanwhile: stop here; the next run applies the ledger first.
        await refuseWhileForgetting(ctx);
        const page = await conn.page(channel.id, { after });
        totals.pages += 1;
        const lines = [];
        for (const message of page.messages) {
          if (!(message.ts >= fromMs && message.ts <= toMs) || message.bot) continue;
          const line = toRecordLine(slimMessage(message, false), { kind: message.self ? 'said' : 'seen', origin: 'backfill', now });
          if (forgotten(line)) totals.forgotten += 1;
          else lines.push(line);
        }
        const newestTs = page.lastTs ?? page.messages.at(-1)?.ts ?? null;
        const reachedEnd = !page.full || !page.lastId || (Number.isFinite(newestTs) && newestTs > toMs);
        const outcome = await durableAppend(ctx, lines);
        const next = advanceCursor(cursors, channel.id, { after, lastId: page.lastId, reachedEnd, until }, outcome);
        if (next === cursors) {
          writeJsonAtomic(ctx.cursorFile, { ...state, cursors });
          throw new CliError(`backfill: the record did not confirm a page of channel ${channel.id}; the cursor stays before it, run again`);
        }
        cursors = next;
        totals.written += outcome.written;
        totals.duplicates += outcome.duplicates;
        writeJsonAtomic(ctx.cursorFile, { ...state, cursors });
        if (reachedEnd) break;
        after = page.lastId;
      }
    }
    writeJsonAtomic(ctx.cursorFile, { ...state, cursors, fetchedAt: new Date(now()).toISOString() });
    log.info('backfill: fetched', { guildId: ctx.guildId, ...totals, gaps: gaps.length });
    return [
      `backfill fetch: ${days[0]}..${until}`,
      `channels read: ${totals.channels} of ${readable.length} (the rest were done)`,
      `pages: ${totals.pages}`,
      `written: ${totals.written}`,
      `duplicates: ${totals.duplicates}`,
      `left out (forgotten members): ${totals.forgotten}`,
      `gaps (not readable): ${gaps.length}`,
      '',
    ].join('\n');
  } finally {
    await conn.close();
  }
}

// ---- merge -------------------------------------------------------------------------------------

/** The `seen` and `said` lines of the record from `fromIso` to `toIso`, the newest revision of each message. */
async function recordLines(ctx, fromIso, toIso) {
  const byId = new Map();
  for await (const line of ctx.record.iterate(ctx.guildId, { from: fromIso, to: toIso })) {
    if ((line.kind !== 'seen' && line.kind !== 'said') || typeof line.messageId !== 'string') continue;
    const held = byId.get(line.messageId);
    if (!held || (line.revision ?? 1) >= (held.revision ?? 1)) byId.set(line.messageId, line);
  }
  return byId;
}

async function cmdMerge(ctx) {
  const { days } = ctx;
  await guard(ctx);
  const months = monthsBetween(days[0], days.at(-1));
  fs.mkdirSync(ctx.workDir, { recursive: true });
  const out = [`backfill merge: ${months[0]}..${months.at(-1)}`];
  for (const month of months) {
    const from = `${month}-01T00:00:00.000Z`;
    const [y, m] = month.split('-').map(Number);
    const to = new Date(Date.UTC(y, m, 1) - 1).toISOString();
    const lines = [...(await recordLines(ctx, from, to)).values()].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || compareIds(a.messageId, b.messageId));
    writeJsonAtomic(path.join(ctx.workDir, `manifest-${month}.json`), {
      guildId: ctx.guildId,
      month,
      builtAt: new Date(ctx.now()).toISOString(),
      messages: lines.map((line) => ({ id: line.messageId, channelId: line.scope?.channel ?? null })),
    });
    out.push(`${month}: ${lines.length} messages`);
  }
  return `${out.join('\n')}\n`;
}

// ---- extract -----------------------------------------------------------------------------------

/** The stream of the range from the manifests, as record lines; a CliError when a month has no manifest. */
async function streamOf(ctx, days) {
  const { fromMs, toMs } = rangeOf(days);
  const lines = await recordLines(ctx, new Date(fromMs).toISOString(), new Date(toMs).toISOString());
  const stream = [];
  for (const month of monthsBetween(days[0], days.at(-1))) {
    const manifest = readJson(path.join(ctx.workDir, `manifest-${month}.json`), null);
    if (!isPlainObject(manifest) || !Array.isArray(manifest.messages)) throw new CliError(`backfill: no manifest for ${month}; run merge first`);
    for (const { id } of manifest.messages) {
      const line = lines.get(id);
      if (line) stream.push(line);
    }
  }
  return stream;
}

/** A member's stored names and alias names, for the roster. */
function namesOf(store, guildId) {
  return (id) => {
    const profile = store.getUser(guildId, id);
    if (!profile) return [];
    const aliases = (Array.isArray(profile.aliases) ? profile.aliases : []).map((alias) => (typeof alias === 'string' ? alias : alias?.name));
    return [...(Array.isArray(profile.names) ? profile.names : []), ...aliases];
  };
}

/** The persona's id and name: the fetch's, else the config's first name trigger. */
function selfOf(ctx) {
  const saved = readJson(ctx.cursorFile, {});
  return {
    selfId: typeof saved?.selfId === 'string' ? saved.selfId : null,
    selfName: typeof saved?.selfName === 'string' && saved.selfName ? saved.selfName : (ctx.hot.config.bot?.nameTriggers?.[0] ?? 'bot'),
    channels: isPlainObject(saved?.channels) ? saved.channels : {},
  };
}

/** The model client: the given fake, else the bot's OpenRouter client with private daily counters. */
async function modelClient(ctx) {
  if (ctx.llmClient) return ctx.llmClient;
  const { loadDotEnv } = await import('../src/config.js');
  loadDotEnv(privateDirOf(ctx.rootDir));
  const apiKey = simKey('backfill');
  const { createLlm } = await import('../src/llm/openrouter.js');
  const { createCalibrator } = await import('../src/llm/tokens.js');
  const stateData = ctx.store.state?.data ?? {};
  const calibrator = createCalibrator(stateData.calibration);
  const llmState = { data: { llmDay: stateData.llmDay, llmCount: stateData.llmCount }, markDirty() {} };
  return createLlm({ apiKey, getConfig: () => ctx.hot.config, calibrator, state: llmState });
}

/** The tokens a completion used: the provider's count, else `fallback`. */
function usedTokens(completion, fallback) {
  const usage = completion?.usage;
  const total = (Number(usage?.prompt_tokens) || 0) + (Number(usage?.completion_tokens) || 0);
  return total > 0 ? total : fallback;
}

async function cmdExtract(ctx) {
  const { flags, hot, log, now } = ctx;
  const config = hot.config;
  const windowMax = numberFlag(flags['--window-max'], WINDOW_MAX_LINES, { integer: true });
  const usdPerKTok = numberFlag(flags['--usd-per-ktok'], DEFAULT_USD_PER_KTOK);
  const maxWindows = numberFlag(flags['--max-windows'], null, { integer: true });
  const maxUsd = numberFlag(flags['--max-usd'], null);
  const maxTokens = numberFlag(flags['--max-tokens'], null, { integer: true });
  if (windowMax < 1) throw new CliError(USAGE);
  if (!ctx.dryRun && (maxWindows === null || maxUsd === null || maxTokens === null)) {
    throw new CliError(`backfill: extract needs --max-usd, --max-windows and --max-tokens (or --dry-run)\n${USAGE}`);
  }
  if (ctx.dryRun) await refuseWhileForgetting(ctx);
  else await guard(ctx);

  const days = ctx.pilot ? [ctx.pilot] : ctx.redo ? [ctx.redo] : ctx.days;
  const single = ctx.pilot ?? ctx.redo;
  const includeThin = flags['--include-thin'] === true;
  const stream = await streamOf(ctx, days);
  const windows = windowsOf(stream, { gapMinutes: config.recall?.clusterGapMinutes ?? 30, maxLines: windowMax }).filter((window) => !single || window.day === single);
  const state = readState(ctx);
  const redone = new Set(ctx.redo ? windows.map((window) => window.id) : []);
  const done = new Set((Array.isArray(state.extract?.done) ? state.extract.done : []).filter((id) => !redone.has(id)));
  const open = windows.filter((window) => !done.has(window.id));
  const thin = open.filter((window) => window.thin);
  const todo = includeThin ? open : open.filter((window) => !window.thin);
  const chosen = maxWindows === null ? todo : todo.slice(0, maxWindows);
  const { selfId, selfName, channels } = selfOf(ctx);
  const names = namesOf(ctx.store, ctx.guildId);
  const requests = chosen.map((window) => {
    const messages = buildExtractRequest({
      prompts: hot.prompts,
      selfName,
      selfId,
      window,
      roster: rosterOf(window, { selfId, selfName, namesOf: names }),
      channelName: channels[window.channelId] ?? null,
    });
    return { window, messages, tokens: estimateTokens(messages.map((message) => message.content).join('\n')) + EXTRACT_OUTPUT_TOKENS };
  });
  const planned = estimate(requests, (request) => request.tokens, usdPerKTok);
  const doneBefore = windows.length - open.length;
  const plan = [
    `backfill extract${ctx.dryRun ? ' (dry run, nothing written or sent)' : ''}: ${days[0]}..${days.at(-1)}${ctx.pilot ? ' (pilot)' : ''}${ctx.redo ? ` (redo ${ctx.redo})` : ''}`,
    `windows: ${planned.windows} (of ${windows.length}; ${doneBefore} done before${doneBefore > 0 ? ', --redo <day> extracts a day again' : ''}; thin: ${thin.length}, ${includeThin ? 'included' : 'skipped'})`,
    `estimate: ~${planned.tokens} tokens, ~${planned.usd.toFixed(2)} USD at ${usdPerKTok} USD per 1k tokens`,
  ];
  if (ctx.dryRun) {
    for (const { window, tokens } of requests) plan.push(`- ${window.id} ${window.day} ${channels[window.channelId] ?? window.channelId} lines=${window.lines.length} ~${tokens} tokens${window.thin ? ' thin' : ''}`);
    if (!includeThin) for (const window of thin) plan.push(`- ${window.id} ${window.day} ${channels[window.channelId] ?? window.channelId} lines=${window.lines.length} thin, skipped`);
    return `${plan.join('\n')}\n`;
  }
  process.stderr.write(`${plan.join('\n')}\n`);
  if (planned.usd > maxUsd || planned.tokens > maxTokens) {
    throw new CliError(`${plan.join('\n')}\nrefused: over --max-usd ${maxUsd} or --max-tokens ${maxTokens}; lower --max-windows or raise the limits`, { exitCode: REFUSED_EXIT });
  }
  const extractBefore = isPlainObject(state.extract) ? state.extract : {};
  const thinIds = new Set([...(Array.isArray(extractBefore.thin) ? extractBefore.thin : []), ...(includeThin ? [] : thin.map((window) => window.id))]);
  state.extract = { ...extractBefore, done: [...done], thin: [...thinIds] };
  if (ctx.redo) {
    const candidatesBefore = readJsonl(ctx.candidatesFile);
    const keptCandidates = candidatesBefore.filter((candidate) => candidate?.date !== ctx.redo);
    if (keptCandidates.length < candidatesBefore.length) writeLines(ctx.candidatesFile, keptCandidates);
    log.info('backfill: redo', { guildId: ctx.guildId, windows: redone.size, candidates: candidatesBefore.length - keptCandidates.length });
  }
  saveState(ctx, state);
  if (requests.length === 0) return `${plan.join('\n')}\ncandidates: 0\n`;

  const llm = await modelClient(ctx);
  const cfg = config.memory ?? {};
  const options = {
    model: roleModel(config, 'extractor', 'backfill'),
    role: 'extractor',
    purpose: 'backfill',
    origin: 'backfill',
    maxOutputTokens: cfg.maxOutputTokens,
    temperature: analyzerTemperature(config),
    timeoutMs: cfg.timeoutMs ?? config.llm?.timeoutMs,
    countAgainstDailyCap: false,
    skipCalibration: true,
    cache: false,
    ...(isPlainObject(cfg.reasoning) ? { reasoning: cfg.reasoning } : {}),
  };
  const spent = { windows: 0, tokens: 0, usd: 0, failed: 0 };
  const taken = { clamped: 0, quotesDropped: 0, outsideWindow: 0 };
  const printed = [];
  let candidates = 0;
  let inARow = 0;
  let stopped = null;
  const ledger = readLedger(ctx.dataDir, ctx.guildId);
  for (const { window, messages, tokens } of requests) {
    if (spent.usd >= maxUsd || spent.tokens >= maxTokens) {
      stopped = 'limit';
      break;
    }
    if ((await forgettingIds(fs.promises, ctx.dataDir, ctx.guildId)).size > 0) {
      stopped = 'forget';
      break;
    }
    let completion;
    try {
      completion = await llm.complete(messages, options);
    } catch (err) {
      spent.failed += 1;
      inARow += 1;
      log.warn('backfill: extract request failed', { guildId: ctx.guildId, errorName: err?.name ?? null });
      if (inARow >= MAX_FAILURES_IN_A_ROW) {
        stopped = 'failures';
        break;
      }
      continue;
    }
    inARow = 0;
    const used = usedTokens(completion, tokens);
    spent.windows += 1;
    spent.tokens += used;
    spent.usd = Math.round((spent.usd + (used / 1000) * usdPerKTok) * 1e6) / 1e6;
    // The persona's name forms, read now: her display name and the configured name triggers.
    const selfNames = [selfName, ...(Array.isArray(hot.config.bot?.nameTriggers) ? hot.config.bot.nameTriggers : [])];
    const answer = readExtractAnswer(completion?.text, { window, selfId, selfNames, clampTolerance: cfg.clampTolerance, learnedChars: cfg.learnedChars });
    for (const key of Object.keys(taken)) taken[key] += answer.counts[key];
    const found = answer.candidates.filter((candidate) => !ledgerDrops(candidate, ledger));
    if (found.length > 0) {
      fs.mkdirSync(ctx.workDir, { recursive: true });
      fs.appendFileSync(ctx.candidatesFile, found.map((candidate) => `${JSON.stringify(candidate)}\n`).join(''));
    }
    candidates += found.length;
    if (ctx.pilot) printed.push(...found);
    done.add(window.id);
    thinIds.delete(window.id);
    const extract = isPlainObject(state.extract) ? state.extract : {};
    state.extract = {
      ...extract,
      done: [...done],
      thin: [...thinIds],
      windows: (extract.windows ?? 0) + 1,
      candidates: (extract.candidates ?? 0) + found.length,
      clamped: (extract.clamped ?? 0) + answer.counts.clamped,
      quotesDropped: (extract.quotesDropped ?? 0) + answer.counts.quotesDropped,
      outsideWindow: (extract.outsideWindow ?? 0) + answer.counts.outsideWindow,
      tokens: (extract.tokens ?? 0) + used,
      usd: Math.round(((extract.usd ?? 0) + (used / 1000) * usdPerKTok) * 1e6) / 1e6,
      at: new Date(now()).toISOString(),
    };
    saveState(ctx, state);
  }
  if (taken.clamped > 0) log.info('backfill: clamped', { guildId: ctx.guildId, count: taken.clamped });
  if (taken.quotesDropped > 0) log.info('backfill: quotes dropped', { guildId: ctx.guildId, count: taken.quotesDropped });
  if (taken.outsideWindow > 0) log.info('backfill: candidates dropped', { guildId: ctx.guildId, reason: 'outside-window', count: taken.outsideWindow });
  log.info('backfill: extracted', { guildId: ctx.guildId, windows: spent.windows, candidates, tokens: spent.tokens, failed: spent.failed, stopped, thin: includeThin ? 0 : thin.length });
  return [
    `backfill extract: windows sent: ${spent.windows}, failed: ${spent.failed}${stopped ? `, stopped: ${stopped}` : ''}, thin skipped: ${includeThin ? 0 : thin.length}`,
    `candidates: ${candidates}`,
    `clamped (a what cut mid-sentence): ${taken.clamped}, quotes dropped (not in their message): ${taken.quotesDropped}, items dropped (a source outside the window): ${taken.outsideWindow}`,
    `spent: ~${spent.tokens} tokens, ~${spent.usd.toFixed(2)} USD`,
    ...printed.map((candidate) => JSON.stringify(candidate)),
    '',
  ].join('\n');
}

// ---- dedupe ------------------------------------------------------------------------------------

/** What each dedupe rule means, for the summary and the report. */
const DEDUPE_LABELS = Object.freeze({
  hot: 'same moment as a hot episode',
  'hot-similar': 'same meaning as a hot episode',
  archive: 'sources already archived',
  'archive-similar': 'same meaning as an archived item',
  repeat: 'merged (shared sources or the same moment)',
  similar: 'merged (same meaning)',
});

/** The per-rule counts of a dedupe, one phrase each. */
const dedupeLine = (counts) => DEDUPE_REASONS.map((reason) => `${DEDUPE_LABELS[reason]} ${counts?.[reason] ?? 0}`).join(', ');

async function cmdDedupe(ctx) {
  const { now, log } = ctx;
  const ledger = await guard(ctx);
  const candidates = readJsonl(ctx.candidatesFile).filter((candidate) => !ledgerDrops(candidate, ledger));
  const hotEpisodes = ctx.store.listUserProfiles(ctx.guildId).flatMap((profile) => (Array.isArray(profile.episodes) ? profile.episodes : []).map((episode) => ({ ...episode, userId: profile.id })));
  const archived = [];
  for await (const entry of ctx.archive.iterate(ctx.guildId)) archived.push({ itemKind: entry.itemKind, sourceRefs: entry.sourceRefs, scope: entry.scope, text: entry.text, stored: entry.stored });
  const { kept, dropped } = dedupeCandidates(candidates, { hotEpisodes, archived });
  const entries = kept.map((candidate) => {
    const { item, itemKind, scope, participants } = archiveItemOf(candidate);
    return archiveEntry(item, { itemKind, event: 'backfill', scope, origin: 'backfill', by: 'backfill', now, participants });
  });
  const { written, duplicates } = entries.length > 0 ? await ctx.archive.append(ctx.guildId, entries) : { written: 0, duplicates: 0 };
  const reasons = Object.fromEntries(DEDUPE_REASONS.map((reason) => [reason, 0]));
  for (const { reason } of dropped) reasons[reason] += 1;
  const state = readState(ctx);
  const before = isPlainObject(state.dedupe) ? state.dedupe : {};
  state.dedupe = {
    at: new Date(now()).toISOString(),
    candidates: candidates.length,
    archived: (before.archived ?? 0) + written,
    dropped: { ...reasons, index: duplicates },
  };
  saveState(ctx, state);
  log.info('backfill: deduped', { guildId: ctx.guildId, candidates: candidates.length, archived: written, ...reasons });
  return [
    `backfill dedupe: candidates: ${candidates.length}`,
    `archived: ${written}`,
    `dropped: ${dedupeLine(reasons)}, already in the index ${duplicates}`,
    '',
  ].join('\n');
}

// ---- voice -------------------------------------------------------------------------------------

/** The archived backfill episodes by item id: the newest line of each and whether one carries a feeling. */
async function backfillEpisodes(ctx) {
  const items = new Map();
  for await (const entry of ctx.archive.iterate(ctx.guildId, { kinds: ['episode'] })) {
    if (entry.origin !== 'backfill' || entry.event !== 'backfill' || typeof entry.itemId !== 'string') continue;
    const held = items.get(entry.itemId) ?? { entry, voiced: false };
    held.entry = entry;
    if (typeof entry.text?.feeling === 'string' && entry.text.feeling.trim()) held.voiced = true;
    items.set(entry.itemId, held);
  }
  return items;
}

async function cmdVoice(ctx) {
  const { flags, hot, now, log } = ctx;
  const config = hot.config;
  const minWeight = numberFlag(flags['--min-weight'], DEFAULT_MIN_WEIGHT);
  const ledger = await guard(ctx);
  const briefs = new Map();
  for (const candidate of readJsonl(ctx.candidatesFile)) {
    if (candidate?.kind === 'episode' && !ledgerDrops(candidate, ledger)) briefs.set(candidateItemId(candidate), candidate.brief ?? '');
  }
  const due = [...(await backfillEpisodes(ctx)).values()].filter(({ entry, voiced }) => !voiced && (entry.weight ?? 3) >= minWeight && typeof entry.scope?.user === 'string').map(({ entry }) => entry);
  const settings = voiceSettings(config);
  const requests = Math.ceil(due.length / Math.max(1, settings.maxItems));
  const gate = spendGate({ estimateUsd: due.length * VOICE_USD_PER_ITEM, requests, spend: flags['--spend'], detail: `${due.length} episode(s) at weight ${minWeight} or more, ~${VOICE_USD_PER_ITEM} USD each` });
  if (!gate.ok) throw new CliError(`backfill: ${gate.text}`, { exitCode: REFUSED_EXIT });
  process.stderr.write(`backfill: ${gate.text}\n`);
  if (due.length === 0) return 'backfill voice: nothing to word\n';

  const llm = await modelClient(ctx);
  const { createCalibrator } = await import('../src/llm/tokens.js');
  const calibrator = createCalibrator(ctx.store.state?.data?.calibration);
  const { selfName } = selfOf(ctx);
  const names = namesOf(ctx.store, ctx.guildId);
  const nameOf = (id) => names(id)[0] ?? null;
  const timeoutMs = config.memory?.voice?.timeoutMs;
  const options = {
    ...MEMORY_VOICE_REQUEST,
    origin: 'backfill',
    maxOutputTokens: settings.maxOutputTokens,
    temperature: analyzerTemperature(config),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000,
    countAgainstDailyCap: false,
    skipCalibration: true,
  };
  const byId = new Map(due.map((entry) => [entry.itemId, entry]));
  let pending = due.map((entry) => ({
    id: entry.itemId,
    kind: 'feeling',
    userId: entry.scope.user,
    payload: { what: entry.text?.what ?? '', quote: entry.text?.quote ?? '' },
    brief: briefs.get(entry.itemId) || (entry.text?.what ?? ''),
  }));
  const usage = { requests: 0, tokens: 0, worded: 0 };
  const reconstructedAt = new Date(now()).toISOString();
  while (pending.length > 0 && usage.requests < requests * 2) {
    const batch = pending.slice(0, settings.maxItems);
    const request = buildVoiceRequest({ prompts: hot.prompts, config, calibrator, items: batch, selfName, character: characterText(hot.prompts, selfName), nameOf });
    if (request.sent.length === 0) break;
    usage.requests += 1;
    let worded = new Map();
    try {
      const completion = await llm.complete(request.messages, options);
      usage.tokens += usedTokens(completion, 0);
      worded = parseVoiceAnswer(completion?.text, request.sent);
    } catch (err) {
      log.warn('backfill: voice request failed', { guildId: ctx.guildId, errorName: err?.name ?? null });
    }
    const entries = [];
    for (const [itemId, text] of worded) {
      const entry = byId.get(itemId);
      const feeling = clampText(text, FEELING_CHARS, { tolerance: config.memory?.clampTolerance ?? 1.25 });
      if (!entry || !feeling) continue;
      const item = { ...entry.stored, itemId, what: entry.text?.what ?? '', quote: entry.text?.quote ?? '', feeling, reconstructedAt, ...(Number.isFinite(entry.weight) ? { weight: entry.weight } : {}) };
      entries.push(archiveEntry(item, { itemKind: 'episode', event: 'backfill', scope: entry.scope, origin: 'backfill', by: 'backfill', now, participants: entry.participants, sourceRefs: entry.sourceRefs }));
    }
    if (entries.length > 0) usage.worded += (await ctx.archive.append(ctx.guildId, entries)).written;
    const sent = new Set(request.sent);
    pending = pending.filter((item) => !sent.has(item.id));
  }
  const state = readState(ctx);
  const before = isPlainObject(state.voice) ? state.voice : {};
  state.voice = { at: reconstructedAt, requests: (before.requests ?? 0) + usage.requests, tokens: (before.tokens ?? 0) + usage.tokens, worded: (before.worded ?? 0) + usage.worded };
  saveState(ctx, state);
  log.info('backfill: voiced', { guildId: ctx.guildId, ...usage });
  return `backfill voice: requests: ${usage.requests}, worded: ${usage.worded} of ${due.length}, tokens: ${usage.tokens}\n`;
}

// ---- report ------------------------------------------------------------------------------------

async function cmdReport(ctx) {
  const saved = readJson(ctx.cursorFile, {});
  const names = isPlainObject(saved?.channels) ? saved.channels : {};
  const query = ctx.days ? { from: new Date(rangeOf(ctx.days).fromMs).toISOString(), to: new Date(rangeOf(ctx.days).toMs).toISOString() } : {};
  const perChannel = new Map();
  for await (const line of ctx.record.iterate(ctx.guildId, query)) {
    if (line.origin !== 'backfill' || (line.kind !== 'seen' && line.kind !== 'said')) continue;
    const channel = line.scope?.channel ?? 'none';
    const row = perChannel.get(channel) ?? { seen: 0, said: 0 };
    row[line.kind] += 1;
    perChannel.set(channel, row);
  }
  const archivedKinds = {};
  let voiced = 0;
  const seenItems = new Set();
  for await (const entry of ctx.archive.iterate(ctx.guildId)) {
    if (entry.origin !== 'backfill' || entry.event !== 'backfill') continue;
    if (!seenItems.has(entry.itemId)) {
      seenItems.add(entry.itemId);
      archivedKinds[entry.itemKind] = (archivedKinds[entry.itemKind] ?? 0) + 1;
    }
    if (typeof entry.text?.feeling === 'string' && entry.text.feeling.trim()) voiced += 1;
  }
  const state = readState(ctx);
  const extract = isPlainObject(state.extract) ? state.extract : {};
  const voice = isPlainObject(state.voice) ? state.voice : {};
  const dropped = state.dedupe?.dropped ?? {};
  const doneIds = new Set(Array.isArray(extract.done) ? extract.done : []);
  const thinSkipped = (Array.isArray(extract.thin) ? extract.thin : []).filter((id) => !doneIds.has(id)).length;
  const gaps = Array.isArray(saved?.gaps) ? saved.gaps : [];
  const label = (id) => `${names[id] ?? '?'} (${id})`;
  const out = [
    `# Backfill report${ctx.days ? `: ${ctx.days[0]}..${ctx.days.at(-1)}` : ''}`,
    '',
    '## Messages recorded by the backfill',
    '',
    '| Channel | Seen | Said |',
    '|---|---|---|',
    ...[...perChannel].map(([id, row]) => `| ${label(id)} | ${row.seen} | ${row.said} |`),
    '',
    `## Gaps (channels the bot cannot read): ${gaps.length}`,
    '',
    ...gaps.map((gap) => `- ${gap.name ?? '?'} (${gap.id})`),
    '',
    '## Extraction',
    '',
    `- windows extracted: ${extract.windows ?? 0}; thin windows skipped: ${thinSkipped}`,
    `- candidates: ${readJsonl(ctx.candidatesFile).length}; a what cut mid-sentence: ${extract.clamped ?? 0}; quotes dropped: ${extract.quotesDropped ?? 0}; items dropped for a source outside the window: ${extract.outsideWindow ?? 0}`,
    `- archived: ${Object.entries(archivedKinds).map(([kind, n]) => `${kind} ${n}`).join(', ') || 'none'}; with a reconstructed feeling: ${voiced}`,
    `- duplicates dropped: ${dedupeLine(dropped)}, already in the index ${dropped.index ?? 0}`,
    `- extract: ~${extract.tokens ?? 0} tokens, ~${(extract.usd ?? 0).toFixed(2)} USD`,
    `- voice: ${voice.requests ?? 0} request(s), ~${voice.tokens ?? 0} tokens, ~${((Number.isFinite(voice.worded) ? voice.worded : 0) * VOICE_USD_PER_ITEM).toFixed(2)} USD estimated`,
    '',
  ];
  return out.join('\n');
}

// ---- links -------------------------------------------------------------------------------------

/** The `links` of a fetched message exactly as the live record builds them, [] when it has no preview. */
function liveLinks(normalized, now) {
  return toRecordLine(slimMessage(normalized, false), { now }).links ?? [];
}

async function cmdLinks(ctx) {
  const { flags, now, log } = ctx;
  const write = flags['--write'] === true;
  for (const day of [flags['--since'], flags['--until']]) if (day !== undefined && !DAY_RE.test(day)) throw new CliError(USAGE);
  await refuseWhileForgetting(ctx);
  if (write && botRunning(ctx)) {
    throw new CliError("backfill: the bot is running (the journal's .running marker); stop it first: sudo systemctl stop neptunia-bot");
  }
  const ledger = write ? await guard(ctx) : readLedger(ctx.dataDir, ctx.guildId);
  const latest = ledgerTimes(ledger);
  const from = flags['--since'] ? `${flags['--since']}T00:00:00.000Z` : null;
  const to = flags['--until'] ? new Date(Date.parse(`${flags['--until']}T00:00:00Z`) + DAY_MS - 1).toISOString() : null;
  const range = `${flags['--since'] ?? 'start'}..${flags['--until'] ?? 'now'}`;

  const lines = [];
  for await (const line of ctx.record.iterate(ctx.guildId, { from, to })) lines.push(line);
  const { candidates, counts } = linkCandidates(lines);
  const skipped = Object.fromEntries(LINK_SKIPS.map((reason) => [reason, 0]));
  const totals = { fetched: 0, withPreview: 0, toAppend: 0, appended: 0, duplicates: 0, stopped: null };
  const forgotten = (line) => [...latest].some(([id, at]) => recordDrops(line, id, at));
  const asked = candidates.filter((line) => {
    if (!forgotten(line)) return true;
    skipped.forgotten += 1;
    return false;
  });

  if (asked.length > 0) {
    let source = ctx.source;
    if (!source) {
      const { loadDotEnv } = await import('../src/config.js');
      loadDotEnv(privateDirOf(ctx.rootDir));
      if (!process.env.DISCORD_TOKEN) throw new CliError('backfill: DISCORD_TOKEN is not set (.env)');
      source = restMessageSource({ root: ctx.rootDir, token: process.env.DISCORD_TOKEN });
    }
    const conn = await source.connect({ config: ctx.hot.config, guildId: ctx.guildId });
    try {
      const byChannel = new Map();
      for (const line of asked) {
        const channelId = String(line.scope?.channel ?? '');
        if (!byChannel.has(channelId)) byChannel.set(channelId, []);
        byChannel.get(channelId).push(line);
      }
      let errorsInRow = 0;
      for (const [channelId, group] of byChannel) {
        if (totals.stopped) break;
        // A forget started meanwhile: stop here; the next run applies the ledger first.
        await refuseWhileForgetting(ctx);
        const revisions = [];
        for (const line of group) {
          if (!channelId) {
            skipped['no-channel'] += 1;
            continue;
          }
          const got = await conn.message(channelId, line.messageId);
          if (got?.status !== 'ok') {
            const reason = LINK_SKIPS.includes(got?.status) ? got.status : 'error';
            skipped[reason] += 1;
            errorsInRow = reason === 'error' ? errorsInRow + 1 : 0;
            if (errorsInRow >= MAX_FAILURES_IN_A_ROW) {
              totals.stopped = 'errors-in-a-row';
              break;
            }
            continue;
          }
          errorsInRow = 0;
          totals.fetched += 1;
          const links = liveLinks(got.message, now);
          if (links.length === 0) {
            skipped['no-preview'] += 1;
            continue;
          }
          totals.withPreview += 1;
          revisions.push(linkRevision(line, links, { id: ctx.uuid(), recordedAt: new Date(now()).toISOString() }));
        }
        totals.toAppend += revisions.length;
        if (!write || revisions.length === 0) continue;
        const outcome = await durableAppend(ctx, revisions);
        if (!outcome.durable) throw new CliError(`backfill: the record did not confirm the link revisions of channel ${channelId}; run again (the lines already appended are not fetched twice)`);
        totals.appended += outcome.written;
        totals.duplicates += outcome.duplicates;
      }
    } finally {
      await conn.close();
    }
  }

  log.info('backfill: links', { guildId: ctx.guildId, write, ...counts, ...totals, skipped });
  return [
    `backfill links${write ? '' : ' (dry run: nothing written)'}: ${range}`,
    `record messages: ${counts.messages} (deleted ${counts.deleted}, already with links ${counts.withLinks}, GIF links only ${counts.gifOnly})`,
    `candidates: ${counts.candidates}`,
    `fetched: ${totals.fetched}`,
    `with links: ${totals.withPreview}`,
    `skipped: ${LINK_SKIPS.map((reason) => `${reason} ${skipped[reason]}`).join(', ')}`,
    write ? `appended: ${totals.appended} (duplicates ${totals.duplicates})` : `lines to append: ${totals.toAppend}`,
    ...(totals.stopped ? [`stopped: ${totals.stopped} (run again to go on)`] : []),
    '',
  ].join('\n');
}

runCli(import.meta.url, (argv) => main(argv));
