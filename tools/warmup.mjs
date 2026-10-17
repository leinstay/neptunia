#!/usr/bin/env node
// Operations tool: the memory warmup (src/memory/warmup.js), run with the bot stopped. It builds the
// persona's memory of a server from a sample of recent history, in the engine's own order --
// channels, then people, then the server notes and lore -- with the same engine functions, the
// same prompts and config (read live from the checkout) and the same progress in state.json
// (`state.warmup`), so a run stopped here resumes here, and the bot's later refreshes (portraits,
// notes) start from what it wrote.
//
//   cd /opt/neptunia-bot && node tools/warmup.mjs <subcommand> [--guild <id>] [flags]
//
//   run       [--spend <usd>] [--max-usd <n>] [--dry-run]
//             The whole warmup: every readable channel, every qualifying member and the server
//             notes its progress has not done yet. Resumable: run it again after a stop.
//   users     [--user <id>] [--spend <usd>] [--max-usd <n>] [--dry-run]
//             (Re)profile that member, or every qualifying member, whatever the progress says.
//   channels  [--channel <id>] [--spend <usd>] [--max-usd <n>] [--dry-run]
//             (Re)describe that channel, or every readable channel.
//   server    [--spend <usd>] [--max-usd <n>] [--dry-run]
//             (Re)build the server notes and lore.
//   people    Who qualifies for the sample now (reads Discord, sends nothing, writes nothing).
//   status    Phase, progress and tokens used, from state.json (no Discord, no model).
//   reset     Clears the warmup progress (`state.warmup`), never the memory it wrote.
//
// Spending: the subcommands that send model requests (run, users, channels, server) print the plan
// and the estimate first -- every request at `warmup.maxRequestTokens`, within what is left of
// `warmup.maxTokens` and within `--max-usd`, priced at `--usd-per-ktok` (0.005 by default) -- and
// refuse (exit 2) unless `--spend <usd>` covers it. The run then goes under that estimate as its
// token budget: it stops there (resumable, `aborted: budget`), never past it. `--dry-run` prints the
// plan and the estimate and sends nothing. Requests keep the client's rails and the warmup's own
// (its per-request cap, the rate-limit waits, three failures in a row) and never count against
// `llm.maxRequestsPerDay`. Ctrl+C stops the run after cancelling the request in flight; progress
// is kept.
//
// Safety: run, users, channels, server and reset refuse while the bot runs on this data/ (its
// journal's `.running` marker): `sudo systemctl stop neptunia-bot` first. The spending subcommands
// also refuse while a forget is under way and re-apply the deletion ledger first when data/ still
// holds something it takes out. Discord is read over REST (the bot token from .env, no gateway);
// nothing is posted. The store is flushed (archive copies settled) before the tool exits.
//
// Output: the result and the status on stdout; logs, the plan and the estimate on stderr. `people`
// and a member's run print names and the start of a portrait: for the owner's eyes on the server.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { simKey, CliError, REFUSED_EXIT, defaultDataDir, privateDirOf, resolveGuildId, runCli, spendGate } from './lib/cli.mjs';
import {
  SPENDING_SUBCOMMANDS, assertBotStopped, channelWrittenText, formatPeople, formatStatus, formatUserWritten, parseWarmupArgs, serverWrittenText, warmupEstimate, warmupPlan,
} from './lib/warmup.mjs';
import { ledgerStale, ledgerTimes } from './backfill.mjs';
import { readableChannels } from '../src/interface/discord.js';
import { log as defaultLog } from '../src/log.js';
import { createAppendStore } from '../src/memory/append-store.js';
import { createArchive } from '../src/memory/archive.js';
import { createJournal } from '../src/memory/journal.js';
import { createRecord, forgettingIds } from '../src/memory/record.js';
import { createStore, readLedger } from '../src/memory/store.js';
import { createWarmup } from '../src/memory/warmup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A model client for the subcommands that send nothing: any call is a bug. */
const NO_MODEL = Object.freeze({
  complete: async () => {
    throw new Error('warmup: this subcommand sends no model request');
  },
});

/**
 * The tool's view of data/: the store as the bot builds it (dropped items copied to the archive
 * while `features.archive` is exactly true, read at each write), plus the record, the archive and
 * a journal for the deletion ledger.
 */
function openStores(dataDir, hot, now, log) {
  const journalStore = createAppendStore({ log, now });
  const recordStore = createAppendStore({ log, now });
  const archiveStore = createAppendStore({ log, now });
  let journal = null;
  const writerGate = () => journal.waitUnlocked();
  const record = createRecord({ appendStore: recordStore, dataDir, log, now, writerGate });
  const archive = createArchive({ appendStore: archiveStore, dataDir, log, now, writerGate });
  journal = createJournal({ appendStore: journalStore, dataDir, config: () => ({}), now, log, lockStores: [recordStore, archiveStore] });
  const store = createStore({ dataDir, archive, archiveOn: () => hot.config.features?.archive === true });
  return {
    record, archive, journal, store,
    async close() {
      await Promise.all([recordStore.close(), archiveStore.close(), journalStore.close()]);
    },
  };
}

/**
 * Discord over REST, no gateway: the served guild with its channels, the bot's own user and member
 * (what `readableChannels` checks permissions against), as the live client would hold them.
 * `close` destroys the client so the process can end.
 */
async function connectDiscord({ rootDir, guildId }) {
  const { loadDotEnv } = await import('../src/config.js');
  loadDotEnv(privateDirOf(rootDir));
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new CliError('warmup: DISCORD_TOKEN is not set (.env)');
  const discord = createRequire(path.join(rootDir, 'package.json'))('discord.js');
  const client = new discord.Client({ intents: [] });
  client.rest.setToken(token);
  try {
    const guild = await client.guilds.fetch(guildId);
    await guild.channels.fetch();
    const me = await client.rest.get(discord.Routes.user());
    client.user = new discord.ClientUser(client, me);
    const member = await guild.members.fetch(me.id);
    return {
      client,
      guild,
      selfName: member?.displayName ?? me.username ?? 'bot',
      async close() {
        await client.destroy().catch(() => {});
      },
    };
  } catch (err) {
    await client.destroy().catch(() => {});
    throw err;
  }
}

/** The bot's OpenRouter client with private daily counters (the warmup never counts against them). */
async function modelClient(ctx) {
  if (ctx.llmClient) return ctx.llmClient;
  const { loadDotEnv } = await import('../src/config.js');
  loadDotEnv(privateDirOf(ctx.rootDir));
  const apiKey = simKey('warmup');
  const { createLlm } = await import('../src/llm/openrouter.js');
  const stateData = ctx.store.state?.data ?? {};
  const llmState = { data: { llmDay: stateData.llmDay, llmCount: stateData.llmCount }, markDirty() {} };
  return createLlm({ apiKey, getConfig: () => ctx.hot.config, calibrator: ctx.calibrator, state: llmState });
}

/**
 * The live hot view the engine reads, with `warmup.maxTokens` lowered to `limits.ceiling` once the
 * estimate is accepted (never raised: the ceiling is at most the configured budget).
 */
function cappedHot(hot, limits) {
  return {
    get config() {
      const config = hot.config;
      if (!Number.isFinite(limits.ceiling)) return config;
      return { ...config, warmup: { ...(config.warmup ?? {}), maxTokens: limits.ceiling } };
    },
    get prompts() {
      return hot.prompts;
    },
  };
}

/** What the progress marks done, read after `summary()` (which heals a foreign or missing shape to nothing done). */
function doneOf(store, summary) {
  const nothing = summary.doneChannels === 0 && summary.donePeople === 0 && !summary.doneServer;
  const done = store.state.data.warmup?.done;
  if (nothing || !done || typeof done !== 'object') return { channels: [], people: [], server: false };
  return {
    channels: Array.isArray(done.channels) ? done.channels.map(String) : [],
    people: Array.isArray(done.people) ? done.people.map(String) : [],
    server: done.server === true,
  };
}

/** Refuse while a forget is under way; apply the deletion ledger when data/ still holds something it takes out. */
async function guard(ctx) {
  const marked = await forgettingIds(fs.promises, ctx.dataDir, ctx.guildId);
  if (marked.size > 0) throw new CliError(`warmup: a forget is under way (${marked.size} forgetting marker(s)); run again once it has finished`);
  const ledger = readLedger(ctx.dataDir, ctx.guildId);
  if (ledger.length === 0 || !(await ledgerStale(ctx, ledgerTimes(ledger)))) return;
  const counts = await ctx.store.applyLedger(ctx.guildId, { journal: ctx.journal, record: ctx.record, archive: ctx.archive });
  ctx.store.flush();
  ctx.log.info('warmup: ledger applied', { guildId: ctx.guildId, ...counts });
}

/**
 * The whole tool: the subcommand's report (or a refusal, as a CliError).
 * @param {string[]} argv
 * @param {{ cwd?: string, now?: () => number, hot?: object, llmClient?: { complete: Function },
 *   connect?: (input: { rootDir: string, guildId: string }) => Promise<object>, log?: object,
 *   rootDir?: string }} [options]  `hot`, `llmClient` and `connect` stand in for the live config
 *   and prompts, the OpenRouter client and Discord (test fakes); the gates still apply.
 * @returns {Promise<string>}
 */
export async function main(argv, { cwd = process.cwd(), now = Date.now, hot: givenHot = null, llmClient = null, connect = connectDiscord, log = defaultLog, rootDir = ROOT } = {}) {
  const args = parseWarmupArgs(argv);
  let hot = givenHot;
  if (!hot) {
    const { createHot } = await import('../src/hot.js');
    hot = createHot({ rootDir, privateDir: privateDirOf(rootDir) });
  }
  try {
    const dataDir = args.data !== undefined ? path.resolve(cwd, args.data) : defaultDataDir(cwd);
    const guildId = resolveGuildId(dataDir, args.guildId ?? (hot.config.bot?.guildId || undefined));
    const guildDir = path.join(dataDir, 'guilds', guildId);
    // What writes under data/: reset, and a spending subcommand that is not a dry run.
    const writes = args.sub === 'reset' || (SPENDING_SUBCOMMANDS.has(args.sub) && !args.dryRun);
    if (writes) assertBotStopped(guildDir);

    const stores = openStores(dataDir, hot, now, log);
    const { createCalibrator } = await import('../src/llm/tokens.js');
    const ctx = { args, hot, dataDir, guildId, guildDir, now, log, llmClient, rootDir, ...stores, calibrator: createCalibrator(stores.store.state.data.calibration) };
    try {
      if (args.sub === 'status' || args.sub === 'reset') return offline(ctx);
      return await online(ctx, connect);
    } finally {
      // The archive copies of what a write dropped settle before the files are written (as at a
      // bot's shutdown); a read-only subcommand writes nothing, the bot may be running.
      if (writes) {
        await stores.store.drainArchive(guildId).catch((err) => log.warn('warmup: archive drain failed', { error: err }));
        await stores.store.flushSettled({ holdMaxMs: hot.config.archive?.holdMaxMs ?? 5000 });
      }
      await stores.close();
    }
  } finally {
    if (!givenHot) hot.close?.();
  }
}

/** `status` and `reset`: state.json only, no Discord, no model. */
function offline(ctx) {
  const { store, hot, guildId, now } = ctx;
  const warmup = createWarmup({ hot, store, client: { guilds: { cache: new Map() } }, llm: NO_MODEL, calibrator: ctx.calibrator, getSelfName: () => 'bot', now });
  if (ctx.args.sub === 'reset') {
    const result = warmup.reset();
    if (!result.ok) throw new CliError(`warmup: ${result.message}`);
    return 'warmup progress reset (profiles, channel notes, server notes and lore untouched)\n';
  }
  return `${formatStatus(warmup.status(guildId), { maxTokens: hot.config.warmup?.maxTokens, now: now() })}\n`;
}

/** `people` and the spending subcommands: Discord read over REST, then the engine. */
async function online(ctx, connect) {
  const { args, hot, store, guildId, now, log } = ctx;
  const spending = SPENDING_SUBCOMMANDS.has(args.sub);
  if (spending && !args.dryRun) {
    if (store.state.data.paused) throw new CliError('warmup: memory is paused (state.json); start the bot, run /nep resume, stop it, then run this again');
    await guard(ctx);
  }
  const conn = await connect({ rootDir: ctx.rootDir, guildId });
  try {
    const limits = { ceiling: undefined };
    const live = spending && !args.dryRun;
    const llm = live ? await modelClient(ctx) : NO_MODEL;
    const warmup = createWarmup({ hot: cappedHot(hot, limits), store, client: conn.client, llm, calibrator: ctx.calibrator, getSelfName: () => conn.selfName, now });
    const report = await warmup.peopleReport(guildId);
    if (args.sub === 'people') return `${formatPeople(report)}\n`;
    if (!report.ok) throw new CliError(`warmup: ${report.message}`);

    const channels = readableChannels(conn.guild, hot.config.bot ?? {}).map((channel) => String(channel.id));
    if (args.channelId && !channels.includes(args.channelId)) throw new CliError(`warmup: channel ${args.channelId} is not readable by the bot or not in this server`);
    const summary = warmup.summary();
    const plan = warmupPlan({ sub: args.sub, userId: args.userId, channelId: args.channelId, done: doneOf(store, summary), channels, people: report.people });
    const estimate = warmupEstimate({ config: hot.config, tokensUsed: summary.tokensUsed, requests: plan.requests, maxUsd: args.maxUsd, usdPerKTok: args.usdPerKTok });
    const head = [
      `warmup ${args.sub}${args.dryRun ? ' (dry run, nothing sent or written)' : ''}: ${plan.channels} channel(s), ${plan.people} member(s), server notes ${plan.server ? 'yes' : 'no'}`,
      `token ceiling: ${estimate.tokens} (bound by ${estimate.limitedBy}; warmup tokens used so far: ${summary.tokensUsed})`,
    ];
    const gate = spendGate({ estimateUsd: estimate.usd, requests: plan.requests, spend: args.spend, detail: `at most ${estimate.tokens} tokens at ${args.usdPerKTok} USD per 1k tokens` });
    if (args.dryRun) return `${[...head, gate.text.split('\n')[0]].join('\n')}\n`;
    process.stderr.write(`${head.join('\n')}\n`);
    if (!gate.ok) throw new CliError(gate.text, { exitCode: REFUSED_EXIT });
    process.stderr.write(`${gate.text}\n`);
    if (plan.requests > 0 && estimate.tokens <= 0) {
      throw new CliError(`warmup: nothing left to spend (warmup.maxTokens ${hot.config.warmup?.maxTokens ?? '-'}, used ${summary.tokensUsed}${Number.isFinite(args.maxUsd) ? `, --max-usd ${args.maxUsd}` : ''})`);
    }
    limits.ceiling = estimate.ceiling;

    let interrupts = 0;
    const onInterrupt = () => {
      interrupts += 1;
      if (interrupts > 1) process.exit(130);
      process.stderr.write('warmup: stopping after the request in flight is cancelled; Ctrl+C again quits at once\n');
      warmup.stop();
    };
    process.on('SIGINT', onInterrupt);
    let text;
    try {
      text = await execute(ctx, warmup);
    } finally {
      process.off('SIGINT', onInterrupt);
    }
    log.info('warmup: tool finished', { guildId, sub: args.sub });
    const status = formatStatus(warmup.status(guildId), { maxTokens: hot.config.warmup?.maxTokens, now: now() });
    return `${text}\n\n${status}\n`;
  } finally {
    await conn.close();
  }
}

/** Run the subcommand on the engine and word its outcome. */
async function execute(ctx, warmup) {
  const { args, guildId, store } = ctx;
  const nameOf = (id) => store.getUser(guildId, id)?.names?.[0] ?? null;
  if (args.sub === 'run') {
    const result = await warmup.run(guildId);
    return result.ok ? 'warmup run: finished' : `warmup run: stopped early: ${result.message ?? 'unknown reason'} (progress kept; run it again to resume)`;
  }
  if (args.sub === 'server') {
    const result = await warmup.runServer(guildId);
    return serverWrittenText(result.ok ? result.outcome : result);
  }
  if (args.sub === 'users' && args.userId) {
    const result = await warmup.runPerson(guildId, args.userId);
    return formatUserWritten(result.ok ? result.outcome : result);
  }
  if (args.sub === 'channels' && args.channelId) {
    const result = await warmup.runChannel(guildId, args.channelId);
    return channelWrittenText(result.ok ? result.outcome : result, nameOf);
  }
  const started = args.sub === 'users' ? await warmup.runUsers(guildId) : await warmup.runChannels(guildId);
  if (!started.ok) return `warmup ${args.sub}: not started: ${started.message ?? 'unknown reason'}`;
  await warmup.waitIdle();
  return `warmup ${args.sub}: ${started.count} ${args.sub === 'users' ? 'member(s)' : 'channel(s)'} taken (see the phase below for how it ended)`;
}

runCli(import.meta.url, (argv) => main(argv));
