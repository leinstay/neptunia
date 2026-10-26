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
//
// compare (stage W3, the day against the analyzer):
//   node tools/memory-session.mjs compare --db <copy> [--data <copy>] --day <YYYY-MM-DD> [--shadow] [--key-env <ENV NAME>]
//        [--scope <scope key>] [--show] [--self-name <name>] [--keep <copy.db>]
// On a copy of the database (as above), her session runs in shadow over the lines of that UTC day only (`since` the
// day's start, nothing newer than its end, every scope from its first line of the day, the copy's shadow cursors
// cleared first), sweep after sweep until every scope is quiet, on the memory key by default (`--key-env`
// OPENROUTER_MEMORY_KEY). `--shadow` runs nothing (no key, no request): it compares the shadow proposals the copy
// already holds for lines of that day (a live shadow session's). Then, per scope, her proposals beside what the
// analyzer wrote that day (`claim_versions`, `episodes`, `affinity_events` recorded that day, her own session's rows
// left out): kept by both (the same claim, or the same subject and kind with most of the words; an episode of the same
// person with most of the words; an attitude move of the same person and sign), only hers, only the analyzer's, scope
// violations (a proposal with a source outside its scope: must be 0), unsupported (a proposal with no source), the
// description flags, and in all the requests, tokens and cost (OpenRouter's `usage.cost`, when it is given). Counts
// only; `--show` adds the texts. `--data` is accepted for the data copy and not read.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, parseFlags, privateDirOf, runCli } from './lib/cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'memory-session-tool';
const USAGE = `usage: node tools/memory-session.mjs --db <memory.db> [--data <dir>] [--scope <scope key>] [--limit N] [--key-env <ENV NAME>]
       [--review <person|place|self>:<id>:<field>] [--show] [--self-name <name>] [--keep <copy.db>]`;
const COMPARE_USAGE = `usage: node tools/memory-session.mjs compare --db <memory.db copy> [--data <dir>] --day <YYYY-MM-DD> [--shadow]
       [--key-env <ENV NAME>] [--scope <scope key>] [--show] [--self-name <name>] [--keep <copy.db>]`;
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
export function withBackoff(
  complete,
  {
    tries = TRIES,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    onWait = () => {},
  } = {}
) {
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
  for (const claim of plan?.claims ?? [])
    bump(`claims:${claim.op}${claim.op === 'add' ? `(${claim.subjectKind})` : ''}`);
  for (const group of ['episodes', 'affinity', 'descriptions'])
    for (let i = 0; i < (plan?.[group]?.length ?? 0); i += 1) bump(group);
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

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const scopeKeyOf = (row) =>
  row?.scope_kind === 'dm'
    ? `dm:${row.scope_iface}:${row.scope_dm}`
    : row?.scope_kind === 'group'
      ? `group:${row.scope_iface}`
      : null;

/**
 * Her proposals for the lines of `day` that a copy already holds (shadow `decisions` rows `proposed:<op>`): one entry
 * `{ scope, group, op }` per op with a source of that day; a description flag counts when its run read a line of the day.
 */
export function storedProposals(db, day) {
  const sourceDay = db.prepare('SELECT occurred_at FROM sources WHERE id = ?');
  const runDay = db.prepare('SELECT cursor_from, cursor_to, scope_key FROM session_runs WHERE id = ?');
  const lineOfDay = db.prepare(
    'SELECT 1 AS ok FROM sources WHERE rowid > ? AND rowid <= ? AND substr(occurred_at, 1, 10) = ? LIMIT 1'
  );
  const groupOf = { claims: 'claims', episode: 'episodes', affinity: 'affinity', description: 'descriptions' };
  const out = [];
  for (const row of db
    .prepare(
      "SELECT action, extra FROM decisions WHERE action LIKE 'proposed:%' AND retired_at IS NULL ORDER BY at, id"
    )
    .all()) {
    const extra = parseJson(row.extra);
    const op = extra?.op;
    if (!op) continue;
    const name = row.action.slice('proposed:'.length);
    const group = name.startsWith('people_') ? 'people' : (groupOf[name] ?? 'claims');
    const scope = scopeKeyOf(extra.scope);
    if (group === 'descriptions') {
      const run = runDay.get(extra.run);
      if (run && lineOfDay.get(run.cursor_from ?? 0, run.cursor_to ?? 0, day)) out.push({ scope, group, op });
      continue;
    }
    if ((op.sources ?? []).some((id) => String(sourceDay.get(id)?.occurred_at ?? '').slice(0, 10) === day))
      out.push({ scope, group, op });
  }
  return out;
}

/** What the analyzer wrote on `day`, by scope key: `{ claims, episodes, affinity }` (her session's own rows left out). */
// What the analyzer's day holds that is not a decision about memory, left out of the comparison: the archive's own
// bookkeeping (an item pushed out by a cap, expired, set aside, restored), the code-made items (participation episodes'
// claims and the recent lines), and attitude moves with no reason (the hourly decay).
const ARCHIVE_CHURN = ['evicted', 'expired', 'set-aside', 'restored', 'backfill'];
const CODE_KINDS = ['participation', 'recent', 'recent_line'];

export function analyzerWrites(db, day) {
  const by = new Map();
  const of = (row) => {
    const key = scopeKeyOf(row) ?? 'other';
    if (!by.has(key)) by.set(key, { claims: [], episodes: [], affinity: [] });
    return by.get(key);
  };
  for (const row of db
    .prepare(
      `SELECT v.claim_id, v.event, v.text, c.subject_kind, c.subject_id, c.kind, c.scope_kind, c.scope_iface, c.scope_dm FROM claim_versions v JOIN claims c ON c.id = v.claim_id
      WHERE substr(v.recorded_at, 1, 10) = ? AND v.origin IS NOT 'session' AND v.retired_at IS NULL
        AND v.event NOT IN (${ARCHIVE_CHURN.map((event) => `'${event}'`).join(', ')}) AND c.kind NOT IN (${CODE_KINDS.map((kind) => `'${kind}'`).join(', ')})
      ORDER BY v.recorded_at, v.rowid`
    )
    .all(day))
    of(row).claims.push({
      claimId: row.claim_id,
      event: row.event,
      text: row.text ?? '',
      subjectKind: row.subject_kind,
      subjectId: row.subject_id,
      kind: row.kind,
    });
  for (const row of db
    .prepare(
      "SELECT id, subject_id, what, scope_kind, scope_iface, scope_dm FROM episodes WHERE substr(created_at, 1, 10) = ? AND kind IS NOT 'session' AND retired_at IS NULL ORDER BY created_at, id"
    )
    .all(day))
    of(row).episodes.push({ id: row.id, subjectId: row.subject_id, what: row.what ?? '' });
  for (const row of db
    .prepare(
      "SELECT id, person_id, delta, scope_kind, scope_iface, scope_dm FROM affinity_events WHERE substr(at, 1, 10) = ? AND retired_at IS NULL AND json_extract(extra, '$.run') IS NULL AND COALESCE(reason, '') <> '' ORDER BY at, id"
    )
    .all(day))
    of(row).affinity.push({ id: row.id, personId: row.person_id, delta: Number(row.delta) || 0 });
  return by;
}

/**
 * Her proposals beside the analyzer's writes of the same day (see the head of this file), per scope. `showsClaim` is the
 * text match (describe.js#showsClaim). Returns `[{ scope, hers, analyzer, both, onlyHers, onlyAnalyzer, violations,
 * unsupported, flags }]`; `onlyHers` / `onlyAnalyzer` are the items themselves (for `--show`).
 */
export function compareDay(db, { day, proposals, showsClaim }) {
  const writes = analyzerWrites(db, day);
  const scopeOfSource = db.prepare('SELECT scope_kind, scope_iface, scope_dm FROM sources WHERE id = ?');
  const keys = [...new Set([...proposals.map((entry) => entry.scope ?? 'other'), ...writes.keys()])].sort();
  const words = (a, b) => showsClaim(a, { text: b }) || showsClaim(b, { text: a });
  const out = [];
  for (const key of keys) {
    const mine = proposals.filter((entry) => (entry.scope ?? 'other') === key);
    const theirs = writes.get(key) ?? { claims: [], episodes: [], affinity: [] };
    const left = { claims: [...theirs.claims], episodes: [...theirs.episodes], affinity: [...theirs.affinity] };
    const take = (list, match) => {
      const at = list.findIndex(match);
      return at === -1 ? null : list.splice(at, 1)[0];
    };
    const result = {
      scope: key,
      hers: 0,
      analyzer: theirs.claims.length + theirs.episodes.length + theirs.affinity.length,
      both: 0,
      onlyHers: [],
      onlyAnalyzer: [],
      violations: 0,
      unsupported: 0,
      flags: 0,
    };
    for (const { group, op } of mine) {
      if (group === 'descriptions') {
        result.flags += 1;
        continue;
      }
      result.hers += 1;
      const sources = Array.isArray(op.sources) ? op.sources : [];
      if (sources.length === 0) result.unsupported += 1;
      if (sources.some((id) => scopeKeyOf(scopeOfSource.get(id)) !== key)) result.violations += 1;
      let matched = null;
      if (group === 'claims') {
        matched =
          op.op === 'add'
            ? take(
                left.claims,
                (row) => row.subjectId === op.subjectId && row.kind === op.kind && words(row.text, op.text)
              )
            : take(left.claims, (row) => row.claimId === op.id);
      } else if (group === 'episodes') {
        matched = take(left.episodes, (row) => row.subjectId === op.subjectId && words(row.what, op.what));
      } else if (group === 'affinity') {
        matched = take(
          left.affinity,
          (row) => row.personId === op.personId && Math.sign(row.delta) === Math.sign(op.delta)
        );
      }
      if (matched) result.both += 1;
      else result.onlyHers.push({ group, op });
    }
    for (const group of ['claims', 'episodes', 'affinity'])
      for (const row of left[group]) result.onlyAnalyzer.push({ group, row });
    out.push(result);
  }
  return out;
}

/** The lines of a comparison (counts; with `show` the texts of what only one side has). */
export function compareLines(results, { show = false } = {}) {
  const lines = [];
  for (const result of results) {
    lines.push(
      `scope ${result.scope}: hers ${result.hers}, the analyzer's ${result.analyzer}; both ${result.both}, only hers ${result.onlyHers.length}, only the analyzer's ${result.onlyAnalyzer.length}; scope violations ${result.violations}, unsupported ${result.unsupported}, description flags ${result.flags}`
    );
    if (!show) continue;
    for (const { group, op } of result.onlyHers)
      lines.push(`  hers ${group}: ${op.text ?? op.what ?? op.reason ?? op.id ?? ''}`);
    for (const { group, row } of result.onlyAnalyzer)
      lines.push(`  analyzer ${group}: ${row.text ?? row.what ?? row.delta ?? ''}`);
  }
  return lines;
}

/**
 * The compare subcommand on an open copy (`handle`): her session over the lines of `day` in shadow (unless
 * `shadowOnly`), then the comparison. `llm` is `{ complete }` (a fake in the tests); `usage` collects requests,
 * tokens and cost. Returns the lines to print.
 */
export async function runCompare({
  handle,
  llm,
  hot,
  env,
  day,
  shadowOnly = false,
  scope = null,
  show = false,
  selfName = '',
  usage = { requests: 0, prompt: 0, completion: 0, cost: null },
  log = {},
}) {
  const { sweep } = await import('../src/memory/db/session.js');
  const { showsClaim } = await import('../src/memory/db/describe.js');
  const { applyMemoryWrite } = await import('../src/memory/db/session-write.js');
  const start = Date.parse(`${day}T00:00:00.000Z`);
  const end = start + DAY_MS;
  const lines = [];
  let proposals = [];
  if (!shadowOnly) {
    const { db } = handle;
    // The copy's own shadow state goes: every scope starts at its first line of the day.
    db.prepare(
      "DELETE FROM meta WHERE key LIKE 'memory_session.cursor.shadow.%' OR key LIKE 'memory_session.pending.shadow.%'"
    ).run();
    const live = hot.config;
    const config = {
      ...live,
      memoryDb: {
        ...(live.memoryDb ?? {}),
        session: {
          ...(live.memoryDb?.session ?? {}),
          mode: 'shadow',
          minMessages: 1,
          sweepsPerScopePerDay: 1_000_000,
          settleMinutes: 0,
          since: new Date(start).toISOString(),
        },
      },
    };
    // The clock stands at the day's end (a millisecond more each call, so every sweep has its own id).
    let tick = 0;
    const ctx = {
      db,
      write: async (update) => applyMemoryWrite(handle, update),
      llm,
      hot: { config, prompts: hot.prompts },
      env,
      now: () => end + (tick += 1),
      log,
      selfName,
    };
    for (let round = 0; round < 200; round += 1) {
      const result = await sweep(ctx, { scope: scope ?? undefined, ignoreSweepCap: true });
      if (result.status !== 'ok') {
        lines.push(`sweep: ${result.status} (${result.code})`);
        break;
      }
      let worked = false;
      for (const run of result.runs) {
        if (run.outcome === 'quiet') continue;
        worked = true;
        if (run.outcome !== 'ok' && run.outcome !== 'all_dropped')
          lines.push(`scope ${run.scope}: ${run.outcome}${run.errors?.length ? ` (${run.errors.join(', ')})` : ''}`);
        if (run.plan)
          for (const group of ['claims', 'episodes', 'affinity', 'descriptions', 'people'])
            for (const op of run.plan[group] ?? []) proposals.push({ scope: run.scope, group, op });
      }
      // A batch that failed outright leaves its lines where they were: the next sweep would ask again, so stop.
      if (
        !worked ||
        result.runs.some((run) => !['quiet', 'ok', 'all_dropped', 'skipped', 'applied_before'].includes(run.outcome))
      )
        break;
    }
  } else {
    proposals = storedProposals(handle.db, day).filter((entry) => !scope || entry.scope === scope);
  }
  lines.push(
    `day ${day}, ${shadowOnly ? 'the shadow proposals already stored' : 'her session in shadow over the lines of the day'}`
  );
  lines.push(
    ...compareLines(
      compareDay(handle.db, { day, proposals, showsClaim }).filter((result) => !scope || result.scope === scope),
      { show }
    )
  );
  const cost = usage.cost === null || usage.cost === undefined ? '-' : `${Math.round(usage.cost * 10000) / 10000} USD`;
  lines.push(`requests ${usage.requests}, tokens ${usage.prompt} prompt, ${usage.completion} completion, cost ${cost}`);
  return lines;
}

/** The compare subcommand (see the head of this file). */
async function compareMain(argv) {
  const flags = parseFlags(argv, {
    values: ['--db', '--data', '--day', '--key-env', '--scope', '--self-name', '--keep'],
    switches: ['--shadow', '--show'],
    usage: COMPARE_USAGE,
  });
  if (flags._.length > 0 || !flags['--db'] || !flags['--day']) throw new CliError(COMPARE_USAGE);
  if (!DAY_RE.test(flags['--day']) || !Number.isFinite(Date.parse(`${flags['--day']}T00:00:00.000Z`)))
    throw new CliError(`memory-session: --day is a date, YYYY-MM-DD\n${COMPARE_USAGE}`);
  const source = path.resolve(flags['--db']);
  if (!fs.existsSync(source)) throw new CliError(`memory-session: no database at ${source}`);
  const shadowOnly = flags['--shadow'] === true;
  const keyEnv = flags['--key-env'] ?? 'OPENROUTER_MEMORY_KEY';
  if (!/^[A-Z][A-Z0-9_]*$/.test(keyEnv)) throw new CliError('memory-session: --key-env names an environment variable');

  const { createHot } = await import('../src/hot.js');
  const { loadDotEnv } = await import('../src/config.js');
  const { openMemoryDb } = await import('../src/memory/db/open.js');
  let apiKey = null;
  if (!shadowOnly) {
    loadDotEnv(privateDirOf(ROOT));
    apiKey = process.env[keyEnv];
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new CliError(`memory-session: ${keyEnv} is not set (.env)`);
  }
  const hot = createHot({ rootDir: ROOT, privateDir: privateDirOf(ROOT) });
  const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memory-session-'));
  const copy = flags['--keep'] ? path.resolve(flags['--keep']) : path.join(work, 'memory.db');
  let handle = null;
  try {
    if (fs.existsSync(copy)) throw new CliError(`memory-session: ${copy} already exists`);
    await copyDatabase(source, copy);
    handle = openMemoryDb(copy);
    const live = hot.config;
    const config = {
      ...live,
      llm: { ...(live.llm ?? {}), keyByRole: { ...(live.llm?.keyByRole ?? {}), memory: keyEnv } },
    };
    const usage = { requests: 0, prompt: 0, completion: 0, cost: null };
    let llm = null;
    if (!shadowOnly) {
      const { createLlm } = await import('../src/llm/openrouter.js');
      const { createCalibrator } = await import('../src/llm/tokens.js');
      const client = createLlm({
        apiKey,
        env: { [keyEnv]: apiKey },
        getConfig: () => config,
        calibrator: createCalibrator(undefined),
        state: { data: {}, markDirty() {} },
      });
      llm = {
        complete: withBackoff(
          async (messages, options = {}) => {
            const completion = await client.complete(messages, {
              ...options,
              origin: ORIGIN,
              countAgainstDailyCap: false,
              skipCalibration: true,
              cache: false,
            });
            usage.requests += 1;
            usage.prompt += Number(completion?.usage?.prompt_tokens) || 0;
            usage.completion += Number(completion?.usage?.completion_tokens) || 0;
            if (Number.isFinite(completion?.usage?.cost)) usage.cost = (usage.cost ?? 0) + completion.usage.cost;
            return completion;
          },
          {
            onWait: (ms, attempt) =>
              process.stderr.write(
                `memory-session: 429, waiting ${Math.round(ms / 1000)} s (try ${attempt} of ${TRIES})\n`
              ),
          }
        ),
      };
    }
    const lines = await runCompare({
      handle,
      llm,
      hot: { config, prompts: hot.prompts },
      env: apiKey ? { [keyEnv]: apiKey } : {},
      day: flags['--day'],
      shadowOnly,
      scope: flags['--scope'] ?? null,
      show: flags['--show'] === true,
      selfName: flags['--self-name'] ?? live.bot?.name ?? '',
      usage,
      log: {
        info() {},
        debug() {},
        warn: (message, fields) => process.stderr.write(`${message} ${JSON.stringify(fields ?? {})}\n`),
        error() {},
      },
    });
    return `${[`copy: ${flags['--keep'] ? 'kept' : 'temporary'}, schema ok`, ...lines].join('\n')}\n`;
  } finally {
    handle?.close();
    hot.close?.();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Runs the tool; returns the text to print. */
export async function main(argv) {
  if (argv[0] === 'compare') return compareMain(argv.slice(1));
  const flags = parseFlags(argv, {
    values: ['--db', '--data', '--scope', '--limit', '--key-env', '--review', '--self-name', '--keep'],
    switches: ['--show'],
    usage: USAGE,
  });
  if (flags._.length > 0 || !flags['--db']) throw new CliError(USAGE);
  const source = path.resolve(flags['--db']);
  if (!fs.existsSync(source)) throw new CliError(`memory-session: no database at ${source}`);
  const limit = flags['--limit'] === undefined ? undefined : Number(flags['--limit']);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
    throw new CliError(`memory-session: --limit is a whole number above 0\n${USAGE}`);
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
      llm: { ...(live.llm ?? {}), keyByRole: { ...(live.llm?.keyByRole ?? {}), memory: keyEnv } },
      memoryDb: {
        ...(live.memoryDb ?? {}),
        session: {
          ...(live.memoryDb?.session ?? {}),
          mode: 'shadow',
          minMessages: 1,
          sweepsPerScopePerDay: 1_000_000,
          settleMinutes: 0,
          ...(limit ? { maxMessages: limit } : {}),
        },
      },
    };
    const counters = { data: {}, markDirty() {} };
    const client = createLlm({
      apiKey,
      env: { [keyEnv]: apiKey },
      getConfig: () => config,
      calibrator: createCalibrator(undefined),
      state: counters,
    });
    const usage = { requests: 0, prompt: 0, completion: 0 };
    const complete = withBackoff(
      async (messages, options = {}) => {
        const completion = await client.complete(messages, {
          ...options,
          origin: ORIGIN,
          countAgainstDailyCap: false,
          skipCalibration: true,
          cache: false,
        });
        usage.requests += 1;
        usage.prompt += Number(completion?.usage?.prompt_tokens) || 0;
        usage.completion += Number(completion?.usage?.completion_tokens) || 0;
        return completion;
      },
      {
        onWait: (ms, attempt) =>
          process.stderr.write(
            `memory-session: 429, waiting ${Math.round(ms / 1000)} s (try ${attempt} of ${TRIES})\n`
          ),
      }
    );
    const ctx = {
      db: handle.db,
      write: async (update) => applyMemoryWrite(handle, update),
      llm: { complete },
      hot: { config, prompts: hot.prompts },
      env: { [keyEnv]: apiKey },
      now: Date.now,
      log: {
        info() {},
        debug() {},
        warn: (message, fields) => process.stderr.write(`${message} ${JSON.stringify(fields ?? {})}\n`),
        error() {},
      },
      selfName: flags['--self-name'] ?? live.bot?.name ?? '',
    };

    const settings = sessionSettings(config);
    lines.push(`mode shadow, up to ${settings.maxMessages} lines a request, model role memory, key from ${keyEnv}`);
    const result = await sweep(ctx, { scope: flags['--scope'], limit, ignoreSweepCap: true });
    if (result.status !== 'ok') lines.push(`sweep: ${result.status} (${result.code})`);
    for (const run of result.runs) {
      lines.push(`scope ${run.scope}: ${run.outcome}, ${run.lines} lines`);
      if (run.counts && run.plan) {
        const dropped =
          Object.entries(run.counts.dropped ?? {})
            .map(([reason, n]) => `${reason} ${n}`)
            .join(', ') || 'none';
        lines.push(`  kept ${run.counts.kept}: ${opKinds(run.plan)}; dropped: ${dropped}`);
        if (show) lines.push(`  ${JSON.stringify(run.plan)}`);
      }
      if (run.errors?.length) lines.push(`  errors: ${run.errors.join(', ')}`);
    }
    lines.push(`requests ${usage.requests}, tokens ${usage.prompt} prompt, ${usage.completion} completion`);

    if (review) {
      const reviewed = await reviewDescription(handle.db, review.subject, review.field, { ctx });
      lines.push(
        `review ${review.subject.kind} ${review.field}: ${reviewed.status}${reviewed.code ? ` (${reviewed.code}${reviewed.step ? ` at ${reviewed.step}` : ''})` : ''}`
      );
      if (reviewed.status === 'ok') {
        lines.push(
          `  draft ${[...reviewed.draft].length} characters, final ${[...reviewed.final].length} characters, cap ${reviewed.row.extra.cap}${reviewed.row.extra.overCap ? ', over the cap' : ''}, kept ${reviewed.row.kept}, lost ${reviewed.row.removed}, gained ${reviewed.row.added}`
        );
        if (show)
          lines.push(`  draft: ${reviewed.draft}`, `  final: ${reviewed.final}`, `  reason: ${reviewed.reason}`);
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
