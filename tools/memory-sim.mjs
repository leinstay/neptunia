#!/usr/bin/env node
// Operations tool: replay the analyzer over a window of the chat against a copy of a memory
// snapshot, to see what the current analyzer prompts and config would make of the memory: which
// profile fields move, which stand still while their member keeps talking, how the merged prose
// reads, what a judge finds lost. Reproducible only with a manifest:
//
//   cd /opt/neptunia-bot && node tools/memory-sim.mjs --snapshot data/snapshots/<ts> --since <day> [--until <day>]
//        [--guild <id>] [--min-messages 30] [--judge <model>] [--spend <usd>]
//        [--from-dump <chat-*.jsonl>...] [--self-id <id>] [--self-name <name>] [--batch-size <n>] [--snapshot-at <iso>]
//        [--usd-per-batch 0.25] [--usd-per-judge 0.05] [--scratch <dir>]
//
// The manifest is the journal's `memory` records (guild batches) dated after the snapshot, read
// from the live journal days `--since`..`--until` (data/guilds/<g>/journal, read only): each
// gives the batch's message ids, `appliedRevision`, `promptsHash` and `configHash`; the report
// says whether today's prompts and config hash the same. The snapshot is a directory written by
// `/nep memory snapshot` (its name is its time) or an unpacked stop-backup (`--snapshot-at`
// gives its time); never the live tree. The batches' messages come from the snapshot's
// `buffer.json` and from `--from-dump` files; a batch's missing messages are counted. Without
// memory records `--from-dump` builds the batches itself (`--batch-size`, default
// `memory.batchMessages`), with the limits of that path named in the report.
//
// The snapshot is copied to a scratch directory (`--scratch`, default a new temporary
// directory) and the batches are replayed in order through src/memory/update.js
// #createMemoryUpdater with a store rooted at the scratch copy: every write lands there, never in
// data/; the deletion ledger (the snapshot's and the live one) is applied to it first
// (src/memory/store.js#applyLedger). Its clock is each batch's last message time. The journal it writes to is an in-memory
// capture (the batch limits, `over-limit` refusals included). Portrait rewrites are not run.
// Model requests go through the real client with the daily counters on a private copy
// (`countAgainstDailyCap: false`, `origin: 'memory-sim'`), capped at twice the estimate's
// count. The spend gate (tools/lib/cli.mjs#spendGate): the estimate is printed first and
// nothing is sent without `--spend` covering it.
//
// The report (markdown on stdout) per profile: fields changed (mobility), fields unchanged while
// the member wrote at least `--min-messages` lines in the replayed batches (stagnation; N/A
// when the manifest holds no record of their lines), words per sentence of every merged prose
// field (under 8 flagged: a signal, not a verdict), the judge's lost facts and relations (the
// judge model from `--judge`; its system prompt is tools/prompts/memory-judge.md,
// no judge request while that file is a placeholder), and the `over-limit` refusals. THE REPORT
// HOLDS MEMORY ABOUT REAL PEOPLE (the judge's findings): it is for the owner's eyes on the server.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorLines, batchesFromDump, manifestFrom, mobility, proseFields, stagnation, wordsPerSentence, SHORT_SENTENCE_WORDS } from './lib/sim.mjs';
import { CliError, REFUSED_EXIT, daysBetween, parseFlags, resolveGuildId, runCli, spendGate } from './lib/cli.mjs';

const USAGE =
  'usage: node tools/memory-sim.mjs --snapshot <dir> --since <YYYY-MM-DD> [--until <YYYY-MM-DD>] [--guild <id>] [--min-messages 30] ' +
  '[--judge <model>] [--spend <usd>] [--from-dump <chat-*.jsonl>...] [--self-id <id>] [--self-name <name>] [--batch-size <n>] [--snapshot-at <iso>] ' +
  '[--usd-per-batch 0.25] [--usd-per-judge 0.05] [--scratch <dir>]';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JUDGE_PROMPT = path.join(ROOT, 'tools', 'prompts', 'memory-judge.md');
/** Estimated cost of one analyzer batch (and its voice run, when two-stage); `--usd-per-batch` overrides. */
const DEFAULT_USD_PER_BATCH = 0.25;
/** Estimated cost of one judge request; `--usd-per-judge` overrides. */
const DEFAULT_USD_PER_JUDGE = 0.05;
const DEFAULT_MIN_MESSAGES = 30;
const JUDGE_MAX_OUTPUT = 2000;

/** A positive number from a flag, `fallback` when absent; a CliError otherwise. */
function numberFlag(value, fallback, { integer = false } = {}) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) throw new CliError(USAGE);
  return n;
}

/** The time a snapshot was taken: `--snapshot-at`, else its directory name (`/nep memory snapshot`'s form). */
function snapshotTime(dir, given) {
  if (given !== undefined) {
    const ms = Date.parse(given);
    if (!Number.isFinite(ms)) throw new CliError('--snapshot-at is not a time');
    return ms;
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(path.basename(dir));
  if (!match) throw new CliError('the snapshot directory name is not a /nep memory snapshot time: give --snapshot-at <iso>');
  return Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
}

/** The JSON records of the guild's journal days (whole lines only; unreadable ones skipped). */
function readJournal(dataDir, guildId, days) {
  const records = [];
  for (const day of days) {
    const file = path.join(dataDir, 'guilds', guildId, 'journal', `${day}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n').slice(0, -1);
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // a torn or hand-broken line: skipped
      }
    }
  }
  return records;
}

/** The dump files' lines by file, with the channel id their name carries (`chat-<id>.jsonl`). */
function readDumps(files) {
  return (files ?? []).map((file) => {
    const channelId = /chat-(\d+)/.exec(path.basename(file))?.[1] ?? null;
    return { file, channelId, lines: fs.readFileSync(file, 'utf8').split('\n') };
  });
}

/** The judge's system prompt, or null while the file is missing or still a placeholder. */
function judgePrompt() {
  try {
    const text = fs.readFileSync(JUDGE_PROMPT, 'utf8');
    return text.trimStart().startsWith('PLACEHOLDER') || !text.trim() ? null : text;
  } catch {
    return null;
  }
}

/** A list of strings from the judge's answer field, else []. */
function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : [];
}

/**
 * The whole tool: the markdown report (or the estimate when refused, as a CliError).
 * @param {string[]} argv
 * @param {{ cwd?: string, now?: () => number, llmClient?: { complete: Function } }} [options]
 *   `llmClient` stands in for the OpenRouter client (a test fake); the spend gate still applies.
 * @returns {Promise<string>}
 */
export async function main(argv, { cwd = process.cwd(), now = Date.now, llmClient = null } = {}) {
  const flags = parseFlags(argv, {
    values: ['--snapshot', '--since', '--until', '--guild', '--min-messages', '--judge', '--spend', '--self-id', '--batch-size', '--snapshot-at', '--usd-per-batch', '--usd-per-judge', '--scratch', '--data', '--self-name'],
    multi: ['--from-dump'],
    usage: USAGE,
  });
  if (!flags['--snapshot'] || !flags['--since'] || flags._.length > 0) throw new CliError(USAGE);
  const snapshotDir = path.resolve(cwd, flags['--snapshot']);
  if (!fs.existsSync(path.join(snapshotDir, 'guilds'))) throw new CliError(`no guilds/ under ${snapshotDir}: not a data snapshot`);
  const liveData = path.resolve(cwd, flags['--data'] ?? 'data');
  const guildId = resolveGuildId(snapshotDir, flags['--guild']);
  const takenAt = snapshotTime(snapshotDir, flags['--snapshot-at']);
  const days = daysBetween(flags['--since'], flags['--until'] ?? new Date(now()).toISOString().slice(0, 10), USAGE);
  const minMessages = numberFlag(flags['--min-messages'], DEFAULT_MIN_MESSAGES, { integer: true });
  const usdPerBatch = numberFlag(flags['--usd-per-batch'], DEFAULT_USD_PER_BATCH);
  const usdPerJudge = numberFlag(flags['--usd-per-judge'], DEFAULT_USD_PER_JUDGE);

  const { createHot } = await import('../src/hot.js');
  const hot = createHot({ rootDir: ROOT });
  const config = hot.config;
  // The persona's name as the analyzer prompt names it: --self-name, else the first name trigger.
  const selfName = flags['--self-name'] ?? config.bot?.nameTriggers?.[0] ?? 'bot';
  const batchSize = numberFlag(flags['--batch-size'], config.memory?.batchMessages ?? 60, { integer: true });
  if (batchSize < 1) throw new CliError(USAGE);

  // The manifest, and the messages its batches name: the snapshot's buffer, then the dumps.
  const manifest = manifestFrom(readJournal(liveData, guildId, days), { after: takenAt });
  const dumps = readDumps(flags['--from-dump']);
  const known = new Map();
  const bufferFile = path.join(snapshotDir, 'guilds', guildId, 'buffer.json');
  if (fs.existsSync(bufferFile)) {
    for (const message of JSON.parse(fs.readFileSync(bufferFile, 'utf8'))) if (message?.id) known.set(String(message.id), message);
  }
  let dumpSkipped = 0;
  const dumpBatches = [];
  for (const dump of dumps) {
    const { batches, skipped } = batchesFromDump(dump.lines, batchSize, { channelId: dump.channelId, selfId: flags['--self-id'] ?? null });
    dumpSkipped += skipped;
    dumpBatches.push(...batches);
    for (const batch of batches) for (const message of batch) if (!known.has(message.id)) known.set(message.id, message);
  }

  let mode;
  let batches;
  let missing = 0;
  let named = 0;
  if (manifest.length > 0) {
    mode = 'manifest';
    batches = manifest.map((entry) => {
      named += entry.messageIds.length;
      const found = entry.messageIds.map((id) => known.get(id)).filter(Boolean);
      missing += entry.messageIds.length - found.length;
      return { entry, messages: found };
    });
  } else if (dumpBatches.length > 0) {
    mode = 'dump';
    // Several dump files: one stream ordered by time, batched again.
    const all = dumpBatches.flat().sort((a, b) => a.ts - b.ts);
    batches = [];
    for (let i = 0; i < all.length; i += batchSize) batches.push({ entry: null, messages: all.slice(i, i + batchSize) });
  } else {
    throw new CliError('no memory records after the snapshot in those days and no --from-dump files: nothing to replay');
  }
  const runnable = batches.filter((b) => b.messages.length > 0);
  const lines = authorLines(runnable.map((b) => b.messages));
  // A member's lines in the window, by the record: what the resolved batches hold; unknown (null)
  // for a member without a line there while some named messages could not be found.
  const linesOf = (id) => (lines.has(id) ? lines.get(id) : missing > 0 ? null : 0);

  // The estimate: one analyzer request per batch (and a voice run with two-stage), one judge request per member who wrote.
  const judgeModel = flags['--judge'] ?? null;
  const judgeSystem = judgePrompt();
  const judging = Boolean(judgeModel && judgeSystem);
  const twoStage = config.features?.memoryTwoStage === true;
  const analyzerRequests = runnable.length * (twoStage ? 2 : 1);
  const judgeRequests = judging ? lines.size : 0;
  const gate = spendGate({
    estimateUsd: runnable.length * usdPerBatch + judgeRequests * usdPerJudge,
    requests: analyzerRequests + judgeRequests,
    spend: flags['--spend'],
    detail: `${runnable.length} batch(es) at ${usdPerBatch} USD${twoStage ? ' with their voice runs' : ''}, ${judgeRequests} judge request(s) at ${usdPerJudge} USD`,
  });
  if (!gate.ok) throw new CliError(`memory-sim: ${gate.text}`, { exitCode: REFUSED_EXIT });
  process.stderr.write(`memory-sim: ${gate.text}\n`);

  let apiKey = null;
  if (!llmClient) {
    const { loadDotEnv } = await import('../src/config.js');
    loadDotEnv(ROOT);
    apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new CliError('memory-sim: OPENROUTER_API_KEY is not set (.env)');
  }

  // The scratch copy: every write of the replay lands here.
  const scratch = flags['--scratch'] ? path.resolve(cwd, flags['--scratch']) : fs.mkdtempSync(path.join(os.tmpdir(), 'nep-memory-sim-'));
  if (scratch === liveData || scratch.startsWith(`${liveData}${path.sep}`)) throw new CliError('the scratch directory may not be under the live data/');
  if (fs.existsSync(scratch) && fs.readdirSync(scratch).length > 0) throw new CliError(`the scratch directory ${scratch} is not empty`);
  fs.cpSync(snapshotDir, scratch, { recursive: true });

  const { createStore, readLedger } = await import('../src/memory/store.js');
  const { createMemoryUpdater } = await import('../src/memory/update.js');
  const { createCalibrator } = await import('../src/llm/tokens.js');
  const { createLlm } = await import('../src/llm/openrouter.js');
  const { parseJsonObject } = await import('../src/llm/parse.js');
  const { block } = await import('../src/behavior/prompt.js');

  const store = createStore({ dataDir: scratch });
  // Nobody forgotten comes back through the copy: its own ledger and the live one, applied first.
  await store.applyLedger(guildId, { entries: readLedger(liveData, guildId) });
  const before = new Map(store.listUserProfiles(guildId).map((p) => [p.id, structuredClone(p)]));
  const stateData = store.state.data;
  const llmState = { data: { llmDay: stateData.llmDay, llmCount: stateData.llmCount }, markDirty() {} };
  const calibrator = createCalibrator(stateData.calibration);
  const realLlm = llmClient ?? createLlm({ apiKey, getConfig: () => hot.config, calibrator, state: llmState });
  const requestCap = (analyzerRequests + judgeRequests) * 2;
  const usage = { requests: 0, promptTokens: 0, completionTokens: 0 };
  const llm = {
    async complete(messages, options) {
      if (usage.requests >= requestCap) throw new Error('memory-sim: request cap reached');
      usage.requests += 1;
      const completion = await realLlm.complete(messages, { ...options, origin: 'memory-sim', countAgainstDailyCap: false, skipCalibration: true });
      usage.promptTokens += Number(completion?.usage?.prompt_tokens) || 0;
      usage.completionTokens += Number(completion?.usage?.completion_tokens) || 0;
      return completion;
    },
  };
  // The updater's journal: an in-memory capture; the config it reads has the journal switched on so each batch reports its limits.
  const captured = [];
  const capture = { memory: async (g, record) => void captured.push(record), stalled: () => false };
  const simHot = {
    get config() {
      return { ...hot.config, features: { ...(hot.config.features ?? {}), journal: true } };
    },
    get prompts() {
      return hot.prompts;
    },
    get hashes() {
      return hot.hashes;
    },
  };
  let clock = takenAt;
  const updater = createMemoryUpdater({
    hot: simHot,
    store,
    llm,
    calibrator,
    getSelfName: () => selfName,
    now: () => clock,
    onPortraitRequest: () => {},
    journal: capture,
  });

  const outcomes = [];
  for (const { entry, messages } of runnable) {
    const last = messages.at(-1)?.ts;
    if (Number.isFinite(last)) clock = Math.max(clock, last);
    const result = await updater.analyze(guildId, messages);
    if (twoStage) await updater.runVoice(guildId);
    outcomes.push({ batchId: entry?.batchId ?? null, lines: messages.length, ok: result?.ok === true, stage: result?.stage ?? null });
  }
  store.flush();

  // Per profile: mobility, stagnation, prose, judge.
  const after = new Map(store.listUserProfiles(guildId).map((p) => [p.id, p]));
  const rows = [];
  const findings = [];
  let quiet = 0;
  for (const id of [...new Set([...before.keys(), ...after.keys(), ...lines.keys()])].sort()) {
    const was = before.get(id) ?? null;
    const is = after.get(id) ?? null;
    const moved = mobility(was, is);
    // A member who neither wrote in the window nor changed is counted, not listed.
    if (!lines.has(id) && moved.changed.length === 0) {
      quiet += 1;
      continue;
    }
    const stuck = stagnation(moved, linesOf(id), minMessages);
    const prose = proseFields(is)
      .filter(({ field }) => moved.changed.includes(field))
      .map(({ field, text }) => ({ field, wps: wordsPerSentence(text) }));
    const short = prose.filter((p) => p.wps !== null && p.wps < SHORT_SENTENCE_WORDS).map((p) => `${p.field}: ${p.wps.toFixed(1)}`);
    let judged = { facts: 'N/A', relations: 'N/A' };
    if (judging && lines.has(id) && was && moved.changed.length > 0) {
      const asText = (profile) => JSON.stringify(Object.fromEntries(proseFields(profile).map(({ field, text }) => [field, text])), null, 1);
      try {
        const completion = await llm.complete(
          [
            { role: 'system', content: judgeSystem },
            { role: 'user', content: `${block('before', asText(was))}\n\n${block('after', asText(is))}` },
          ],
          { model: judgeModel, maxOutputTokens: JUDGE_MAX_OUTPUT, purpose: 'memory-judge', cache: false },
        );
        const parsed = parseJsonObject(completion?.text);
        const facts = stringList(parsed?.lostFacts);
        const relations = stringList(parsed?.lostRelations);
        judged = { facts: facts.length, relations: relations.length };
        if (facts.length + relations.length > 0) findings.push({ id, facts, relations });
      } catch (err) {
        judged = { facts: `error: ${err?.name ?? 'Error'}`, relations: '-' };
      }
    }
    rows.push([
      id,
      linesOf(id) ?? 'N/A',
      moved.changed.join(', ') || '-',
      Array.isArray(stuck) ? stuck.join(', ') || '-' : stuck,
      short.join('; ') || '-',
      judged.facts,
      judged.relations,
    ]);
  }

  const overLimit = new Map();
  for (const record of captured) {
    for (const limit of record.limits ?? []) {
      if (limit?.kind !== 'over-limit') continue;
      const key = limit.where ?? '-';
      overLimit.set(key, (overLimit.get(key) ?? 0) + 1);
    }
  }
  const recordedHashes = [...new Set(manifest.map((m) => `${m.promptsHash ?? '?'}/${m.configHash ?? '?'}`))];
  const cell = (c) => String(c).replace(/\|/g, '\\|');
  const out = [
    '# Memory simulation',
    '',
    `Snapshot: ${snapshotDir} (taken ${new Date(takenAt).toISOString()}); scratch copy: ${scratch}`,
    `Guild: ${guildId}; journal days ${days[0]} to ${days.at(-1)}`,
    `Mode: ${mode}; batches: ${batches.length}, replayed: ${runnable.length}, analyzer answers ok: ${outcomes.filter((o) => o.ok).length}`,
    `Prompts/config now: ${hot.hashes?.promptsHash ?? '?'}/${hot.hashes?.configHash ?? '?'}; recorded: ${recordedHashes.join(', ') || 'N/A'}`,
    `Usage: ${usage.requests} requests, ${usage.promptTokens} prompt tokens, ${usage.completionTokens} completion tokens`,
    '',
  ];
  if (mode === 'manifest') out.push(`Messages named by the manifest: ${named}; not found in the snapshot buffer or the dumps: ${missing}`, '');
  if (mode === 'dump') {
    out.push(
      'Limits of a dump replay: the batches are cut every ' +
        `${batchSize} lines of the dumps, not where the live buffer was cut; no pictures, links, stickers or forwards; ` +
        'the persona lines are known only by --self-id; private chats are absent; display names are the dump names. ' +
        `Dump lines skipped: ${dumpSkipped}.`,
      '',
    );
  }
  if (!judging) out.push(`Judge: N/A (${judgeModel ? 'tools/prompts/memory-judge.md is still a placeholder' : 'no --judge'})`, '');
  out.push('## Profiles', '', '| member | lines | changed | unchanged while talking | short prose (words/sentence) | lost facts | lost relations |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) out.push(`| ${row.map(cell).join(' | ')} |`);
  out.push('', `Members left out (no line in the window, nothing changed): ${quiet}`);
  out.push('', '## Over-limit refusals', '');
  if (overLimit.size === 0) out.push('none');
  else {
    out.push('| field | count |', '| --- | --- |');
    for (const [field, n] of [...overLimit].sort()) out.push(`| ${cell(field)} | ${n} |`);
  }
  if (findings.length > 0) {
    out.push('', '## Judge findings', '');
    for (const f of findings) {
      out.push(`### ${f.id}`, '');
      for (const fact of f.facts) out.push(`- lost fact: ${fact}`);
      for (const relation of f.relations) out.push(`- lost relation: ${relation}`);
      out.push('');
    }
  }
  hot.close?.();
  return `${out.join('\n').trimEnd()}\n`;
}

runCli(import.meta.url, main);
