// The pure part of tools/warmup.mjs: its argument rules, the refusal while the bot runs on the same
// data/, what a subcommand would send (the plan) and the most it may spend (the estimate), and the
// report lines. No network, no clock, no data/ writes; the one file check takes an injected
// `exists`.

import fs from 'node:fs';
import path from 'node:path';
import { CliError } from './cli.mjs';
import { NONE, channelTopWritersText, isoDay, outcomeText } from '../../src/ops/shared.js';

/** Every subcommand, in the order the usage lists them. */
export const WARMUP_SUBCOMMANDS = Object.freeze(['run', 'users', 'channels', 'server', 'people', 'status', 'reset']);

/** The subcommands that send model requests: the spend gate and the stopped bot apply. */
export const SPENDING_SUBCOMMANDS = Object.freeze(new Set(['run', 'users', 'channels', 'server']));

/** Price of a thousand tokens, for the estimate (`--usd-per-ktok`); the backfill's default. */
export const DEFAULT_USD_PER_KTOK = 0.005;

/** What stops the bot (deploy/neptunia-bot.service), named by the refusal. */
export const BOT_STOP_COMMAND = 'sudo systemctl stop neptunia-bot';

/** The engine's per-request cap when `warmup.maxRequestTokens` is missing (config.json's value). */
const MAX_REQUEST_TOKENS_FALLBACK = 120000;

export const WARMUP_USAGE =
  'usage: node tools/warmup.mjs run [--spend <usd>] [--max-usd <n>] [--dry-run] [--guild <id>]\n' +
  '       node tools/warmup.mjs users [--user <id>] [--spend <usd>] [--max-usd <n>] [--dry-run] [--guild <id>]\n' +
  '       node tools/warmup.mjs channels [--channel <id>] [--spend <usd>] [--max-usd <n>] [--dry-run] [--guild <id>]\n' +
  '       node tools/warmup.mjs server [--spend <usd>] [--max-usd <n>] [--dry-run] [--guild <id>]\n' +
  '       node tools/warmup.mjs people|status|reset [--guild <id>]\n' +
  '       (spending subcommands also take [--usd-per-ktok 0.005]; cwd: the bot directory)';

const ID_RE = /^\d{1,25}$/;

/** `value` as a non-negative number (positive with `positive`); a CliError otherwise. */
function numberOf(value, { positive = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (positive && n === 0)) throw new CliError(WARMUP_USAGE);
  return n;
}

/**
 * The tool's arguments: one subcommand and its flags. `--user` belongs to `users`, `--channel` to
 * `channels`; `--spend`, `--max-usd`, `--usd-per-ktok` and `--dry-run` to the spending
 * subcommands only. Anything else is a CliError with the usage. `spend` stays the text given
 * (the spend gate reads it).
 * @param {string[]} argv
 * @returns {{ sub: string, guildId?: string, userId?: string, channelId?: string, spend?: string,
 *   maxUsd?: number, usdPerKTok: number, dryRun: boolean, data?: string }}
 */
export function parseWarmupArgs(argv) {
  const values = ['--guild', '--user', '--channel', '--spend', '--max-usd', '--usd-per-ktok', '--data'];
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') out[arg] = true;
    else if (values.includes(arg)) {
      const value = argv[(i += 1)];
      if (typeof value !== 'string' || value.startsWith('--')) throw new CliError(WARMUP_USAGE);
      out[arg] = value;
    } else if (typeof arg === 'string' && arg.startsWith('--')) throw new CliError(WARMUP_USAGE);
    else out._.push(arg);
  }
  const sub = out._[0];
  if (!WARMUP_SUBCOMMANDS.includes(sub) || out._.length !== 1) throw new CliError(WARMUP_USAGE);
  const spending = SPENDING_SUBCOMMANDS.has(sub);
  if (out['--user'] !== undefined && sub !== 'users') throw new CliError(WARMUP_USAGE);
  if (out['--channel'] !== undefined && sub !== 'channels') throw new CliError(WARMUP_USAGE);
  for (const flag of ['--spend', '--max-usd', '--usd-per-ktok', '--dry-run']) {
    if (out[flag] !== undefined && !spending) throw new CliError(WARMUP_USAGE);
  }
  for (const flag of ['--user', '--channel']) {
    if (out[flag] !== undefined && !ID_RE.test(out[flag])) throw new CliError(WARMUP_USAGE);
  }
  return {
    sub,
    guildId: out['--guild'],
    userId: out['--user'],
    channelId: out['--channel'],
    spend: out['--spend'],
    maxUsd: out['--max-usd'] === undefined ? undefined : numberOf(out['--max-usd']),
    usdPerKTok: out['--usd-per-ktok'] === undefined ? DEFAULT_USD_PER_KTOK : numberOf(out['--usd-per-ktok'], { positive: true }),
    dryRun: out['--dry-run'] === true,
    data: out['--data'],
  };
}

/**
 * Refuse while the bot runs on this data/: its journal's `.running` marker
 * (src/memory/journal.js#markRunning) under `guildDir`. The running bot holds memory in its
 * process and would overwrite what the tool writes.
 * @param {string} guildDir  data/guilds/<id>
 * @param {{ exists?: (file: string) => boolean }} [options]
 */
export function assertBotStopped(guildDir, { exists = fs.existsSync } = {}) {
  if (exists(path.join(guildDir, 'journal', '.running'))) {
    throw new CliError(`warmup: the bot is running on this data/ (its journal marker is there); stop it first: ${BOT_STOP_COMMAND}`);
  }
}

/**
 * What a subcommand sends: `run` the channels and qualifying people its progress has not done
 * yet and the server notes unless done; `users`/`channels` redo every qualifying member / every
 * readable channel, or exactly the one given; `server` one request. A person counts as one
 * request (a sample too large for one request takes more; the estimate's ceiling covers that).
 * @param {{ sub: string, userId?: string, channelId?: string,
 *   done: { channels: string[], people: string[], server: boolean },
 *   channels: string[], people: { id: string }[] }} input
 * @returns {{ channels: number, people: number, server: number, requests: number }}
 */
export function warmupPlan({ sub, userId, channelId, done, channels, people }) {
  const doneChannels = new Set((done?.channels ?? []).map(String));
  const donePeople = new Set((done?.people ?? []).map(String));
  let plan = { channels: 0, people: 0, server: 0 };
  if (sub === 'run') {
    plan = {
      channels: channels.filter((id) => !doneChannels.has(String(id))).length,
      people: people.filter((person) => !donePeople.has(String(person.id))).length,
      server: done?.server ? 0 : 1,
    };
  } else if (sub === 'users') plan.people = userId ? 1 : people.length;
  else if (sub === 'channels') plan.channels = channelId ? 1 : channels.length;
  else if (sub === 'server') plan.server = 1;
  return { ...plan, requests: plan.channels + plan.people + plan.server };
}

/**
 * The most a run may spend: every request at `warmup.maxRequestTokens`, within what is left of
 * `warmup.maxTokens` after `tokensUsed` (no budget set: no bound from it, as the engine reads a
 * missing one) and within `maxUsd` (`--max-usd`), priced at `usdPerKTok`. `ceiling` is the
 * warmup budget the tool runs the engine under (`tokensUsed + tokens`), so the run stops there
 * (resumable) and never spends past the estimate the owner accepted. `limitedBy`: which of
 * `requests`, `budget`, `max-usd` set the number (the first in that order on a tie).
 * @param {{ config: object, tokensUsed: number, requests: number, maxUsd?: number, usdPerKTok: number }} input
 * @returns {{ requests: number, tokens: number, usd: number, ceiling: number, limitedBy: string }}
 */
export function warmupEstimate({ config, tokensUsed, requests, maxUsd, usdPerKTok }) {
  const used = Number.isFinite(tokensUsed) && tokensUsed > 0 ? tokensUsed : 0;
  const perRequest = config?.warmup?.maxRequestTokens ?? MAX_REQUEST_TOKENS_FALLBACK;
  const budget = config?.warmup?.maxTokens;
  const bounds = [
    ['requests', requests * perRequest],
    ['budget', Number.isFinite(budget) ? Math.max(0, budget - used) : Infinity],
    ['max-usd', Number.isFinite(maxUsd) ? Math.floor((maxUsd / usdPerKTok) * 1000) : Infinity],
  ];
  let [limitedBy, tokens] = bounds[0];
  for (const [name, value] of bounds.slice(1)) {
    if (value < tokens) [limitedBy, tokens] = [name, value];
  }
  const usd = Math.round((tokens / 1000) * usdPerKTok * 1e6) / 1e6;
  return { requests, tokens, usd, ceiling: used + tokens, limitedBy };
}

/** `peopleReport`'s answer: one line per qualifying member, then the totals. */
export function formatPeople(report) {
  if (!report?.ok) return outcomeText(report, 'not done');
  const lines = report.people.map((p, i) => {
    const topChannels = Object.entries(p.byChannel ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([cid, count]) => `${cid}:${count}`)
      .join(', ');
    return `${i + 1}. ${p.name} (id:${p.id}) — ${p.messages} messages, ${isoDay(p.firstTs)}..${isoDay(p.lastTs)}, top channels: ${topChannels || '-'}`;
  });
  if (lines.length === 0) lines.push(NONE);
  lines.push('');
  lines.push(`channels read: ${report.totals.channelsRead}`);
  lines.push(`messages read: ${report.totals.messagesRead}`);
  lines.push(`people below the threshold: ${report.totals.belowThreshold}`);
  return lines.join('\n');
}

/** One member's profile run: sample size, tokens, list counts and the start of the character
 * text; the reason when nothing was written. */
export function formatUserWritten(outcome) {
  if (!outcome?.ok) return outcomeText(outcome, 'not done');
  const { member, answer, sample, tokensUsed, chunks } = outcome;
  const a = answer ?? {};
  const characterExcerpt = String(a.character ?? '').slice(0, 300) || '(empty)';
  const chunkNote = chunks > 1 ? `, ${chunks} chunks` : '';
  return [
    `profiled ${member.name} (id:${member.id})`,
    `sample: ${sample?.ownCount ?? '?'} own / ${sample?.contextCount ?? '?'} context lines${chunkNote}`,
    `tokens used: ${tokensUsed ?? '?'}`,
    `interests: ${a.interests?.length ?? 0}, details: ${a.details?.length ?? 0}, episodes: ${a.episodes?.length ?? 0}, aliases: ${a.aliases?.length ?? 0}`,
    `character: ${characterExcerpt}`,
  ].join('\n');
}

/** `channels --channel`: the note written (purpose/topics/tone), plus the counters
 * and top writers `store.setChannelFacts` filled in -- the same lines as `/nep memory channel`
 * (writers as `name (count)` through `nameOf`, an id with no profile skipped; the last message as
 * a date). The outcome's message or reason when nothing was written. */
export function channelWrittenText(outcome, nameOf) {
  if (!outcome?.ok) return outcomeText(outcome, 'not done');
  const { channel, result, facts } = outcome;
  const lines = [
    `described #${channel.name} (id:${channel.id})`,
    `purpose: ${result.purpose || '(empty)'}`,
    `topics: ${result.topics || '(empty)'}`,
    `tone: ${result.tone || '(empty)'}`,
  ];
  if (facts) {
    lines.push(`messages seen: ${facts.messageCount}`);
    lines.push(`last message: ${isoDay(facts.lastMessageAt)}`);
    const writers = channelTopWritersText(facts.topWriters, nameOf);
    if (writers) lines.push(`top writers: ${writers}`);
  }
  return lines.join('\n');
}

/** `server`: counts of what was written (patterns/starters lengths,
 * in-jokes, lore entries); the outcome's message or reason when nothing was. */
export function serverWrittenText(outcome) {
  if (!outcome?.ok) return outcomeText(outcome, 'not done');
  const c = outcome.counts;
  return `server notes updated: patterns ${c.patternsChars} chars, starters ${c.startersChars} chars, injokes ${c.injokes}, lore entries ${c.lore}`;
}

/** `N s ago` / `N min ago` / `N h ago` before `now`, or `never` when `lastActivityAt` is unknown. */
export function humanizeAgo(lastActivityAt, now) {
  if (!Number.isFinite(lastActivityAt)) return 'never';
  const deltaMs = Math.max(0, now - lastActivityAt);
  const seconds = Math.round(deltaMs / 1000);
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

/** One `phase: …` line's text from a warmup status's in-memory `activity` snapshot (see
 * src/memory/warmup.js's `touchActivity`) -- falls back to `s.phase` (the coarser "running" /
 * "not started" / "finished" / "aborted (reason)" / "idle" summary) whenever `activity` carries
 * nothing more specific. Never throws on a missing/partial snapshot. */
export function formatWarmupPhase(s) {
  const a = s?.activity;
  const d = a?.detail ?? {};
  switch (a?.phase) {
    case 'fetching':
      return `fetching history, ${d.channelsFetched ?? 0}/${d.channelsTotal ?? 0} channels`;
    case 'channel': {
      const label = d.name ? `#${d.name}` : d.id ? `id:${d.id}` : 'a channel';
      const count = d.total ? ` (${d.index ?? '?'} of ${d.total})` : '';
      return `describing channel ${label}${count}`;
    }
    case 'person': {
      const who = `${d.name ?? '?'} (id:${d.id ?? '?'})`;
      const count = d.total ? ` (${d.index ?? '?'} of ${d.total})` : '';
      const chunk = d.chunk ? `, chunk ${d.chunk.k}/${d.chunk.n}` : '';
      return `profiling ${who}${count}${chunk}`;
    }
    case 'server':
      return 'building the server notes';
    case 'waiting-rate-limit': {
      const until = Number.isFinite(d.until) ? `${new Date(d.until).toISOString().slice(11, 16)} UTC` : '?';
      return `waiting for the provider rate limit until ${until} (wait ${d.waits ?? 1})`;
    }
    case 'paused':
      return 'paused';
    case 'stopped':
      return 'stopped';
    case 'finished':
      return 'finished';
    case 'aborted':
      return `aborted (${d.reason ?? s?.aborted ?? 'unknown'})`;
    default:
      return s?.phase ?? 'idle';
  }
}

/**
 * The engine's `status()` as lines: phase, last activity, progress, tokens against
 * `maxTokens` (`warmup.maxTokens`), requests, start, finish, abort and the next target.
 * @param {object} s  src/memory/warmup.js#createWarmup's `status(guildId)`
 * @param {{ maxTokens?: number, now: number }} options
 * @returns {string}
 */
export function formatStatus(s, { maxTokens, now }) {
  return [
    `phase: ${formatWarmupPhase(s)}`,
    `last activity: ${humanizeAgo(s.activity?.lastActivityAt, now)}`,
    `channels: ${s.doneChannels}/${s.channelsEligible ?? '?'}`,
    `people: ${s.donePeople}/${s.peopleEligible ?? '?'}`,
    `server: ${s.doneServer ? 'done' : 'pending'}`,
    `tokens used: ${s.tokensUsed} / ${maxTokens ?? '-'}`,
    `requests: ${s.requests}`,
    `started: ${s.startedAt ?? '-'}`,
    `finished: ${s.finishedAt ?? '-'}`,
    `aborted: ${s.aborted ?? 'no'}`,
    `next target: ${s.nextTarget ?? '-'}`,
  ].join('\n');
}
