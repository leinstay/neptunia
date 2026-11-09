#!/usr/bin/env node
// Operations tool: run her memory session (src/memory/db/session.ts) once, on a copy of the memory database, in
// shadow, and say what she proposed. It exists so a session can be judged on real chat before the engine acts on it.
//
//   cd <checkout> && node scripts/memory-session.ts --db <memory.db> [--data <dir>] [--scope <scope key>] [--limit N]
//        [--review <person|place|self>:<id>:<field>] [--show] [--self-name <name>] [--keep <copy.db>]
//        [--memory <route>] [--variant "<flags>"]...
//
// The database is copied first (VACUUM INTO, a consistent copy) into a temporary directory under TMPDIR, and the copy
// is the one written to: the given file is only read, and the copy is removed at the end (`--keep` names a file to
// leave it in). The session runs in `shadow` whatever the config says: every proposal is a `decisions` row of the
// copy, nothing touches a claim. The scope keys are `group:<iface>` and `dm:<iface>:<person id>`; without `--scope`
// every scope with new lines is run, one request each, one after the other. `--limit` caps the lines in a request
// (default `memoryDb.session.maxMessages`). The first sweep on a copy reads from its first line (or from
// `memoryDb.session.since`).
//
// The memory role runs as production runs it (scripts/lib/script-routes.ts): along its chain of routes
// (`models.routes.memory`), on a key or through a harness, and the session checks its key on the same ring. `--memory <key>/<model>[:<effort>]` or `--memory harness:<claude|codex>/<model>[:<effort>]` replaces the role for
// this run alone, and the start line on stderr names its key or harness and model. `--variant "<flags>"` (repeatable)
// runs the session once per variant, each on its own fresh copy, and prints every scope once with each variant's result
// beneath it; `--keep` takes no variant, and `compare` takes the role flags and no variant. The config and the prompts
// are read from the checkout (and its private layer) as the bot reads them. A request is answered, or after a 429 tried again after the
// provider's wait (`Retry-After` when the error carries it), at most three tries in all.
//
// `--review` runs the two-call description review for one subject and field after the session (`person:<person id>:character`,
// `place:<place id>:purpose`, `self:person:self:self_view`; the id may itself contain colons: the field is the last
// part). Its result is a shadow `description_versions` row of the copy.
//
// The output is counts: lines, tokens, the kinds of the ops the answer proposed, what was dropped and why. Texts
// (the proposed values, the description) are printed only with `--show`. `--data` is reserved for the data
// directory of the database (the profiles are rebuilt from the database alone; it is not read today).
// Nothing here starts the bot. It spends production's memory key, so the lead runs it.
//
// compare (stage W3, the day against the analyzer):
//   node scripts/memory-session.ts compare --db <copy> [--data <copy>] --day <YYYY-MM-DD> [--shadow]
//        [--scope <scope key>] [--show] [--self-name <name>] [--keep <copy.db>]
// On a copy of the database (as above), her session runs in shadow over the lines of that UTC day only (`since` the
// day's start, nothing newer than its end, every scope from its first line of the day, the copy's shadow cursors
// cleared first), sweep after sweep until every scope is quiet, on the memory role's route. `--shadow` runs nothing (no key, no request): it compares the shadow proposals the copy
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
import { CliError, parseFlags, privateDirOf, runCli } from './lib/cli.ts';
import { routedHot, routesText, scriptRouting, sideBySideText, takeRouteFlags } from './lib/script-routes.ts';
import type { ScriptRouting, Variant } from './lib/script-routes.ts';
import type { Untyped } from '../src/tools/types.ts';
import { sqlOf } from './lib/sql.ts';
import type { SqlDb } from './lib/sql.ts';
import type { MemoryHandle } from '../src/memory/db/types.ts';
import type { KeyRing } from '../src/keys/ring.ts';
import type { MemoryPath } from '../src/subharness/memory-path.ts';

/** An object read by key whose values are not typed yet. */
type Rec = Record<string, Untyped>;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'memory-session-tool';
const TOOL = 'memory-session';
const USAGE = `usage: node scripts/memory-session.ts --db <memory.db> [--data <dir>] [--scope <scope key>] [--limit N]
       [--review <person|place|self>:<id>:<field>] [--show] [--self-name <name>] [--keep <copy.db>]`;
const COMPARE_USAGE = `usage: node scripts/memory-session.ts compare --db <memory.db copy> [--data <dir>] --day <YYYY-MM-DD> [--shadow]
       [--scope <scope key>] [--show] [--self-name <name>] [--keep <copy.db>]`;
const TRIES = 3;
const FALLBACK_WAIT_MS = 15_000;
const MAX_WAIT_MS = 120_000;

/** How long to wait before the next try after a 429: the error's `Retry-After` (seconds or a date) or `retryAfterMs`, else a growing fallback. */
export function backoffMs(error: Untyped, attempt: number, now = Date.now()): number {
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

type BackoffOptions = {
  tries?: number;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
  onWait?: (wait: number, attempt: number) => void;
};

/** The requests, tokens and cost a run collects. */
type Usage = { requests: number; prompt: number; completion: number; cost: number | null };

/** What `runCompare` takes. `llm` is `{ complete }` (a fake in the tests). */
type CompareOptions = {
  handle: MemoryHandle;
  llm: Untyped;
  hot: Untyped;
  /** The key ring of the run's routing (scripts/lib/script-routes.ts); null with `shadowOnly`. */
  ring: KeyRing | null;
  /** The memory writer's path of the run's routing; absent with `shadowOnly`. */
  path?: () => MemoryPath;
  day: string;
  shadowOnly?: boolean;
  scope?: string | null;
  show?: boolean;
  selfName?: string;
  usage?: Usage;
  log?: Rec;
};

/** `complete` with a backoff on 429: at most `tries` calls, serial; any other error is thrown at once. */
export function withBackoff(
  complete: (messages: Array<Untyped>, options?: Untyped) => Promise<Untyped>,
  {
    tries = TRIES,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    onWait = () => {},
  }: BackoffOptions = {}
) {
  return async (messages: Untyped, options: Untyped): Promise<Untyped> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await complete(messages, options);
      } catch (error: Untyped) {
        if (error?.statusCode !== 429 || attempt >= tries) throw error;
        const wait = backoffMs(error, attempt, now());
        onWait(wait, attempt);
        await sleep(wait);
      }
    }
  };
}

/** `person:<id>:<field>` and the like. */
export function parseSubject(text: Untyped): { subject: { kind: string; id: string }; field: string } {
  const match = /^(person|place|self):(.+):([a-z_]+)$/.exec(String(text ?? ''));
  if (!match) throw new CliError(`memory-session: --review wants <person|place|self>:<id>:<field>\n${USAGE}`);
  return { subject: { kind: match[1], id: match[2] }, field: match[3] };
}

/** The ops of a plan as `claims:add 2, claims:confirm 1, episodes 1` (kinds only, never a value). */
export function opKinds(plan: Untyped): string {
  const counts = new Map();
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const claim of plan?.claims ?? [])
    bump(`claims:${claim.op}${claim.op === 'add' ? `(${claim.subjectKind})` : ''}`);
  for (const group of ['episodes', 'affinity', 'descriptions'])
    for (let i = 0; i < (plan?.[group]?.length ?? 0); i += 1) bump(group);
  for (const person of plan?.people ?? []) bump(`people:${person.op}`);
  return [...counts].map(([key, n]) => `${key} ${n}`).join(', ') || 'none';
}

async function copyDatabase(source: Untyped, target: Untyped) {
  const { openMemoryDb } = await import('../src/memory/db/open.ts');
  const handle = openMemoryDb(source, { readOnly: true });
  try {
    sqlOf(handle).exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    handle.close();
  }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The three columns that name a row's scope. */
type ScopeColumns = { scope_kind?: string | null; scope_iface?: string | null; scope_dm?: string | null };

/** One operation of her plan (the fields a comparison reads; an operation carries the ones its group needs). */
type Op = {
  op?: string;
  id?: string;
  sources?: Array<string>;
  subjectId?: string;
  kind?: string;
  text?: string;
  what?: string;
  personId?: string;
  delta?: number;
  reason?: string;
};

/** An operation of her plan with the scope it was proposed in and its group (`claims`, `episodes`, `affinity`...). */
type Proposal = { scope: string | null; group: string; op: Op };

type ClaimWrite = {
  claimId: string;
  event: string;
  text: string;
  subjectKind: string;
  subjectId: string;
  kind: string;
};
type EpisodeWrite = { id: string; subjectId: string; what: string };
type AffinityWrite = { id: string; personId: string; delta: number };

/** What the analyzer wrote on one day in one scope. */
type DayWrites = { claims: Array<ClaimWrite>; episodes: Array<EpisodeWrite>; affinity: Array<AffinityWrite> };

/** The comparison of her proposals with the analyzer's writes in one scope. */
type Comparison = {
  scope: string;
  hers: number;
  analyzer: number;
  both: number;
  onlyHers: Array<{ group: string; op: Op }>;
  onlyAnalyzer: Array<{ group: string; row: { text?: string; what?: string; delta?: number } }>;
  violations: number;
  unsupported: number;
  flags: number;
};

const parseJson = (text: string): Rec | null => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const scopeKeyOf = (row: ScopeColumns | null | undefined): string | null =>
  row?.scope_kind === 'dm'
    ? `dm:${row.scope_iface}:${row.scope_dm}`
    : row?.scope_kind === 'group'
      ? `group:${row.scope_iface}`
      : null;

/**
 * Her proposals for the lines of `day` that a copy already holds (shadow `decisions` rows `proposed:<op>`): one entry
 * `{ scope, group, op }` per op with a source of that day; a description flag counts when its run read a line of the day.
 */
export function storedProposals(db: SqlDb, day: string): Array<Proposal> {
  const sourceDay = db.prepare('SELECT occurred_at FROM sources WHERE id = ?');
  const runDay = db.prepare('SELECT cursor_from, cursor_to, scope_key FROM session_runs WHERE id = ?');
  const lineOfDay = db.prepare(
    'SELECT 1 AS ok FROM sources WHERE rowid > ? AND rowid <= ? AND substr(occurred_at, 1, 10) = ? LIMIT 1'
  );
  const groupOf: Record<string, string> = {
    claims: 'claims',
    episode: 'episodes',
    affinity: 'affinity',
    description: 'descriptions',
  };
  const out: Array<Proposal> = [];
  for (const row of db
    .prepare(
      "SELECT action, extra FROM decisions WHERE action LIKE 'proposed:%' AND retired_at IS NULL ORDER BY at, id"
    )
    .all<{ action: string; extra: string }>()) {
    const extra = parseJson(row.extra);
    const op: Op | undefined = extra?.op;
    if (!op || !extra) continue;
    const name = row.action.slice('proposed:'.length);
    const group = name.startsWith('people_') ? 'people' : (groupOf[name] ?? 'claims');
    const scope = scopeKeyOf(extra.scope);
    if (group === 'descriptions') {
      const run = runDay.get<{ cursor_from: number | null; cursor_to: number | null }>(extra.run);
      if (run && lineOfDay.get(run.cursor_from ?? 0, run.cursor_to ?? 0, day)) out.push({ scope, group, op });
      continue;
    }
    if (
      (op.sources ?? []).some(
        (id: string) => String(sourceDay.get<{ occurred_at: string }>(id)?.occurred_at ?? '').slice(0, 10) === day
      )
    )
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

export function analyzerWrites(db: SqlDb, day: string): Map<string, DayWrites> {
  const by = new Map<string, DayWrites>();
  const of = (row: ScopeColumns): DayWrites => {
    const key = scopeKeyOf(row) ?? 'other';
    let writes = by.get(key);
    if (!writes) by.set(key, (writes = { claims: [], episodes: [], affinity: [] }));
    return writes;
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
export function compareDay(
  db: SqlDb,
  {
    day,
    proposals,
    showsClaim,
  }: { day: string; proposals: Array<Proposal>; showsClaim: (a: string, b: { text: string }) => boolean }
): Array<Comparison> {
  const writes = analyzerWrites(db, day);
  const scopeOfSource = db.prepare('SELECT scope_kind, scope_iface, scope_dm FROM sources WHERE id = ?');
  const keys = [...new Set([...proposals.map((entry) => entry.scope ?? 'other'), ...writes.keys()])].sort();
  const words = (a: string, b: string) => showsClaim(a, { text: b }) || showsClaim(b, { text: a });
  const out: Array<Comparison> = [];
  for (const key of keys) {
    const mine = proposals.filter((entry) => (entry.scope ?? 'other') === key);
    const theirs = writes.get(key) ?? { claims: [], episodes: [], affinity: [] };
    const left: DayWrites = {
      claims: [...theirs.claims],
      episodes: [...theirs.episodes],
      affinity: [...theirs.affinity],
    };
    const take = <T>(list: Array<T>, match: (row: T) => boolean): T | null => {
      const at = list.findIndex(match);
      return at === -1 ? null : list.splice(at, 1)[0];
    };
    const result: Comparison = {
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
    for (const { group, op: proposed } of mine) {
      if (group === 'descriptions') {
        result.flags += 1;
        continue;
      }
      result.hers += 1;
      const sources = Array.isArray(proposed.sources) ? proposed.sources : [];
      if (sources.length === 0) result.unsupported += 1;
      if (sources.some((id) => scopeKeyOf(scopeOfSource.get<ScopeColumns>(id)) !== key)) result.violations += 1;
      let matched = null;
      if (group === 'claims') {
        matched =
          proposed.op === 'add'
            ? take(
                left.claims,
                (row) =>
                  row.subjectId === proposed.subjectId &&
                  row.kind === proposed.kind &&
                  words(row.text, proposed.text ?? '')
              )
            : take(left.claims, (row) => row.claimId === proposed.id);
      } else if (group === 'episodes') {
        matched = take(
          left.episodes,
          (row) => row.subjectId === proposed.subjectId && words(row.what, proposed.what ?? '')
        );
      } else if (group === 'affinity') {
        matched = take(
          left.affinity,
          (row) => row.personId === proposed.personId && Math.sign(row.delta) === Math.sign(proposed.delta ?? 0)
        );
      }
      if (matched) result.both += 1;
      else result.onlyHers.push({ group, op: proposed });
    }
    for (const group of ['claims', 'episodes', 'affinity'] as const)
      for (const row of left[group]) result.onlyAnalyzer.push({ group, row });
    out.push(result);
  }
  return out;
}

/** The lines of a comparison (counts; with `show` the texts of what only one side has). */
export function compareLines(results: Array<Comparison>, { show = false }: { show?: boolean } = {}): Array<string> {
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
  ring,
  path: writerPath,
  day,
  shadowOnly = false,
  scope = null,
  show = false,
  selfName = '',
  usage = { requests: 0, prompt: 0, completion: 0, cost: null },
  log = {},
}: CompareOptions): Promise<Array<string>> {
  const { sweep } = await import('../src/memory/db/session.ts');
  const { showsClaim } = await import('../src/memory/db/describe.ts');
  const { applyMemoryWrite } = await import('../src/memory/db/session-write.ts');
  const start = Date.parse(`${day}T00:00:00.000Z`);
  const end = start + DAY_MS;
  const lines = [];
  let proposals: Array<Proposal> = [];
  if (!shadowOnly) {
    const db = sqlOf(handle);
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
          minLines: 0,
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
      write: async (update: Rec) => applyMemoryWrite(handle, update),
      llm,
      hot: { config, prompts: hot.prompts },
      env: {},
      ring,
      path: writerPath,
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
            for (const op of (run.plan as Record<string, Array<Untyped> | undefined>)[group] ?? [])
              proposals.push({ scope: run.scope, group, op });
      }
      // A batch that failed outright leaves its lines where they were: the next sweep would ask again, so stop.
      if (
        !worked ||
        result.runs.some((run) => !['quiet', 'ok', 'all_dropped', 'skipped', 'applied_before'].includes(run.outcome))
      )
        break;
    }
  } else {
    proposals = storedProposals(sqlOf(handle), day).filter((entry) => !scope || entry.scope === scope);
  }
  lines.push(
    `day ${day}, ${shadowOnly ? 'the shadow proposals already stored' : 'her session in shadow over the lines of the day'}`
  );
  lines.push(
    ...compareLines(
      compareDay(sqlOf(handle), { day, proposals, showsClaim }).filter((result) => !scope || result.scope === scope),
      { show }
    )
  );
  const cost = usage.cost === null || usage.cost === undefined ? '-' : `${Math.round(usage.cost * 10000) / 10000} USD`;
  lines.push(`requests ${usage.requests}, tokens ${usage.prompt} prompt, ${usage.completion} completion, cost ${cost}`);
  return lines;
}

/** The compare subcommand (see the head of this file). */
async function compareMain(argv: Array<string>, routes: Variant) {
  const flags = parseFlags(argv, {
    values: ['--db', '--data', '--day', '--scope', '--self-name', '--keep'],
    switches: ['--shadow', '--show'],
    usage: COMPARE_USAGE,
  });
  if (flags._.length > 0 || !flags['--db'] || !flags['--day']) throw new CliError(COMPARE_USAGE);
  if (!DAY_RE.test(flags['--day']) || !Number.isFinite(Date.parse(`${flags['--day']}T00:00:00.000Z`)))
    throw new CliError(`memory-session: --day is a date, YYYY-MM-DD\n${COMPARE_USAGE}`);
  const source = path.resolve(flags['--db']);
  if (!fs.existsSync(source)) throw new CliError(`memory-session: no database at ${source}`);
  const shadowOnly = flags['--shadow'] === true;

  const { createHot } = await import('../src/hot.ts');
  const { openMemoryDb } = await import('../src/memory/db/open.ts');
  const hot = routedHot(createHot({ rootDir: ROOT, privateDir: privateDirOf(ROOT) }), routes);
  const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memory-session-'));
  const copy = flags['--keep'] ? path.resolve(flags['--keep']) : path.join(work, 'memory.db');
  let handle: Awaited<ReturnType<typeof openMemoryDb>> | null = null;
  let routing: ScriptRouting | null = null;
  try {
    const config = hot.config;
    const counters = { data: {}, markDirty() {} };
    if (!shadowOnly) {
      const { createLlm } = await import('../src/llm/openrouter.ts');
      const { createCalibrator } = await import('../src/llm/tokens.ts');
      routing = await scriptRouting(TOOL, {
        privateDir: privateDirOf(ROOT),
        roles: ['memory'],
        variant: routes,
        getConfig: () => config,
        createDirect: (keys, getConfig) =>
          createLlm({ apiKey: '', keys, getConfig, calibrator: createCalibrator(undefined), state: counters }),
        state: counters,
      });
      process.stderr.write(routesText(TOOL, routing.said));
    }
    if (fs.existsSync(copy)) throw new CliError(`memory-session: ${copy} already exists`);
    await copyDatabase(source, copy);
    handle = openMemoryDb(copy);
    const usage: Usage = {
      requests: 0,
      prompt: 0,
      completion: 0,
      cost: null,
    };
    let llm = null;
    if (routing !== null) {
      const client = routing.llm;
      llm = {
        complete: withBackoff(
          async (messages, options: Untyped = {}) => {
            const completion: Untyped = await client.complete(messages, {
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
            onWait: (ms: number, attempt: Untyped) =>
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
      ring: routing?.ring ?? null,
      path: routing?.memoryPath,
      day: flags['--day'],
      shadowOnly,
      scope: flags['--scope'] ?? null,
      show: flags['--show'] === true,
      selfName: flags['--self-name'] ?? config.bot?.name ?? '',
      usage,
      log: {
        info() {},
        debug() {},
        warn: (message: Untyped, fields: Rec) => process.stderr.write(`${message} ${JSON.stringify(fields ?? {})}\n`),
        error() {},
      },
    });
    return `${[`copy: ${flags['--keep'] ? 'kept' : 'temporary'}, schema ok`, ...lines].join('\n')}\n`;
  } finally {
    handle?.close();
    hot.close?.();
    await routing?.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** The session's request client over the routing's: marked as the tool's own, counted, tried again after a 429. */
function countedClient(client: ScriptRouting['llm'], usage: { requests: number; prompt: number; completion: number }) {
  return withBackoff(
    async (messages, options: Untyped = {}) => {
      const completion: Untyped = await client.complete(messages, {
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
      onWait: (ms: number, attempt: Untyped) =>
        process.stderr.write(`${TOOL}: 429, waiting ${Math.round(ms / 1000)} s (try ${attempt} of ${TRIES})\n`),
    }
  );
}

/** The lines of one scope's run of a sweep: its outcome, what it kept and dropped, its errors. */
function scopeLines(run: Untyped, show: boolean): Array<string> {
  const lines = [`${run.outcome}, ${run.lines} lines`];
  if (run.counts && run.plan) {
    const dropped =
      Object.entries<number>(run.counts.dropped ?? {})
        .map(([reason, n]) => `${reason} ${n}`)
        .join(', ') || 'none';
    lines.push(`kept ${run.counts.kept}: ${opKinds(run.plan)}; dropped: ${dropped}`);
    if (show) lines.push(JSON.stringify(run.plan));
  }
  if (run.errors?.length) lines.push(`errors: ${run.errors.join(', ')}`);
  return lines;
}

/** The lines of a description review: its status and, when it passed, the sizes and what it kept, lost and gained. */
function reviewLines(reviewed: Untyped, show: boolean): Array<string> {
  const lines = [
    `${reviewed.status}${reviewed.code ? ` (${reviewed.code}${reviewed.step ? ` at ${reviewed.step}` : ''})` : ''}`,
  ];
  if (reviewed.status !== 'ok') return lines;
  const { extra } = reviewed.row;
  lines.push(
    `draft ${[...reviewed.draft].length} characters, final ${[...reviewed.final].length} characters, cap ${extra.cap}${extra.overCap ? ', over the cap' : ''}, kept ${reviewed.row.kept}, lost ${reviewed.row.removed}, gained ${reviewed.row.added}`
  );
  if (show) lines.push(`draft: ${reviewed.draft}`, `final: ${reviewed.final}`, `reason: ${reviewed.reason}`);
  return lines;
}

/** What one run of the session reads besides its variant. */
type SessionRunInput = {
  source: string;
  copy: string;
  kept: boolean;
  scope: string | undefined;
  limit: number | undefined;
  review: ReturnType<typeof parseSubject> | null;
  show: boolean;
  selfName: string | undefined;
};

/**
 * Her session once, on a fresh copy of the database at `input.copy`, with the roles of `variant` replaced: the blocks of
 * its report, each under the input it answers (`scope <key>`, `requests`, `review <subject>`).
 */
async function sessionRun(
  input: SessionRunInput,
  variant: { label: string; routes: Variant }
): Promise<Array<{ input: string; lines: Array<string> }>> {
  const { createHot } = await import('../src/hot.ts');
  const { createLlm } = await import('../src/llm/openrouter.ts');
  const { createCalibrator } = await import('../src/llm/tokens.ts');
  const { openMemoryDb } = await import('../src/memory/db/open.ts');
  const { sweep, sessionSettings } = await import('../src/memory/db/session.ts');
  const { reviewDescription } = await import('../src/memory/db/describe.ts');
  const { applyMemoryWrite } = await import('../src/memory/db/session-write.ts');

  const hot = routedHot(createHot({ rootDir: ROOT, privateDir: privateDirOf(ROOT) }), variant.routes);
  const blocks: Array<{ input: string; lines: Array<string> }> = [];
  let handle: Untyped = null;
  let routing: ScriptRouting | null = null;
  try {
    // The effective config: shadow, a sweep of the tool's own.
    const live = hot.config;
    const config = {
      ...live,
      memoryDb: {
        ...(live.memoryDb ?? {}),
        session: {
          ...(live.memoryDb?.session ?? {}),
          mode: 'shadow',
          minMessages: 1,
          minLines: 0,
          sweepsPerScopePerDay: 1_000_000,
          settleMinutes: 0,
          ...(input.limit ? { maxMessages: input.limit } : {}),
        },
      },
    };
    const counters = { data: {}, markDirty() {} };
    routing = await scriptRouting(TOOL, {
      privateDir: privateDirOf(ROOT),
      roles: ['memory'],
      variant: variant.routes,
      getConfig: () => config,
      createDirect: (keys, getConfig) =>
        createLlm({ apiKey: '', keys, getConfig, calibrator: createCalibrator(undefined), state: counters }),
      state: counters,
    });
    process.stderr.write(routesText(TOOL, routing.said));
    if (fs.existsSync(input.copy)) throw new CliError(`${TOOL}: ${input.copy} already exists`);
    await copyDatabase(input.source, input.copy);
    handle = openMemoryDb(input.copy);
    const settings = sessionSettings(config);
    blocks.push({
      input: 'copy',
      lines: [
        `${input.kept ? 'kept' : 'temporary'}, schema ok, mode shadow, up to ${settings.maxMessages} lines a request, model role memory`,
      ],
    });
    const usage = { requests: 0, prompt: 0, completion: 0 };
    const { memoryPath } = routing;
    const ctx = {
      db: sqlOf(handle),
      write: async (update: Rec) => applyMemoryWrite(handle, update),
      llm: { complete: countedClient(routing.llm, usage) },
      hot: { config, prompts: hot.prompts },
      env: {},
      ring: routing.ring,
      path: () => memoryPath(),
      now: Date.now,
      log: {
        info() {},
        debug() {},
        warn: (message: Untyped, fields: Rec) => process.stderr.write(`${message} ${JSON.stringify(fields ?? {})}\n`),
        error() {},
      },
      selfName: input.selfName ?? live.bot?.name ?? '',
    };

    const result: Untyped = await sweep(ctx, { scope: input.scope, limit: input.limit, ignoreSweepCap: true });
    if (result.status !== 'ok') blocks.push({ input: 'sweep', lines: [`${result.status} (${result.code})`] });
    for (const run of result.runs) blocks.push({ input: `scope ${run.scope}`, lines: scopeLines(run, input.show) });
    blocks.push({
      input: 'requests',
      lines: [`${usage.requests}, tokens ${usage.prompt} prompt, ${usage.completion} completion`],
    });

    const { review } = input;
    if (review) {
      const reviewed: Untyped = await reviewDescription(sqlOf(handle), review.subject, review.field, { ctx });
      blocks.push({
        input: `review ${review.subject.kind} ${review.field}`,
        lines: [
          ...reviewLines(reviewed, input.show),
          `requests ${usage.requests}, tokens ${usage.prompt} prompt, ${usage.completion} completion`,
        ],
      });
    }
  } finally {
    handle?.close();
    hot.close?.();
    await routing?.close();
  }
  return blocks;
}

/** Runs the tool; returns the text to print. */
export async function main(argv: Array<string>): Promise<string> {
  const taken = takeRouteFlags(TOOL, argv, { variants: argv[0] !== 'compare' });
  const [first] = taken.variants;
  if (taken.argv[0] === 'compare') return compareMain(taken.argv.slice(1), first.routes);
  const flags = parseFlags(taken.argv, {
    values: ['--db', '--data', '--scope', '--limit', '--review', '--self-name', '--keep'],
    switches: ['--show'],
    usage: USAGE,
  });
  if (flags._.length > 0 || !flags['--db']) throw new CliError(USAGE);
  const source = path.resolve(flags['--db']);
  if (!fs.existsSync(source)) throw new CliError(`${TOOL}: no database at ${source}`);
  const limit = flags['--limit'] === undefined ? undefined : Number(flags['--limit']);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
    throw new CliError(`${TOOL}: --limit is a whole number above 0\n${USAGE}`);
  const { variants } = taken;
  if (variants.length > 1 && flags['--keep'])
    throw new CliError(`${TOOL}: --keep names one copy, so it takes no --variant`);

  const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memory-session-'));
  const runs: Array<Array<{ input: string; lines: Array<string> }>> = [];
  try {
    for (const [i, variant] of variants.entries()) {
      const copy = flags['--keep'] ? path.resolve(flags['--keep']) : path.join(work, `memory-${i + 1}.db`);
      runs.push(
        await sessionRun(
          {
            source,
            copy,
            kept: Boolean(flags['--keep']),
            scope: flags['--scope'],
            limit,
            review: flags['--review'] ? parseSubject(flags['--review']) : null,
            show: flags['--show'] === true,
            selfName: flags['--self-name'],
          },
          variant
        )
      );
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const lines =
    runs.length === 1
      ? runs[0].flatMap((block) => [
          `${block.input}: ${block.lines[0] ?? ''}`,
          ...block.lines.slice(1).map((line) => `  ${line}`),
        ])
      : sideBySideText(
          variants.map((variant) => variant.label),
          runs
        );
  return `${lines.join('\n')}\n`;
}

runCli(import.meta.url, main);
