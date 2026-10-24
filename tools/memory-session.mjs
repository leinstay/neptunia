#!/usr/bin/env node
// Operations tool: run her memory session (src/memory/db/session.js) once, on a copy of the memory database, in
// shadow, and say what she proposed. It exists so a session can be judged on real chat before the engine acts on it.
//
//   cd <checkout> && node tools/memory-session.mjs --db <memory.db> [--data <dir>] [--scope <scope key>] [--limit N]
//        [--key-env OPENROUTER_SIM_KEY] [--review <person|place|self>:<id>:<field>] [--show] [--self-name <name>]
//        [--keep <copy.db>]
//
// The database is copied first (VACUUM INTO, a consistent copy) into a temporary directory under TMPDIR, and the copy
// is the one written to: the given file is only read, and the copy is removed at the end (`--keep` names a file to
// leave it in). The session runs in `shadow` whatever the config says: every proposal is a `decisions` row of the
// copy, nothing touches a claim. The scope keys are `group:<iface>` and `dm:<iface>:<person id>`; without `--scope`
// every scope with new lines is run, one request each, one after the other. `--limit` caps the lines in a request
// (default `memoryDb.session.maxMessages`). The first sweep on a copy reads from its first line (or from
// `memoryDb.session.since`).
//
// `--key-env` names the `.env` variable whose OpenRouter key pays (default `OPENROUTER_SIM_KEY`); the memory role's own
// key (`OPENROUTER_MEMORY_KEY`) is not touched unless named. The config and the prompts are read from the checkout
// (and its private layer) as the bot reads them. A request is answered, or after a 429 tried again after the
// provider's wait (`Retry-After` when the error carries it), at most three tries in all.
//
// `--review` runs the two-call description review for one subject and field after the session (`person:<person id>:character`,
// `place:<place id>:purpose`, `self:person:self:self_view`; the id may itself contain colons: the field is the last
// part). Its result is a shadow `description_versions` row of the copy.
//
// The output is counts: lines, tokens, the kinds of the ops the answer proposed, what was dropped and why. Texts
// (the proposed values, the description) are printed only with `--show`. `--data` is reserved for the data
// directory of the database (the profiles are rebuilt from the database alone; it is not read today).
// Nothing here starts the bot. It needs the key, so the lead runs it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, parseFlags, privateDirOf, runCli } from './lib/cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'memory-session-tool';
const USAGE = `usage: node tools/memory-session.mjs --db <memory.db> [--data <dir>] [--scope <scope key>] [--limit N] [--key-env <ENV NAME>]
       [--review <person|place|self>:<id>:<field>] [--show] [--self-name <name>] [--keep <copy.db>]`;
const TRIES = 3;
const FALLBACK_WAIT_MS = 15_000;
const MAX_WAIT_MS = 120_000;

/** How long to wait before the next try after a 429: the error's `Retry-After` (seconds or a date) or `retryAfterMs`, else a growing fallback. */
export function backoffMs(error, attempt, now = Date.now()) {
  const given = Number(error?.retryAfterMs);
  if (Number.isFinite(given) && given > 0) return Math.min(given, MAX_WAIT_MS);
  const header = error?.headers?.get?.('retry-after') ?? error?.headers?.['retry-after'];
  if (typeof header === 'string' && header.trim()) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_WAIT_MS);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - now), MAX_WAIT_MS);
  }
  return Math.min(FALLBACK_WAIT_MS * attempt, MAX_WAIT_MS);
}

/**
 * `complete` with a backoff on 429: at most `tries` calls, serial; any other error is thrown at once.
 * @param {(messages: object[], options?: object) => Promise<object>} complete
 */
export function withBackoff(complete, { tries = TRIES, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, onWait = () => {} } = {}) {
  return async (messages, options) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await complete(messages, options);
      } catch (error) {
        if (error?.statusCode !== 429 || attempt >= tries) throw error;
        const wait = backoffMs(error, attempt, now());
        onWait(wait, attempt);
        await sleep(wait);
      }
    }
  };
}

/** `person:<id>:<field>` and the like. */
export function parseSubject(text) {
  const match = /^(person|place|self):(.+):([a-z_]+)$/.exec(String(text ?? ''));
  if (!match) throw new CliError(`memory-session: --review wants <person|place|self>:<id>:<field>\n${USAGE}`);
  return { subject: { kind: match[1], id: match[2] }, field: match[3] };
}

/** The ops of a plan as `claims:add 2, claims:confirm 1, episodes 1` (kinds only, never a value). */
export function opKinds(plan) {
  const counts = new Map();
  const bump = (key) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const claim of plan?.claims ?? []) bump(`claims:${claim.op}${claim.op === 'add' ? `(${claim.subjectKind})` : ''}`);
  for (const group of ['episodes', 'affinity', 'descriptions']) for (let i = 0; i < (plan?.[group]?.length ?? 0); i += 1) bump(group);
  for (const person of plan?.people ?? []) bump(`people:${person.op}`);
  return [...counts].map(([key, n]) => `${key} ${n}`).join(', ') || 'none';
}

async function copyDatabase(source, target) {
  const { openMemoryDb } = await import('../src/memory/db/open.js');
  const handle = openMemoryDb(source, { readOnly: true });
  try {
    handle.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    handle.close();
  }
}

/** Runs the tool; returns the text to print. */
export async function main(argv) {
  const flags = parseFlags(argv, { values: ['--db', '--data', '--scope', '--limit', '--key-env', '--review', '--self-name', '--keep'], switches: ['--show'], usage: USAGE });
  if (flags._.length > 0 || !flags['--db']) throw new CliError(USAGE);
  const source = path.resolve(flags['--db']);
  if (!fs.existsSync(source)) throw new CliError(`memory-session: no database at ${source}`);
  const limit = flags['--limit'] === undefined ? undefined : Number(flags['--limit']);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new CliError(`memory-session: --limit is a whole number above 0\n${USAGE}`);
  const keyEnv = flags['--key-env'] ?? 'OPENROUTER_SIM_KEY';
  if (!/^[A-Z][A-Z0-9_]*$/.test(keyEnv)) throw new CliError('memory-session: --key-env names an environment variable');
  const review = flags['--review'] ? parseSubject(flags['--review']) : null;
  const show = flags['--show'] === true;

  const { createHot } = await import('../src/hot.js');
  const { loadDotEnv } = await import('../src/config.js');
  const { createLlm } = await import('../src/llm/openrouter.js');
  const { createCalibrator } = await import('../src/llm/tokens.js');
  const { openMemoryDb } = await import('../src/memory/db/open.js');
  const { sweep, sessionSettings } = await import('../src/memory/db/session.js');
  const { reviewDescription } = await import('../src/memory/db/describe.js');
  const { applyMemoryWrite } = await import('../src/memory/db/session-write.js');

  loadDotEnv(privateDirOf(ROOT));
  const apiKey = process.env[keyEnv];
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new CliError(`memory-session: ${keyEnv} is not set (.env)`);

  const hot = createHot({ rootDir: ROOT, privateDir: privateDirOf(ROOT) });
  const lines = [];
  const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memory-session-'));
  const copy = flags['--keep'] ? path.resolve(flags['--keep']) : path.join(work, 'memory.db');
  let handle = null;
  try {
    if (fs.existsSync(copy)) throw new CliError(`memory-session: ${copy} already exists`);
    await copyDatabase(source, copy);
    handle = openMemoryDb(copy);
    lines.push(`copy: ${flags['--keep'] ? 'kept' : 'temporary'}, schema ok`);

    // The effective config: shadow, a sweep of the tool's own, the key variable named by --key-env pays.
    const live = hot.config;
    const config = {
      ...live,
      features: { ...(live.features ?? {}), memoryDb: true },
      llm: { ...(live.llm ?? {}), keyByRole: { ...(live.llm?.keyByRole ?? {}), memory: keyEnv } },
      memoryDb: {
        ...(live.memoryDb ?? {}),
        session: { ...(live.memoryDb?.session ?? {}), mode: 'shadow', minMessages: 1, sweepsPerDay: 1_000_000, settleMinutes: 0, ...(limit ? { maxMessages: limit } : {}) },
      },
    };
    const counters = { data: {}, markDirty() {} };
    const client = createLlm({ apiKey, env: { [keyEnv]: apiKey }, getConfig: () => config, calibrator: createCalibrator(undefined), state: counters });
    const usage = { requests: 0, prompt: 0, completion: 0 };
    const complete = withBackoff(async (messages, options = {}) => {
      const completion = await client.complete(messages, { ...options, origin: ORIGIN, countAgainstDailyCap: false, skipCalibration: true, cache: false });
      usage.requests += 1;
      usage.prompt += Number(completion?.usage?.prompt_tokens) || 0;
      usage.completion += Number(completion?.usage?.completion_tokens) || 0;
      return completion;
    }, { onWait: (ms, attempt) => process.stderr.write(`memory-session: 429, waiting ${Math.round(ms / 1000)} s (try ${attempt} of ${TRIES})\n`) });
    const ctx = {
      db: handle.db,
      write: async (update) => applyMemoryWrite(handle, update),
      llm: { complete },
      hot: { config, prompts: hot.prompts },
      env: { [keyEnv]: apiKey },
      now: Date.now,
      log: { info() {}, debug() {}, warn: (message, fields) => process.stderr.write(`${message} ${JSON.stringify(fields ?? {})}\n`), error() {} },
      selfName: flags['--self-name'] ?? live.bot?.name ?? '',
    };

    const settings = sessionSettings(config);
    lines.push(`mode shadow, up to ${settings.maxMessages} lines a request, model role memory, key from ${keyEnv}`);
    const result = await sweep(ctx, { scope: flags['--scope'], limit, ignoreSweepCap: true });
    if (result.status !== 'ok') lines.push(`sweep: ${result.status} (${result.code})`);
    for (const run of result.runs) {
      lines.push(`scope ${run.scope}: ${run.outcome}, ${run.lines} lines`);
      if (run.counts && run.plan) {
        const dropped = Object.entries(run.counts.dropped ?? {}).map(([reason, n]) => `${reason} ${n}`).join(', ') || 'none';
        lines.push(`  kept ${run.counts.kept}: ${opKinds(run.plan)}; dropped: ${dropped}`);
        if (show) lines.push(`  ${JSON.stringify(run.plan)}`);
      }
      if (run.errors?.length) lines.push(`  errors: ${run.errors.join(', ')}`);
    }
    lines.push(`requests ${usage.requests}, tokens ${usage.prompt} prompt, ${usage.completion} completion`);

    if (review) {
      const reviewed = await reviewDescription(handle.db, review.subject, review.field, { ctx });
      lines.push(`review ${review.subject.kind} ${review.field}: ${reviewed.status}${reviewed.code ? ` (${reviewed.code}${reviewed.step ? ` at ${reviewed.step}` : ''})` : ''}`);
      if (reviewed.status === 'ok') {
        lines.push(`  draft ${[...reviewed.draft].length} characters, final ${[...reviewed.final].length} characters, cap ${reviewed.row.extra.cap}${reviewed.row.extra.overCap ? ', over the cap' : ''}, kept ${reviewed.row.kept}, lost ${reviewed.row.removed}, gained ${reviewed.row.added}`);
        if (show) lines.push(`  draft: ${reviewed.draft}`, `  final: ${reviewed.final}`, `  reason: ${reviewed.reason}`);
      }
      lines.push(`requests ${usage.requests}, tokens ${usage.prompt} prompt, ${usage.completion} completion`);
    }
  } finally {
    handle?.close();
    hot.close?.();
    fs.rmSync(work, { recursive: true, force: true });
  }
  return `${lines.join('\n')}\n`;
}

runCli(import.meta.url, main);
