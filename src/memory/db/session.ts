// Her memory session (plan 2026-10-20-memory-f, section 8; docs/prompt-contract.md, "Memory session"). She reads the
// new chat lines of one scope from the database and says what she keeps; the engine checks every part of the answer
// against what it sent, then writes it (shadow: as proposals; apply: into the database).
//
// sweep(ctx) -> { status, code?, runs[] }
//   A sweep is one pass over the scopes with new lines: the public channels of an interface together (`group:<iface>`),
//   each private conversation alone (`dm:<iface>:<person>`). Each scope has a cursor in `meta`
//   (`memory_session.cursor.<mode>.<scope>`, a `sources.rowid`), so a line is read once. At most `sweepsPerScopePerDay`
//   sweeps of one scope a UTC day (stage W3; the old `sweepsPerDay` is read when the new key is missing); a sweep whose
//   every scope with work is at its cap is refused (`sweep_cap`). `options.scopes` (a Set of scope keys) limits a sweep
//   to those scopes (the service's schedule, writer-switch.ts#dueScopes). One request per scope with at least
//   `minMessages` new lines, at most `maxMessages` lines each, serial.
//   The batch is the next lines by arrival (so none is ever skipped) shown in event time (`occurred_at`, then rowid);
//   when it holds more people than `maxPeople`, the batch is sent again with the next page of people (the same lines, the
//   next people), one request per page. The cursor moves, by compare-and-set and in the same transaction as the last
//   write, only when every page was written (or had been applied before); a failed request, an unreadable answer, a
//   write that failed and an `all_dropped` answer leave the lines for the next sweep. An `all_dropped` batch is
//   remembered as pending (`memory_session.pending.<mode>.<scope>`, with a retry count); after `retryLimit` tries it is
//   skipped, the cursor moves and a `decisions` row records why.
//
// The request (buildSessionRequest): the system text her turns get (system prompt, card, rules, format), then
// prompts/memory-session.md; the user content in blocks, stable first: <self> <place> <people> <episodes>
// <intentions> <batch>. People are rendered by the renderer her turns use (behavior/prompt.js#renderProfile) from the
// profile the database rebuilds (export.ts#exportOne), then the attitude (the affinity number) and the claims shown
// with their ids. Ids in the request are short and local: `#n` for lines, `cN` / `sN` for claims, `eN` for episodes.
// The answer is mapped back to database ids here; an id the request did not carry, a line it did not number, a kind or
// a source list that is missing or wrong is dropped and counted, never guessed.
//
// Context (`ctx`): { db (a connection that can read), write (session-write.ts through the writer: the service's
// `memoryWrite`), llm (`complete`), hot ({ config, prompts }), env, now, log, selfName, rng? }.
// The sweep reads hot.config at the moment of use. No provider reasoning is ever sent. Logs carry counts and codes.
//
// Schema v9 (stage 3): the request lists what it rendered (`reads`: the batch lines, the claims shown as `sN` / `cN`, the
// place descriptions, the places, the episodes and the intentions, each with its block and its order). When the request
// is assembled the run resolves them through service.ts#turnReadRows (the resolution her turns use) and writes them with
// its own write, in its context (`ctx:session:<run id>`), as `turn_reads` rows of `reader_kind` `session`, `turn_id` the
// run id, `step` the page. The claim version each `cN` / `sN` showed is the `base` of a confirm, revise or retire op on it
// (filled here, never by her answer); the writer refuses an op whose claim moved on since (`stale_base`). The profile
// text of a person is rendered whole by the turn renderer and its items are not listed one by one.
// A chat line's revisions are matched by the line's native tuple (authority, native kind, generation, native id).

import { block, fillPromptTemplate, renderProfile } from '../../behavior/prompt.ts';
import { concernsMember, isOpen } from '../../intentions/model.ts';
import { ROLE_KEY_NAME } from '../../llm/openrouter.ts';
import { MEMORY_ROLE, roleModel } from '../../llm/roles.ts';
import { estimateMessages } from '../../llm/tokens.ts';
import { rulesPromptOf } from '../../rules-list.ts';
import { memoryPathText } from '../../subharness/memory-path.ts';
import type { MemoryPath } from '../../subharness/memory-path.ts';
import { exportOne } from './export.ts';
import { SELF_PERSON, nativeOf, shortHash } from './ids.ts';
import { audienceOf, contextRow, dmContext, groupContext, issueContext, scopeWhere, wellFormed } from './scope.ts';
import { columnsOf } from './rows.ts';
import { turnReadRows } from './service.ts';
import { MEMORY_LIMITS, RELATIONSHIP_LIMITS } from '../text-limits.ts';
import { asText, isFiniteNumber, isWholeNumber } from './types.ts';
import { sessionRequestId } from './request-archive.ts';
import type { Intention } from '../../intentions/types.ts';
import type { KeyRing } from '../../keys/ring.ts';
import type { Labels, Profile } from '../../turn/request/types.ts';
import type { Config, Db, Log, Row } from './types.ts';
import type { Track } from '../../loop-watch.ts';
import { untracked } from '../../loop-watch.ts';
import type { Context, Scope } from './scope.ts';

export const SESSION_PURPOSE = 'memory-session';
/** The blocks of a session request's user content, in their order. */
const SESSION_BLOCKS: ReadonlyArray<string> = Object.freeze([
  'self',
  'place',
  'people',
  'episodes',
  'intentions',
  'batch',
]);
export const CLAIM_KINDS: ReadonlyArray<string> = Object.freeze([
  'detail',
  'interest',
  'alias',
  'injoke',
  'self_fact',
  'lesson',
  'pattern',
]);
export const HOW: ReadonlyArray<string> = Object.freeze(['said', 'saw', 'claimed', 'inferred', 'taught']);
export const TRUTHS: ReadonlyArray<string> = Object.freeze(['historical', 'disputed', 'retired']);
export const DESCRIPTION_FIELDS: ReadonlyArray<string> = Object.freeze([
  'character',
  'style',
  'relationship',
  'purpose',
  'topics',
  'tone',
  'patterns',
  'starters',
  'self_view',
]);
/** Status codes. */
export const CODES = Object.freeze({
  OFF: 'off',
  NOT_CONFIGURED: 'not_configured',
  NO_PROMPT: 'no_prompt',
  SWEEP_CAP: 'sweep_cap',
  NOT_READY: 'not_ready',
});
export const pendingKey = (mode: unknown, scopeKey: unknown): string =>
  `memory_session.pending.${asText(mode)}.${asText(scopeKey)}`;

const DEFAULTS = Object.freeze({
  mode: 'off',
  maxMessages: 200,
  minMessages: 5,
  sweepsPerScopePerDay: 24,
  everyMinutes: 60,
  reviewsPerDay: 6,
  settleMinutes: 10,
  minLines: 0,
  batchLines: 30,
  maxWaitHours: 24,
  since: null,
  maxPeople: 12,
  claimsPerPerson: 30,
  selfMax: 40,
  episodesMax: 20,
  maxOutputTokens: 8000,
  timeoutMs: 300000,
  descriptionMaxOutputTokens: 1500,
  retryLimit: 3,
});
const MODES: ReadonlyArray<unknown> = ['off', 'shadow', 'apply'];
const MINUTE = 60_000;

const posInt = (value: unknown, fallback: number): number => (isWholeNumber(value) && value > 0 ? value : fallback);

/** The session settings of this moment (see `sessionSettings`). */
export type SessionSettings = {
  mode: string;
  maxMessages: number;
  minMessages: number;
  sweepsPerScopePerDay: number;
  everyMinutes: number;
  reviewsPerDay: number;
  settleMinutes: number;
  minLines: number;
  batchLines: number;
  maxWaitHours: number;
  since: string | null;
  maxPeople: number;
  claimsPerPerson: number;
  selfMax: number;
  episodesMax: number;
  maxOutputTokens: number;
  timeoutMs: number;
  descriptionMaxOutputTokens: number;
  retryLimit: number;
};

/** The session settings of this moment, from the live config. */
export function sessionSettings(configGiven: unknown): SessionSettings {
  const config = configGiven as Config | null | undefined;
  const given = config?.memoryDb?.session ?? {};
  const at = (value: unknown): number => (typeof value === 'number' ? value : NaN);
  return {
    mode: MODES.includes(given.mode) ? (given.mode as string) : DEFAULTS.mode,
    maxMessages: posInt(given.maxMessages, DEFAULTS.maxMessages),
    minMessages: posInt(given.minMessages, DEFAULTS.minMessages),
    // Per scope since stage W3; the old daily key stands in while the new one is missing.
    sweepsPerScopePerDay: posInt(given.sweepsPerScopePerDay, posInt(given.sweepsPerDay, DEFAULTS.sweepsPerScopePerDay)),
    everyMinutes:
      Number.isFinite(at(given.everyMinutes)) && at(given.everyMinutes) >= 0
        ? at(given.everyMinutes)
        : DEFAULTS.everyMinutes,
    reviewsPerDay:
      Number.isInteger(given.reviewsPerDay) && at(given.reviewsPerDay) >= 0
        ? at(given.reviewsPerDay)
        : DEFAULTS.reviewsPerDay,
    // Production value, config cut of 2026-10-31.
    settleMinutes: DEFAULTS.settleMinutes,
    minLines: isWholeNumber(given.minLines) && given.minLines >= 0 ? given.minLines : DEFAULTS.minLines,
    batchLines: posInt(given.batchLines, DEFAULTS.batchLines),
    maxWaitHours:
      typeof given.maxWaitHours === 'number' && Number.isFinite(given.maxWaitHours) && given.maxWaitHours > 0
        ? given.maxWaitHours
        : DEFAULTS.maxWaitHours,
    since: typeof given.since === 'string' && given.since ? given.since : null,
    maxPeople: posInt(given.maxPeople, DEFAULTS.maxPeople),
    claimsPerPerson: posInt(given.claimsPerPerson, DEFAULTS.claimsPerPerson),
    selfMax: posInt(given.selfMax, DEFAULTS.selfMax),
    episodesMax: posInt(given.episodesMax, DEFAULTS.episodesMax),
    maxOutputTokens: posInt(given.maxOutputTokens, DEFAULTS.maxOutputTokens),
    timeoutMs: posInt(given.timeoutMs, DEFAULTS.timeoutMs),
    descriptionMaxOutputTokens: posInt(given.descriptionMaxOutputTokens, DEFAULTS.descriptionMaxOutputTokens),
    retryLimit: posInt(given.retryLimit, DEFAULTS.retryLimit),
  };
}

/**
 * Whether the memory role has a key. With a key ring (`keys.json` exists) it is the key the ring routes `memory` to:
 * the extra key the role is bound to, else the core key in use; `llm.keyByRole` and `env` are not read. Without a ring,
 * `llm.keyByRole.memory` names a variable (OPENROUTER_*) that is set in `env`, and no other key stands in. `name` is the
 * key's or the variable's name, never its value.
 */
export function memoryKeyState(
  config: Config | null | undefined,
  env: Row | null | undefined,
  ring?: KeyRing | null
): { ok: boolean; name: string | null } {
  if (ring) {
    const route = ring.route(MEMORY_ROLE);
    return route === null ? { ok: false, name: null } : { ok: true, name: route.name };
  }
  const name = config?.llm?.keyByRole?.memory;
  const valid = typeof name === 'string' && ROLE_KEY_NAME.test(name);
  const value = valid && env ? env[name] : undefined;
  return { ok: typeof value === 'string' && value.trim() !== '', name: valid ? name : null };
}

/**
 * Why the session cannot run now, or null: `off` (mode), `not_configured` (no key of its own), `no_prompt`.
 */
export function refusalOf(
  config: Config | null | undefined,
  env: Row | null | undefined,
  prompts: Row | null | undefined,
  ring?: KeyRing | null
): string | null {
  const { mode } = sessionSettings(config);
  if (mode === 'off') return CODES.OFF;
  if (!memoryKeyState(config, env, ring).ok) return CODES.NOT_CONFIGURED;
  const prompt = prompts?.['memory-session'];
  if (typeof prompt !== 'string' || !prompt.trim()) return CODES.NO_PROMPT;
  return null;
}

/** The system text her turns get (system prompt, card, rules, format), then `extra` (a prompt of the memory family). */
export function systemTextOf(prompts: Row | null | undefined, selfName: unknown, extra: unknown): string {
  const fill = (text: string) => fillPromptTemplate(text, { name: selfName });
  return [
    prompts?.['system-prompt'],
    prompts?.['character-card'],
    rulesPromptOf(prompts?.rules),
    prompts?.format,
    extra,
  ]
    .map((text) => (typeof text === 'string' ? fill(text) : ''))
    .filter(Boolean)
    .join('\n\n');
}

const parseJson = (text: unknown): unknown => {
  if (typeof text !== 'string' || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** `2026-10-24 10:05` in `timezone` (a line's time in the batch, the cutoff). */
export function stamp(ms: number, timezone: unknown = 'UTC'): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone as string,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(ms);
  return parts.replace(/ /g, ' ');
}

// ---------- scopes and batches ----------

/**
 * `current`: the newest revision of a chat line, not retired, not deleted (alias `s`). The line's revisions are the rows
 * of the same native tuple: the authority, the native kind and generation (schema v8) and the native id, so two
 * interfaces' ids that are the same string never meet; a database before v8 has only the native id.
 */
function currentSql(db: Db): string {
  const same = (t: string): string =>
    columnsOf(db, 'sources').has('native_kind')
      ? `${t}.native_id = s.native_id AND ${t}.authority_id IS s.authority_id AND ${t}.native_kind IS s.native_kind AND ${t}.generation IS s.generation`
      : `${t}.native_id = s.native_id`;
  return `s.kind IN ('seen', 'said') AND s.retired_at IS NULL
  AND s.revision IS (SELECT MAX(t.revision) FROM sources t WHERE ${same('t')} AND t.kind IN ('seen', 'said') AND t.retired_at IS NULL)
  AND s.rowid = (SELECT MIN(t.rowid) FROM sources t WHERE ${same('t')} AND t.kind IN ('seen', 'said') AND t.retired_at IS NULL AND t.revision IS s.revision)
  AND NOT EXISTS (SELECT 1 FROM sources d WHERE ${same('d')} AND d.kind = 'deleted' AND d.retired_at IS NULL)`;
}

/**
 * A scope as the sweep walks it: `{ key, scope: { scope_kind, scope_iface, scope_dm }, ctx }`; read through `audience_id`
 * (`audienceColumn`: the entry also carries `audienceId`, and its context reads that column), else through the triple.
 */
/** A scope as the sweep walks it: its key, the triple, the context that reads it and, with `audienceColumn`, its audience. */
export type SweepScope = { key: string; scope: Scope; ctx: Context; audienceId?: string };

function scopeOf(row: Row, audienceColumn = false): SweepScope {
  const entry: SweepScope =
    row.scope_kind === 'group'
      ? {
          key: `group:${asText(row.scope_iface)}`,
          scope: { scope_kind: 'group', scope_iface: row.scope_iface as string, scope_dm: null },
          ctx: groupContext(row.scope_iface as string),
        }
      : {
          key: `dm:${asText(row.scope_iface)}:${asText(row.scope_dm)}`,
          scope: { scope_kind: 'dm', scope_iface: row.scope_iface as string, scope_dm: row.scope_dm as string },
          ctx: dmContext(row.scope_dm as string, row.scope_iface as string),
        };
  if (audienceColumn !== true) return entry;
  return { ...entry, audienceId: audienceOf(entry.scope).audience_id, ctx: { ...entry.ctx, audienceColumn: true } };
}

/**
 * The scopes that have chat lines, group first, in a stable order. `audienceColumn`: read them through `audience_id`.
 * A triple that names no valid audience (a DM whose partner is not a person id of its interface) is not a scope of its
 * own: its lines are internal (scope.ts#audienceOf), never read as a conversation.
 */
export function scopesOf(
  dbGiven: unknown,
  { audienceColumn = false }: { audienceColumn?: boolean } = {}
): Array<SweepScope> {
  const db = dbGiven as Db;
  const rows = db
    .prepare(
      `SELECT DISTINCT scope_kind, scope_iface, scope_dm FROM sources
      WHERE kind IN ('seen', 'said') AND retired_at IS NULL AND scope_kind IN ('group', 'dm') AND scope_iface IS NOT NULL
      ORDER BY scope_kind, scope_iface, scope_dm`
    )
    .all();
  return rows.filter((row) => wellFormed(row)).map((row) => scopeOf(row, audienceColumn));
}

export const cursorKey = (mode: unknown, scopeKey: unknown): string =>
  `memory_session.cursor.${asText(mode)}.${asText(scopeKey)}`;

const metaOf = (db: Db, key: string): unknown =>
  db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;

/** One line of a batch: a `sources` row with its time as epoch milliseconds in `at`. */
export type BatchLine = Row & { at: number; rowid: number };

/**
 * The lines of a scope after its cursor (the next `maxMessages` by arrival, so none is skipped), cut at the first line
 * newer than `settleBefore` (ms), then put in event time: `occurred_at`, then `rowid`. With `audienceId` the scope is
 * read through `audience_id`, else through the triple.
 */
export function batchOf(
  dbGiven: unknown,
  scope: Scope,
  {
    cursor,
    since,
    maxMessages,
    settleBefore,
    audienceId = null,
  }: { cursor: number; since: string | null; maxMessages: number; settleBefore: number; audienceId?: string | null }
): Array<BatchLine> {
  const db = dbGiven as Db;
  const where = ['s.rowid > ?'];
  const params: Array<unknown> = [cursor];
  if (typeof audienceId === 'string' && audienceId) {
    where.push('s.audience_id = ?');
    params.push(audienceId);
  } else {
    where.push('s.scope_kind = ?', 's.scope_iface = ?');
    params.push(scope.scope_kind, scope.scope_iface);
    if (scope.scope_kind === 'dm') {
      where.push('s.scope_dm = ?');
      params.push(scope.scope_dm);
    }
  }
  where.push(currentSql(db));
  if (since) {
    where.push('s.occurred_at >= ?');
    params.push(since);
  }
  // Schema v8: a line by a thread-local poster names its participant.
  const participant = columnsOf(db, 'sources').has('author_participant') ? 's.author_participant' : 'NULL';
  const rows = db
    .prepare(
      `SELECT s.rowid AS rowid, s.id, s.native_id, s.kind, s.place_id, s.author_account, ${participant} AS author_participant, s.occurred_at, s.text, s.direct
       FROM sources s WHERE ${where.join(' AND ')} ORDER BY s.rowid LIMIT ?`
    )
    .all(...params, maxMessages);
  const out: Array<BatchLine> = [];
  for (const row of rows) {
    const at = Date.parse(row.occurred_at as string);
    if (Number.isFinite(settleBefore) && Number.isFinite(at) && at > settleBefore) break;
    out.push({ ...row, at: Number.isFinite(at) ? at : 0, rowid: row.rowid as number });
  }
  return out.sort((a, b) => a.at - b.at || a.rowid - b.rowid);
}

/** Whether a batch is written now, and the settled sessions it holds (see `joinOf`). */
export type JoinVerdict = {
  write: boolean;
  sessions: number;
  reason: 'off' | 'large' | 'batch' | 'deadline' | 'wait';
};

/**
 * Whether the settled lines of a scope are written now. A session is a run of lines in event time (`at`); a gap of
 * `settleMinutes` or more starts the next one. First match wins: `minLines` 0 writes (`off`); a session of more than
 * `minLines` lines writes (`large`); `batchLines` joined lines write (`batch`); an oldest line `maxWaitHours` old
 * writes (`deadline`); otherwise the scope waits and its lines join the next batch (`wait`). Pure. `batch` is what
 * `batchOf` returns.
 */
export function joinOf(batch: ReadonlyArray<BatchLine>, settings: SessionSettings, now: number): JoinVerdict {
  const gap = settings.settleMinutes * MINUTE;
  const sorted = [...batch].sort((a, b) => a.at - b.at);
  let sessions = 0;
  let size = 0;
  let largest = 0;
  sorted.forEach((line, index) => {
    if (index === 0 || line.at - sorted[index - 1].at >= gap) {
      sessions += 1;
      size = 0;
    }
    size += 1;
    largest = Math.max(largest, size);
  });
  const verdict = (write: boolean, reason: JoinVerdict['reason']): JoinVerdict => ({ write, sessions, reason });
  if (settings.minLines === 0) return verdict(true, 'off');
  if (largest > settings.minLines) return verdict(true, 'large');
  if (sorted.length >= settings.batchLines) return verdict(true, 'batch');
  if (sorted.length > 0 && now - sorted[0].at >= settings.maxWaitHours * 60 * MINUTE) return verdict(true, 'deadline');
  return verdict(false, 'wait');
}

// ---------- the request ----------

const foldName = (text: unknown): string =>
  asText(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The names and ids of the accounts and people a batch touches, and its authors: every account and participant (schema
 * v8) that wrote a line of it apart from her, in order of their first line, each with a handle `aN` (`authors`: handle ->
 * `{ kind: 'account' | 'participant', id, hasPerson }`). The handles are what `people:add` names; the request does not
 * render them yet (docs/prompt-contract.md).
 */
/** An account a batch touches: its person, its native id and its first name. */
type BatchAccount = { personId: unknown; native: string; name: string };
/** An author of a batch who may be added as a person: an account or a participant. */
export type BatchAuthor = { kind: 'account' | 'participant'; id: string; hasPerson: boolean };
/** A person a batch touches: the id, the native id and the name, with the count of lines. */
export type BatchPerson = { id: string; native: string; name: string; count: number };

function peopleOf(
  db: Db,
  batch: ReadonlyArray<Row>,
  selfName: unknown
): {
  accounts: Map<string, BatchAccount>;
  participants: Map<string, { name: string }>;
  authors: Map<string, BatchAuthor>;
  people: Array<BatchPerson>;
  selfName: unknown;
} {
  const accountIds = [...new Set(batch.map((line) => line.author_account as string).filter(Boolean))];
  const accounts = new Map<string, BatchAccount>();
  for (const id of accountIds) {
    const row = db.prepare('SELECT id, person_id, native_id, names FROM accounts WHERE id = ?').get(id);
    if (!row) continue;
    const names = parseJson(row.names);
    accounts.set(id, {
      personId: row.person_id,
      native: (row.native_id ?? nativeOf(id)) as string,
      name:
        Array.isArray(names) && typeof names[0] === 'string' && names[0] ? names[0] : ((row.native_id ?? id) as string),
    });
  }
  const participants = new Map<string, { name: string }>();
  for (const id of new Set(batch.map((line) => line.author_participant as string).filter(Boolean))) {
    const row = db.prepare('SELECT id, display FROM participants WHERE id = ?').get(id);
    if (row) participants.set(id, { name: (row.display as string) || '?' });
  }
  const authors = new Map<string, BatchAuthor>();
  const handled = new Set<string>();
  for (const line of batch) {
    if (line.kind === 'said') continue;
    const entry: { kind: 'account' | 'participant'; id: string } | null =
      line.author_participant && participants.has(line.author_participant as string)
        ? { kind: 'participant', id: line.author_participant as string }
        : line.author_account && accounts.has(line.author_account as string)
          ? { kind: 'account', id: line.author_account as string }
          : null;
    if (!entry || handled.has(entry.id)) continue;
    handled.add(entry.id);
    authors.set(`a${authors.size + 1}`, {
      ...entry,
      hasPerson: entry.kind === 'account' ? Boolean(accounts.get(entry.id)?.personId) : false,
    });
  }
  const byPerson = new Map<unknown, BatchPerson>();
  for (const line of batch) {
    if (line.kind === 'said') continue;
    const account = accounts.get(line.author_account as string);
    if (!account?.personId) continue;
    const entry: BatchPerson = byPerson.get(account.personId) ?? {
      id: account.personId as string,
      native: account.native,
      name: account.name,
      count: 0,
    };
    entry.count += 1;
    byPerson.set(account.personId, entry);
  }
  return {
    accounts,
    participants,
    authors,
    people: [...byPerson.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    selfName,
  };
}

/** One line of the batch: `#n [time] [pN] name: text`, a line addressed to her led by `→ `, her own under her self label. */
function lineText(
  line: BatchLine,
  n: number,
  {
    accounts,
    participants,
    selfName,
    labels,
    timezone,
    handle,
    authorHandle = null,
  }: {
    accounts: Map<string, BatchAccount>;
    participants: Map<string, { name: string }>;
    selfName: unknown;
    labels: Row;
    timezone: unknown;
    handle: string | null;
    authorHandle?: string | null;
  }
): string {
  const own = line.kind === 'said';
  const author = own
    ? asText(labels?.self ?? '{name}').replace('{name}', String(selfName))
    : (accounts.get(line.author_account as string)?.name ??
      participants?.get(line.author_participant as string)?.name ??
      line.author_account ??
      '?');
  const lead = !own && line.direct ? '→ ' : '';
  const place = handle ? `[${handle}] ` : '';
  // An author who is not a person yet carries the handle `people:add` names (prompts/memory-session.md, "People").
  const who = !own && authorHandle ? `[${authorHandle}] ` : '';
  return `${lead}#${n} [${stamp(line.at, timezone)}] ${place}${who}${asText(author)}: ${String(line.text).replace(/\s*\n\s*/g, ' ⏎ ')}`;
}

function claimLine(label: unknown, row: Row): string {
  const text = asText(row.text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return `[${asText(label)}] ${row.kind ? `${asText(row.kind)}: ` : ''}${text}`;
}

function currentDescriptions(db: Db, subjectIds: ReadonlyArray<unknown>, ctx: Context): Array<Row> {
  if (subjectIds.length === 0) return [];
  const scope = scopeWhere(ctx, 'd');
  return db
    .prepare(
      `SELECT d.id AS id, d.subject_id AS subject_id, d.field AS field, v.text AS text FROM descriptions d JOIN description_versions v ON v.id = d.current_version
      WHERE d.retired_at IS NULL AND d.subject_id IN (${subjectIds.map(() => '?').join(', ')}) AND ${scope.sql} ORDER BY d.subject_id, d.field`
    )
    .all(...subjectIds, ...scope.params);
}

/** How many requests a batch takes: its people, `maxPeople` to a request (one request at least). */
export function pagesOf(db: Db, batch: ReadonlyArray<Row>, config: Config, selfName = ''): number {
  return Math.max(1, Math.ceil(peopleOf(db, batch, selfName).people.length / sessionSettings(config).maxPeople));
}

/** The claim / episode ids a profile may not show as of `cutoff` (created or last seen after it). */
function lateIds(db: Db, ids: ReadonlyArray<string>, cutoff: unknown): Set<unknown> {
  if (ids.length === 0) return new Set();
  const marks = ids.map(() => '?').join(', ');
  const late = new Set<unknown>();
  for (const row of db
    .prepare(`SELECT id FROM claims WHERE id IN (${marks}) AND (created_at > ? OR last_seen_at > ?)`)
    .all(...ids, cutoff, cutoff))
    late.add(row.id);
  for (const row of db.prepare(`SELECT id FROM episodes WHERE id IN (${marks}) AND created_at > ?`).all(...ids, cutoff))
    late.add(row.id);
  return late;
}

/** A profile as of `cutoff`: the items whose claim or episode appeared or was seen again after it are left out. */
function profileAsOf(db: Db, profile: Row, cutoff: unknown): Row {
  const ids: Array<string> = [];
  for (const value of Object.values(profile)) {
    if (!Array.isArray(value)) continue;
    for (const item of value as Array<Row | null>)
      if (typeof item?.itemId === 'string' && item.itemId) ids.push(item.itemId);
  }
  const late = lateIds(db, [...new Set(ids)], cutoff);
  if (late.size === 0) return profile;
  const out: Row = { ...profile };
  for (const [key, value] of Object.entries(profile)) {
    if (Array.isArray(value))
      out[key] = (value as Array<Row | null>).filter(
        (item) => !(typeof item?.itemId === 'string' && late.has(item.itemId))
      );
  }
  return out;
}

/** What the answer's local ids stand for (see `buildSessionRequest`). */
export type RequestMaps = {
  sources: Map<string, string>;
  claims: Map<string, string>;
  episodes: Map<string, string>;
  places: Map<string, string>;
  authors: Map<string, BatchAuthor>;
  versions?: Map<string, unknown>;
};

/** A request of one batch page: the messages, the maps of its local ids, its counts and the reads it renders. */
export type SessionRequest = {
  messages: [
    { role: 'system'; content: string },
    { role: 'user'; content: Array<{ type: 'text'; text: string; cacheSegment?: 'stable' }> },
  ];
  maps: RequestMaps;
  lines: number;
  people: Array<BatchPerson>;
  places: Array<string>;
  pages: number;
  cutoff: number;
  reads: Array<{ kind: string; id: string; block: string; ord: number }>;
};

/**
 * The request of one batch (one page of its people). Returns `{ messages, maps, lines, people, places, pages, cutoff }`:
 * `maps` carries what the answer's local ids stand for (`sources`: `#n` -> source id, `claims`: `cN` / `sN` -> claim id,
 * `episodes`: `eN` -> episode id, `places`: `pN` -> place id, `authors`: `aN` -> an account or participant of the batch,
 * not rendered yet); `people` are the page's people (the answer's subjects);
 * `pages` is how many requests the batch takes. The context (profiles, claims, episodes) is as of the batch's
 * cutoff, the newest line: what was created or seen after it is left out.
 */
export function buildSessionRequest({
  db,
  scope,
  batch,
  config,
  prompts,
  selfName,
  now,
  page = 0,
}: {
  db: Db;
  scope: Pick<SweepScope, 'scope' | 'ctx'>;
  batch: ReadonlyArray<BatchLine>;
  config: Config;
  prompts: Row | null | undefined;
  selfName: unknown;
  now: number;
  page?: number;
}): SessionRequest {
  const settings = sessionSettings(config);
  const labels = (prompts?.labels ?? {}) as Labels & Row;
  const timezone = config?.bot?.timezone ?? 'UTC';
  const { ctx } = scope;
  const touched = peopleOf(db, batch, selfName);
  // What the request renders, in its order (turnReadRows resolves it to versions and revisions).
  const reads: Array<{ kind: string; id: string; block: string }> = [];
  const read = (kind: string, id: unknown, blockName: string): void => {
    if (typeof id === 'string' && id) reads.push({ kind, id, block: blockName });
  };
  const maps: RequestMaps = {
    sources: new Map(),
    claims: new Map(),
    episodes: new Map(),
    places: new Map(),
    authors: touched.authors,
  };
  const nameOf = (id: string): string | null => {
    for (const account of touched.accounts.values()) if (account.native === String(id)) return account.name;
    return null;
  };
  const pages = Math.max(1, Math.ceil(touched.people.length / settings.maxPeople));
  const cutoff = batch.length > 0 ? Math.max(...batch.map((line) => line.at)) : now;
  const cutoffIso = new Date(cutoff).toISOString();
  const early = (alias: string): string =>
    `(${alias}.created_at IS NULL OR ${alias}.created_at <= ?) AND (${alias}.last_seen_at IS NULL OR ${alias}.last_seen_at <= ?)`;

  // The places of the batch get a handle each (`p1`, ...), in order of their first line; the guilds they sit in follow.
  const placeIds = [...new Set(batch.map((line) => line.place_id as string).filter(Boolean))];
  // A DM place row the database made (schema v7) is not shown: the block stays as it was until its wording is written.
  const placeRows = placeIds
    .map((id) =>
      db
        .prepare(
          "SELECT id, kind, name, topic, parent_id FROM places WHERE id = ? AND (kind IS NOT 'dm' OR owner_key IS NOT NULL)"
        )
        .get(id)
    )
    .filter((row): row is Row => row !== undefined);
  const guilds = [...new Set(placeRows.map((row) => row.parent_id as string).filter(Boolean))];
  const handleOf = new Map<unknown, string>();
  for (const id of [...placeRows.map((row) => row.id), ...guilds]) {
    const handle = `p${handleOf.size + 1}`;
    handleOf.set(id, handle);
    maps.places.set(handle, id as string);
  }

  // <batch>
  const rendered: Array<string> = [];
  let n = 0;
  // The handle of every author of the batch who is not a person yet, by account or participant id.
  const authorHandleOf = new Map(
    [...touched.authors]
      .filter(([, entry]) => !entry.hasPerson)
      .map(([handle, entry]): [string, string] => [entry.id, handle])
  );
  for (const line of batch) {
    if (typeof line.text !== 'string' || line.text.trim() === '') continue;
    n += 1;
    maps.sources.set(`#${n}`, line.id as string);
    read('source_id', line.id, 'batch');
    rendered.push(
      lineText(line, n, {
        accounts: touched.accounts,
        participants: touched.participants,
        selfName,
        labels,
        timezone,
        handle: handleOf.get(line.place_id) ?? null,
        authorHandle: authorHandleOf.get((line.author_participant ?? line.author_account) as string) ?? null,
      })
    );
  }
  const batchBody = [`cutoff: ${stamp(cutoff, timezone)}`, ...rendered].join('\n');

  // <self>
  const selfScope = scopeWhere(ctx, 'c');
  const selfClaims = db
    .prepare(
      `SELECT c.id, c.kind, c.text FROM claims c WHERE c.subject_kind = 'self' AND c.retired_at IS NULL AND c.shown = 1 AND c.truth IN ('current', 'disputed')
       AND ${selfScope.sql} AND ${early('c')} ORDER BY c.last_seen_at DESC, c.id LIMIT ?`
    )
    .all(...selfScope.params, cutoffIso, cutoffIso, settings.selfMax);
  const selfLines = selfClaims.map((row, index) => {
    maps.claims.set(`s${index + 1}`, row.id as string);
    read('claim', row.id, 'self');
    return claimLine(`s${index + 1}`, row);
  });

  // <place>
  const placeLines = [`scope: ${scope.scope.scope_kind}`];
  for (const row of placeRows) {
    placeLines.push(
      `[${handleOf.get(row.id)}] ${row.kind === 'dm' ? 'dm' : 'channel'}: ${asText([row.name, row.topic].filter(Boolean).join(' - ') || row.id)}`
    );
    read('place', row.id, 'place');
  }
  for (const id of guilds) {
    const row = db.prepare('SELECT name FROM places WHERE id = ?').get(id);
    placeLines.push(`[${handleOf.get(id)}] guild: ${asText(row?.name || id)}`);
    read('place', id, 'place');
  }
  for (const description of currentDescriptions(db, [...guilds, ...placeIds], ctx)) {
    placeLines.push(`${asText(description.field)}: ${asText(description.text)}`);
    read('description', description.id, 'place');
  }
  const placeScope = scopeWhere(ctx, 'c');
  const placeSubjects = [...guilds, ...placeIds];
  const placeClaims =
    placeSubjects.length === 0
      ? []
      : db
          .prepare(
            `SELECT c.id, c.kind, c.text FROM claims c WHERE c.subject_kind = 'place' AND c.subject_id IN (${placeSubjects.map(() => '?').join(', ')}) AND c.retired_at IS NULL
       AND c.shown = 1 AND c.truth IN ('current', 'disputed') AND ${placeScope.sql} AND ${early('c')} ORDER BY c.last_seen_at DESC, c.id LIMIT ?`
          )
          .all(...placeSubjects, ...placeScope.params, cutoffIso, cutoffIso, settings.claimsPerPerson);
  let claimNumber = 0;
  for (const row of placeClaims) {
    claimNumber += 1;
    maps.claims.set(`c${claimNumber}`, row.id as string);
    read('claim', row.id, 'place');
    placeLines.push(claimLine(`c${claimNumber}`, row));
  }

  // <people>: this page's people (every person of the batch is on some page)
  const shown = touched.people.slice(page * settings.maxPeople, (page + 1) * settings.maxPeople);
  const profileOptions = {
    interlocutor: true,
    relationships: true,
    maxInterests: MEMORY_LIMITS.maxInterests,
    maxDetails: MEMORY_LIMITS.maxDetails,
    maxAliases: MEMORY_LIMITS.maxAliases,
    aliasHalfLifeDays: MEMORY_LIMITS.aliasHalfLifeDays,
    addressHalfLifeDays: MEMORY_LIMITS.addressHalfLifeDays,
    interestHalfLifeDays: MEMORY_LIMITS.interestHalfLifeDays,
    detailHalfLifeDays: MEMORY_LIMITS.detailHalfLifeDays,
    confirmAfter: MEMORY_LIMITS.confirmAfter,
    staleDays: MEMORY_LIMITS.interestStaleDays,
    supersededShownDays: MEMORY_LIMITS.supersededShownDays,
    now,
    nameOf,
  };
  const peopleBodies = [];
  const personScope = scopeWhere(ctx, 'c');
  for (const person of shown) {
    const file = db
      .prepare("SELECT path FROM files WHERE path LIKE ? ESCAPE '\\' AND gone_at IS NULL ORDER BY path LIMIT 1")
      .get(`guilds/%/users/${person.native}.json`);
    let profile = null;
    if (file) {
      try {
        const found = exportOne(db, file.path as string);
        if (found.found) profile = profileAsOf(db, found.value as Row, cutoffIso);
      } catch {
        /* the profile is shown without the stored text */
      }
    }
    let text = '';
    try {
      text = profile ? renderProfile(profile as Profile, labels, profileOptions) : '';
    } catch {
      text = '';
    }
    const row = db.prepare('SELECT affinity FROM people WHERE id = ?').get(person.id);
    const claims = db
      .prepare(
        `SELECT c.id, c.kind, c.text FROM claims c WHERE c.subject_kind = 'person' AND c.subject_id = ? AND c.retired_at IS NULL AND c.shown = 1
         AND c.truth IN ('current', 'disputed') AND ${personScope.sql} AND ${early('c')} ORDER BY c.last_seen_at DESC, c.id LIMIT ?`
      )
      .all(person.id, ...personScope.params, cutoffIso, cutoffIso, settings.claimsPerPerson);
    const lines = [text || `## ${person.name}`, `id: <@${person.native}>`];
    if (row && Number.isFinite(row.affinity)) lines.push(`affinity: ${asText(row.affinity)}`);
    for (const claim of claims) {
      claimNumber += 1;
      maps.claims.set(`c${claimNumber}`, claim.id as string);
      read('claim', claim.id, 'people');
      lines.push(claimLine(`c${claimNumber}`, claim));
    }
    peopleBodies.push(lines.join('\n'));
  }

  // <episodes>
  const episodeLines: Array<string> = [];
  if (shown.length > 0) {
    const episodeScope = scopeWhere(ctx, 'e');
    const ids = shown.map((person) => person.id);
    const rows = db
      .prepare(
        `SELECT e.id, e.subject_id, e.date, e.what, e.feeling FROM episodes e
        WHERE e.retired_at IS NULL AND (e.status IS NULL OR e.status != 'closed') AND e.subject_id IN (${ids.map(() => '?').join(', ')}) AND ${episodeScope.sql}
          AND (e.created_at IS NULL OR e.created_at <= ?)
        ORDER BY COALESCE(e.last_ms, 0) DESC, e.date DESC, e.id LIMIT ?`
      )
      .all(...ids, ...episodeScope.params, cutoffIso, settings.episodesMax);
    rows.forEach((row: Row, index: number) => {
      maps.episodes.set(`e${index + 1}`, row.id as string);
      read('episode', row.id, 'episodes');
      const who = shown.find((person) => person.id === row.subject_id)?.name ?? row.subject_id;
      episodeLines.push(
        `[e${index + 1}] ${[row.date, who].filter(Boolean).join(' ')}: ${asText(row.what)}${row.feeling ? ` (${asText(row.feeling)})` : ''}`
      );
    });
  }

  // <intentions>
  const intentionLines: Array<string> = [];
  const intentionScope = scopeWhere(ctx, 'i');
  const records = db
    .prepare(
      `SELECT i.id, i.record FROM intentions i WHERE i.archived = 0 AND i.retired_at IS NULL AND ${intentionScope.sql} ORDER BY i.created_ms`
    )
    .all(...intentionScope.params);
  for (const row of records) {
    const record = parseJson(row.record) as (Row & Intention) | null;
    if (!record || !isOpen(record.status)) continue;
    const concerns =
      shown.some((person) => concernsMember(record, { userId: person.native, names: [person.name] })) ||
      placeIds.some((id) => JSON.stringify(record).includes(nativeOf(id) ?? '\u0000'));
    if (concerns && typeof record.purpose === 'string') {
      intentionLines.push(`${record.status}: ${record.purpose}`);
      read('intention', row.id, 'intentions');
    }
  }

  const system = systemTextOf(prompts, selfName, prompts?.['memory-session']);
  // The stable blocks first (the cache marker covers them and the system text), the lines last: the stable part holds
  // no clock and no line of the batch, so it repeats byte for byte while the stored memory does.
  const stable = [
    block('self', selfLines.join('\n')),
    block('place', placeLines.join('\n')),
    block('people', peopleBodies.join('\n\n')),
    block('episodes', episodeLines.join('\n')),
    block('intentions', intentionLines.join('\n')),
  ]
    .filter(Boolean)
    .join('\n\n');
  const user = [
    // `<place>` always has its scope line, so the stable part is never empty.
    { type: 'text' as const, text: `${stable}\n\n`, cacheSegment: 'stable' as const },
    { type: 'text' as const, text: block('batch', batchBody) },
  ];
  // A read's order is its place in the request: the blocks in the order the user content has them, then as built.
  const rank = (name: string) => SESSION_BLOCKS.indexOf(name);
  const ordered = reads
    .map((entry, at) => ({ entry, at }))
    .sort((a, b) => rank(a.entry.block) - rank(b.entry.block) || a.at - b.at)
    .map(({ entry }, ord) => ({ ...entry, ord: ord + 1 }));
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    maps,
    lines: rendered.length,
    people: shown,
    places: placeIds,
    pages,
    cutoff,
    reads: ordered,
  };
}

/**
 * The read-set of an assembled request, resolved now (service.ts#turnReadRows: the claim version, the description version
 * and the source revision each read showed), and `maps.versions`: the version each `cN` / `sN` showed (null for a claim
 * with no version), the `base` of an op on it. Mutates `request.maps`; returns the rows. `iface` names the interface
 * of the scope the request reads.
 */
export function resolveSessionReads(db: Db, request: SessionRequest, iface: string): Array<Row> {
  const rows = turnReadRows(db, request.reads ?? [], { iface });
  const versionOf = new Map(
    rows
      .filter((row) => row.row_kind === 'claims')
      .map((row): [unknown, unknown] => [row.row_id, row.version_id ?? null])
  );
  request.maps.versions = new Map(
    [...request.maps.claims].map(([handle, id]): [string, unknown] => [
      handle,
      versionOf.has(id) ? versionOf.get(id) : null,
    ])
  );
  return rows;
}

// ---------- the answer ----------

/**
 * The `<memory>` object of an answer: the block after the thinking, a JSON object (a code fence around it is
 * tolerated). `{ ok: true, value }` or `{ ok: false, code }` (`no_block`, `bad_json`, `not_object`).
 */
export function parseSessionAnswer(text: unknown): { ok: true; value: Row } | { ok: false; code: string } {
  const raw = asText(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const open = raw.lastIndexOf('<memory>');
  if (open === -1) return { ok: false, code: 'no_block' };
  let body = raw.slice(open + '<memory>'.length);
  const close = body.indexOf('</memory>');
  if (close !== -1) body = body.slice(0, close);
  body = body
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, code: 'bad_json' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'not_object' };
  return { ok: true, value: value as Row };
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const isObject = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);

/** What a validated answer asks for, by kind of entry. */
export type AnswerPlan = {
  claims: Array<Row>;
  episodes: Array<Row>;
  affinity: Array<Row>;
  descriptions: Array<Row>;
  people: Array<Row>;
};

/**
 * Checks a parsed answer against the request and resolves it to database ids. Anything that does not hold is dropped
 * and counted by reason, never repaired. An op whose sources do not ALL resolve to lines of the batch is dropped whole
 * (`unknown_source`), never kept with part of its evidence. A place is named by the handle the request gave it (`pN`),
 * in `place` (or as the `subject`): a place op without one is dropped (`no_place`, `unknown_place`). Returns
 * `{ plan, counts }`; `counts.kept` and `counts.dropped` (by reason).
 * `value` is the `<memory>` object and `people` the subjects of this request (its page of the batch).
 */
export function validateAnswer(
  valueGiven: unknown,
  { maps, people }: { maps: RequestMaps; people: ReadonlyArray<BatchPerson> }
): { plan: AnswerPlan; counts: { kept: number; dropped: Record<string, number> } } {
  const value = valueGiven as Row;
  const plan: AnswerPlan = { claims: [], episodes: [], affinity: [], descriptions: [], people: [] };
  const counts: { kept: number; dropped: Record<string, number> } = { kept: 0, dropped: {} };
  const drop = (reason: string): void => {
    counts.dropped[reason] = (counts.dropped[reason] ?? 0) + 1;
  };
  const personByKey = new Map<string, BatchPerson>();
  const ambiguous = new Set<string>();
  for (const person of people) {
    for (const key of [foldName(person.name), person.id, person.native, `<@${person.native}>`]) {
      if (personByKey.has(key) && personByKey.get(key) !== person) ambiguous.add(key);
      personByKey.set(key, person);
    }
  }

  // The evidence of an op: every declared source must be a line of the batch; null (and the op dropped) otherwise.
  const sourcesOf = (list: unknown): Array<string> | null => {
    const out: Array<string> = [];
    let unknown = false;
    for (const ref of Array.isArray(list) ? list : []) {
      const key = typeof ref === 'number' ? `#${ref}` : text(ref).replace(/^(?!#)/, '#');
      const id = maps.sources.get(key);
      if (id) {
        if (!out.includes(id)) out.push(id);
      } else unknown = true;
    }
    if (unknown) {
      drop('unknown_source');
      return null;
    }
    if (out.length === 0) {
      drop('no_sources');
      return null;
    }
    return out;
  };
  const person = (subject: unknown): BatchPerson | null => {
    const key = foldName(subject);
    if (ambiguous.has(key)) return null;
    return personByKey.get(key) ?? personByKey.get(text(subject)) ?? null;
  };
  const subjectOf = (item: Row): { kind: string; id: string } | null => {
    const word = foldName(item.subject);
    if (word === 'self') return { kind: 'self', id: SELF_PERSON };
    if (word === 'place' || maps.places?.has(text(item.subject))) {
      const handle = maps.places?.has(text(item.subject)) ? text(item.subject) : text(item.place);
      if (!handle) {
        drop('no_place');
        return null;
      }
      const id = maps.places?.get(handle);
      if (!id) {
        drop('unknown_place');
        return null;
      }
      return { kind: 'place', id };
    }
    const found = person(item.subject);
    if (!found) drop('unknown_subject');
    return found ? { kind: 'person', id: found.id } : null;
  };
  const keep = (group: keyof AnswerPlan, entry: Row): void => {
    plan[group].push(entry);
    counts.kept += 1;
  };

  const list = (key: string): Array<unknown> => {
    const given = value[key];
    if (given === undefined) return [];
    if (!Array.isArray(given)) {
      drop(`${key}_not_list`);
      return [];
    }
    return given as Array<unknown>;
  };

  for (const item of list('claims')) {
    if (!isObject(item)) {
      drop('bad_op');
      continue;
    }
    const op = text(item.op);
    if (op === 'add') {
      const subject = subjectOf(item);
      if (!subject) continue;
      if (!CLAIM_KINDS.includes(item.kind as string)) {
        drop('bad_kind');
        continue;
      }
      if (!text(item.text)) {
        drop('no_text');
        continue;
      }
      if (!HOW.includes(item.how as string)) {
        drop('bad_how');
        continue;
      }
      const sources = sourcesOf(item.sources);
      if (!sources) continue;
      keep('claims', {
        op,
        subjectKind: subject.kind,
        subjectId: subject.id,
        kind: item.kind,
        text: text(item.text),
        how: item.how,
        sources,
        when: text(item.when) || null,
      });
    } else if (op === 'confirm' || op === 'revise' || op === 'retire') {
      const id = maps.claims.get(text(item.id));
      if (!id) {
        drop('unknown_id');
        continue;
      }
      const sources = sourcesOf(item.sources);
      if (!sources) continue;
      // The version the request showed (resolveSessionReads), never a value from the answer.
      const base =
        maps.versions instanceof Map && maps.versions.has(text(item.id))
          ? { base: maps.versions.get(text(item.id)) }
          : {};
      if (op === 'confirm') {
        keep('claims', { op, id, sources, ...base });
        continue;
      }
      if (op === 'revise') {
        if (!text(item.text)) {
          drop('no_text');
          continue;
        }
        if (!HOW.includes(item.how as string)) {
          drop('bad_how');
          continue;
        }
        if (!text(item.reason)) {
          drop('no_reason');
          continue;
        }
        keep('claims', { op, id, text: text(item.text), how: item.how, sources, reason: text(item.reason), ...base });
        continue;
      }
      if (!TRUTHS.includes(item.truth as string)) {
        drop('bad_truth');
        continue;
      }
      if (!text(item.reason)) {
        drop('no_reason');
        continue;
      }
      keep('claims', { op, id, truth: item.truth, reason: text(item.reason), sources, ...base });
    } else {
      drop('bad_op');
    }
  }

  for (const item of list('episodes')) {
    if (!isObject(item)) {
      drop('bad_op');
      continue;
    }
    const found = person(item.subject);
    if (!found) {
      drop('unknown_subject');
      continue;
    }
    if (!text(item.what)) {
      drop('no_text');
      continue;
    }
    const sources = sourcesOf(item.sources);
    if (!sources) continue;
    keep('episodes', { subjectId: found.id, what: text(item.what), feeling: text(item.feeling), sources });
  }

  for (const item of list('affinity')) {
    if (!isObject(item)) {
      drop('bad_op');
      continue;
    }
    const found = person(item.person);
    if (!found) {
      drop('unknown_subject');
      continue;
    }
    if (typeof item.delta !== 'number' || !Number.isFinite(item.delta) || Math.round(item.delta) === 0) {
      drop('bad_delta');
      continue;
    }
    if (!text(item.reason)) {
      drop('no_reason');
      continue;
    }
    const sources = sourcesOf(item.sources);
    if (!sources) continue;
    keep('affinity', { personId: found.id, delta: Math.round(item.delta), reason: text(item.reason), sources });
  }

  for (const item of list('descriptions')) {
    if (!isObject(item)) {
      drop('bad_op');
      continue;
    }
    const subject = subjectOf(item);
    if (!subject) continue;
    if (!DESCRIPTION_FIELDS.includes(item.field as string)) {
      drop('bad_field');
      continue;
    }
    if (!text(item.why)) {
      drop('no_reason');
      continue;
    }
    keep('descriptions', { subjectKind: subject.kind, subjectId: subject.id, field: item.field, why: text(item.why) });
  }

  // people:add (schema v8): an account or participant of the batch, by its handle, becomes a tentative person. The
  // request does not offer the op yet (docs/prompt-contract.md); the validator and the writer take it.
  for (const item of list('people')) {
    if (!isObject(item) || text(item.op) !== 'add') {
      drop('bad_op');
      continue;
    }
    const author = maps.authors?.get(text(item.subject));
    if (!author) {
      drop('unknown_subject');
      continue;
    }
    if (author.hasPerson) {
      drop('has_person');
      continue;
    }
    if (!text(item.reason)) {
      drop('no_reason');
      continue;
    }
    const sources = sourcesOf(item.sources);
    if (!sources) continue;
    keep('people', { op: 'add', subjectKind: author.kind, subjectId: author.id, sources, reason: text(item.reason) });
  }
  return { plan, counts };
}

// ---------- the sweep ----------

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const codeOf = (error: unknown): string => {
  const { code, name } = (error ?? {}) as { code?: string; name?: string };
  return code ?? name ?? 'ERROR';
};

/** One run of a sweep: the scope it covered, how it ended and the lines it read. */
export type SweepRun = Row & { scope: string; outcome: string; lines: number; errors?: Array<string> };

/** What a model call answers: the text and the tokens it took. */
export type Completion = {
  text?: unknown;
  /** What a subharness run really used, for the archive (src/llm/archive.ts). */
  model?: unknown;
  backend?: unknown;
  source?: unknown;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    /** A backend that prints one count for the whole run has this alone. */
    total_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
  };
};

/** `<backend>:<model>` of a subharness run, from its completion or its refusal; null for the direct path. */
function pathThatRan(ran: { backend?: unknown; model?: unknown } | undefined): string | null {
  return typeof ran?.backend === 'string' && typeof ran.model === 'string' ? `${ran.backend}:${ran.model}` : null;
}

/**
 * What the sweep and the reviews take from their caller: the connection, the writer, the model client, the live
 * config and prompts, the key variables, the clock, the log and her name.
 */
export type SessionContext = {
  db: Db;
  write: (update: Row) => Promise<unknown>;
  llm: { complete(messages: ReadonlyArray<Row>, options: Row): Promise<Completion> };
  hot: { config: Config; prompts?: Row | null };
  env?: Row | null;
  /** The core's key ring while `keys.json` exists (see `memoryKeyState`), else null or absent. */
  ring?: KeyRing | null;
  now?: () => number;
  log?: Partial<Log>;
  selfName?: string;
  readCtx?: Context;
  /** The event loop watch's `track` (src/loop-watch.ts); batch reads and request builds are named operations. */
  track?: Track;
};

/** How many sweeps have started on the UTC day of `now`. */
export function sweepsToday(db: Db, now: number): number {
  return db
    .prepare(
      'SELECT COUNT(DISTINCT sweep_id) AS n FROM session_runs WHERE substr(started_at, 1, 10) = ? AND sweep_id IS NOT NULL'
    )
    .get(dayOf(now))?.n as number;
}

/** How many sweeps reached the scope `scopeKey` (in `mode`) on the UTC day of `now`. */
export function scopeSweepsToday(db: Db, scopeKey: unknown, now: number, mode: unknown): number {
  return db
    .prepare(
      'SELECT COUNT(DISTINCT sweep_id) AS n FROM session_runs WHERE scope_key = ? AND mode = ? AND substr(started_at, 1, 10) = ? AND sweep_id IS NOT NULL'
    )
    .get(scopeKey, mode, dayOf(now))?.n as number;
}

/** The batches waiting for another try: `[{ scope, tries, from, to }]` (an `all_dropped` answer leaves its lines pending). */
/** A batch waiting for another try. */
export type PendingBatch = { scope: string; mode: string; tries: unknown; from: unknown; to: unknown };

export function pendingBatches(db: Db): Array<PendingBatch> {
  const out: Array<PendingBatch> = [];
  for (const row of db
    .prepare("SELECT key, value FROM meta WHERE key LIKE 'memory_session.pending.%' ORDER BY key")
    .all()) {
    const record = parseJson(row.value) as Row | null;
    if (!record) continue;
    const key = row.key as string;
    out.push({
      scope: key.split('.').slice(3).join('.'),
      mode: key.split('.')[2],
      tries: record.tries ?? 0,
      from: record.from ?? null,
      to: record.to ?? null,
    });
  }
  return out;
}

/**
 * The state of the session for the status card: `{ mode, state, code, sweepsToday, last, pending }`
 * (`state`: `off`, `not_configured`, `refused`, `ready`). `last` is the newest run's outcome and time; `pending` the
 * batches waiting for another try, with their retry counts.
 */
/** The session's state for the status card (see `sessionStatus`). */
export type SessionStatus = {
  mode: string;
  state: string;
  code: string | null;
  sweepsToday: number | null;
  sweepsPerDay: number;
  sweepsPerScopePerDay: number;
  retryLimit: number;
  last: { outcome: unknown; at: unknown } | null;
  pending: Array<PendingBatch>;
  /** The writer's path in words (src/subharness/memory-path.ts#memoryPathText): `direct` or `via <backend> <model>`. */
  path: string;
};

export function sessionStatus({
  db,
  config,
  env,
  prompts,
  now = Date.now(),
  path = { kind: 'direct' },
}: {
  db: Db;
  config: Config;
  env: Row | null | undefined;
  prompts: Row | null | undefined;
  now?: number;
  /** The writer's path; absent is the direct path. */
  path?: MemoryPath;
}): SessionStatus {
  const { mode, sweepsPerScopePerDay, retryLimit } = sessionSettings(config);
  const code = refusalOf(config, env, prompts);
  let state = 'ready';
  if (code === CODES.OFF) state = 'off';
  else if (code === CODES.NOT_CONFIGURED) state = 'not_configured';
  else if (code) state = 'refused';
  let today: number | null = null;
  let last: { outcome: unknown; at: unknown } | null = null;
  let pending: Array<PendingBatch> = [];
  if (db) {
    try {
      today = sweepsToday(db, now);
      const row = db
        .prepare(
          'SELECT outcome, finished_at, scope_key FROM session_runs ORDER BY finished_at DESC, rowid DESC LIMIT 1'
        )
        .get();
      if (row) last = { outcome: row.outcome, at: row.finished_at };
      pending = pendingBatches(db);
    } catch {
      /* an older database without the table */
    }
  }
  // `sweepsPerDay` is the per-scope cap since stage W3 (the status line's `{cap}`).
  return {
    mode,
    state,
    code,
    sweepsToday: today,
    sweepsPerDay: sweepsPerScopePerDay,
    sweepsPerScopePerDay,
    retryLimit,
    last,
    pending,
    path: memoryPathText(path),
  };
}

/**
 * One sweep (see the head of this file). Options: `scope` (a scope key: only that one), `scopes` (a Set of scope keys:
 * only those), `limit` (a smaller `maxMessages`), `ignoreSweepCap`. Resolves `{ status, code?, runs }`; `runs` has one

 * entry per request (a scope at its daily cap: `capped`).
 */
export async function sweep(
  ctx: SessionContext,
  options: { scope?: string; scopes?: Set<string>; limit?: number; ignoreSweepCap?: boolean } = {}
): Promise<{ status: string; code?: string; runs: Array<SweepRun> }> {
  const { db, hot, env } = ctx;
  const now = ctx.now ?? Date.now;
  const config = hot.config;
  const refused = refusalOf(config, env, hot.prompts, ctx.ring);
  if (refused) return { status: refused === CODES.OFF ? 'off' : 'refused', code: refused, runs: [] };
  const settings = sessionSettings(config);
  const started = now();
  const sweepId = `sweep:${new Date(started).toISOString()}`;
  const maxMessages = options.limit ? Math.min(options.limit, settings.maxMessages) : settings.maxMessages;
  const runs: Array<SweepRun> = [];
  let ran = 0;
  let capped = 0;

  for (const scope of scopesOf(db, { audienceColumn: true })) {
    if (options.scope && options.scope !== scope.key) continue;
    if (options.scopes instanceof Set && !options.scopes.has(scope.key)) continue;
    const key = cursorKey(settings.mode, scope.key);
    const cursor = Number(metaOf(db, key) ?? 0);
    const batch = (ctx.track ?? untracked)('session.batch', () =>
      batchOf(db, scope.scope, {
        cursor,
        since: settings.since,
        maxMessages,
        settleBefore: now() - settings.settleMinutes * MINUTE,
        audienceId: scope.audienceId ?? null,
      })
    );
    if (batch.length < Math.min(settings.minMessages, maxMessages)) {
      runs.push({ scope: scope.key, outcome: 'quiet', lines: batch.length });
      continue;
    }
    // Small sessions wait and join the next batch of their scope: no request, no run row, the cursor stays.
    if (!joinOf(batch, settings, now()).write) {
      runs.push({ scope: scope.key, outcome: 'waiting', lines: batch.length });
      continue;
    }
    if (
      !options.ignoreSweepCap &&
      scopeSweepsToday(db, scope.key, started, settings.mode) >= settings.sweepsPerScopePerDay
    ) {
      capped += 1;
      runs.push({ scope: scope.key, outcome: 'capped', lines: batch.length });
      continue;
    }
    ran += 1;
    runs.push(...(await runBatch(ctx, { scope, batch, cursor, key, sweepId, settings })));
  }
  // Every scope with work is at its daily cap: the sweep did nothing.
  if (ran === 0 && capped > 0) return { status: 'refused', code: CODES.SWEEP_CAP, runs };
  return { status: 'ok', runs };
}

/** The share of `llm.maxRequestTokens` a session request may take (the estimate is not the provider's count). */
const CAP_SHARE = 0.85;

/**
 * `batch` cut to the first lines by arrival (rowid) until the largest page of its request fits CAP_SHARE of the request
 * cap, halving each time, never below `min` lines (a batch that still does not fit is returned as it is and fails as
 * before). The lines stay in event time.
 */
export function fitBatch(
  db: Db,
  scope: Pick<SweepScope, 'scope' | 'ctx'>,
  batch: Array<BatchLine>,
  {
    config,
    prompts,
    selfName,
    now,
    min = 1,
  }: { config: Config; prompts: Row | null | undefined; selfName: string; now: number; min?: number }
): Array<BatchLine> {
  const cap = Number(config?.llm?.maxRequestTokens);
  if (!Number.isFinite(cap) || cap <= 0) return batch;
  const budget = Math.floor(cap * CAP_SHARE);
  const largest = (lines: Array<BatchLine>): number => {
    const pages = pagesOf(db, lines, config, selfName);
    let most = 0;
    for (let page = 0; page < pages; page += 1) {
      const request = buildSessionRequest({ db, scope, batch: lines, config, prompts, selfName, now, page });
      most = Math.max(most, estimateMessages(request.messages));
    }
    return most;
  };
  let lines = batch;
  while (lines.length > Math.max(1, min) && largest(lines) > budget) {
    const byArrival = [...lines].sort((a, b) => a.rowid - b.rowid);
    const keep = new Set(
      byArrival.slice(0, Math.max(Math.max(1, min), Math.ceil(byArrival.length / 2))).map((line) => line.rowid)
    );
    const next = lines.filter((line) => keep.has(line.rowid));
    if (next.length === lines.length) break;
    lines = next;
  }
  return lines;
}

/**
 * One batch: one request per page of its people, serial. The cursor moves, in the write of the last page, only when every
 * page was written (or had been applied before); an `all_dropped` page keeps the batch pending, and after `retryLimit`
 * tries the batch is skipped with a recorded decision. Never throws; returns one entry per page (or the skip).
 */
async function runBatch(
  ctx: SessionContext,
  {
    scope,
    batch: read,
    cursor,
    key,
    sweepId,
    settings,
  }: {
    scope: SweepScope;
    batch: Array<BatchLine>;
    cursor: number;
    key: string;
    sweepId: string;
    settings: SessionSettings;
  }
): Promise<Array<SweepRun>> {
  const { db, hot } = ctx;
  const config = hot.config;
  let batch = read;
  let cursorTo = Math.max(...batch.map((line) => line.rowid));
  const holdKey = pendingKey(settings.mode, scope.key);
  let pinned = false;
  // A batch read from this cursor before, with a page applied and another not, keeps the lines it had: the settle cut
  // may have let more lines in since, and a wider batch would carry another key and apply its first pages again. The
  // lines after it wait for the next batch.
  if (settings.mode === 'apply') {
    const earlier = db
      .prepare(
        'SELECT MIN(cursor_to) AS last FROM session_runs WHERE mode = ? AND scope_key = ? AND cursor_from = ? AND applied = 1'
      )
      .get(settings.mode, scope.key, cursor)?.last;
    if (isFiniteNumber(earlier)) pinned = true;
    if (isFiniteNumber(earlier) && earlier !== cursorTo) {
      batch = batch.filter((line) => line.rowid <= earlier);
      cursorTo = earlier;
      if (batch.length === 0) {
        // Every line of the old batch is gone (retired since): only the cursor is left to move.
        try {
          await ctx.write({
            kind: 'session',
            mode: settings.mode,
            run: null,
            plan: null,
            advance: { key, value: cursorTo, expect: cursor },
            pending: { key: holdKey, value: null },
            now: (ctx.now ?? Date.now)(),
          });
          return [{ scope: scope.key, outcome: 'applied_before', lines: 0 }];
        } catch (error) {
          ctx.log?.warn?.('memory session: write failed', { code: codeOf(error) });
          return [{ scope: scope.key, outcome: 'write_failed', lines: 0, errors: [`write:${codeOf(error)}`] }];
        }
      }
    }
  }
  // The request must fit the request cap (`llm.maxRequestTokens`): a batch whose largest page would not is cut to its
  // first lines by arrival, halving until it fits or `minMessages` is reached; the lines after it wait for the next
  // batch (none is skipped: the cursor follows the cut). A batch pinned by an applied page above keeps its lines.
  if (!pinned) {
    const fitted = fitBatch(db, scope, batch, {
      config,
      prompts: hot.prompts,
      selfName: ctx.selfName ?? '',
      now: (ctx.now ?? Date.now)(),
      min: settings.minMessages,
    });
    if (fitted.length < batch.length) {
      ctx.log?.info?.('memory session: batch cut to fit the request cap', {
        scope: scope.scope.scope_kind,
        from: batch.length,
        to: fitted.length,
      });
      batch = fitted;
      cursorTo = Math.max(...batch.map((line) => line.rowid));
    }
  }
  const held = parseJson(metaOf(db, holdKey)) as Row | null;
  const tries = held && held.from === cursor ? Number(held.tries) || 0 : 0;
  if (tries >= settings.retryLimit)
    return [await skipBatch(ctx, { scope, batch, cursor, cursorTo, key, holdKey, sweepId, settings, tries })];

  const pages = pagesOf(db, batch, config, ctx.selfName ?? '');
  const results: Array<SweepRun> = [];
  const state: BatchState = { ok: true, dropped: false };
  let lastApplied = false;
  for (let page = 0; page < pages; page += 1) {
    const batchKey = [settings.mode, scope.key, cursor, cursorTo, page].join('|');
    const last = page === pages - 1;
    if (
      settings.mode === 'apply' &&
      db.prepare('SELECT 1 AS ok FROM session_runs WHERE batch_key = ? AND applied = 1').get(batchKey)
    ) {
      results.push({ scope: scope.key, outcome: 'applied_before', lines: batch.length, page });
      lastApplied = last;
      continue;
    }
    results.push(
      await runScope(ctx, {
        scope,
        batch,
        cursor,
        cursorTo,
        key,
        holdKey,
        sweepId,
        settings,
        page,
        pages,
        batchKey,
        state,
        tries,
      })
    );
  }
  if (lastApplied) {
    // The last page needs no write of its own (it was applied in an earlier try): the cursor moves on its own.
    const final = settleState(state, { key, holdKey, cursor, cursorTo, tries, from: cursor });
    if (final.advance || final.pending) {
      try {
        await ctx.write({
          kind: 'session',
          mode: settings.mode,
          run: null,
          plan: null,
          advance: final.advance,
          pending: final.pending,
          now: (ctx.now ?? Date.now)(),
        });
      } catch (error) {
        ctx.log?.warn?.('memory session: write failed', { code: codeOf(error) });
        results.push({
          scope: scope.key,
          outcome: 'write_failed',
          lines: batch.length,
          errors: [`write:${codeOf(error)}`],
        });
      }
    }
  }
  return results;
}

/** What the end of a batch does to the cursor and to the pending mark, from how its pages went. */
/** How the pages of a batch went so far: all fine, and whether an answer was dropped whole. */
type BatchState = { ok: boolean; dropped: boolean };

function settleState(
  state: BatchState,
  {
    key,
    holdKey,
    cursor,
    cursorTo,
    tries,
    from,
  }: { key: string; holdKey: string; cursor: number; cursorTo: number; tries: number; from: number }
): { advance: Row | null; pending: Row | null } {
  if (state.ok) return { advance: { key, value: cursorTo, expect: cursor }, pending: { key: holdKey, value: null } };
  if (state.dropped)
    return { advance: null, pending: { key: holdKey, value: json({ from, to: cursorTo, tries: tries + 1 }) } };
  return { advance: null, pending: null };
}

const json = (value: unknown): string => JSON.stringify(value);

/** A batch whose answers were all dropped `retryLimit` times: the cursor moves past it and a decision says why. */
async function skipBatch(
  ctx: SessionContext,
  {
    scope,
    batch,
    cursor,
    cursorTo,
    key,
    holdKey,
    sweepId,
    settings,
    tries,
  }: {
    scope: SweepScope;
    batch: ReadonlyArray<BatchLine>;
    cursor: number;
    cursorTo: number;
    key: string;
    holdKey: string;
    sweepId: string;
    settings: SessionSettings;
    tries: number;
  }
): Promise<SweepRun> {
  const now = ctx.now ?? Date.now;
  const id = `skip:${shortHash(sweepId, scope.key)}`;
  try {
    await ctx.write({
      kind: 'session',
      mode: settings.mode,
      run: null,
      plan: null,
      advance: { key, value: cursorTo, expect: cursor },
      pending: { key: holdKey, value: null },
      decision: {
        id,
        scope: scope.key,
        action: 'skipped:all_dropped',
        reason: 'every answer was dropped',
        extra: { scope: scope.key, tries, from: cursor, to: cursorTo, lines: batch.length },
      },
      now: now(),
    });
  } catch (error) {
    ctx.log?.warn?.('memory session: write failed', { code: codeOf(error) });
    return { scope: scope.key, outcome: 'write_failed', lines: batch.length, errors: [`write:${codeOf(error)}`] };
  }
  ctx.log?.debug?.('memory session: batch skipped', { scope: scope.scope.scope_kind, tries, lines: batch.length });
  return { scope: scope.key, outcome: 'skipped', lines: batch.length, tries };
}

/** One request (one page of the batch): build, send, parse, validate, write. Never throws; the outcome is in the result. */
async function runScope(
  ctx: SessionContext,
  {
    scope,
    batch,
    cursor,
    cursorTo,
    key,
    holdKey,
    sweepId,
    settings,
    page,
    pages,
    batchKey,
    state,
    tries,
  }: {
    scope: SweepScope;
    batch: ReadonlyArray<BatchLine>;
    cursor: number;
    cursorTo: number;
    key: string;
    holdKey: string;
    sweepId: string;
    settings: SessionSettings;
    page: number;
    pages: number;
    batchKey: string;
    state: BatchState;
    tries: number;
  }
): Promise<SweepRun> {
  const { db, write, llm, hot, log = {} } = ctx;
  const now = ctx.now ?? Date.now;
  const config = hot.config;
  const startedAt = now();
  const runId = `run:${shortHash(sweepId, scope.key, page)}`;
  const last = page === pages - 1;
  const run = {
    id: runId,
    sweepId,
    scopeKey: scope.key,
    scope: scope.scope,
    batchKey,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: null as string | null,
    cursorFrom: cursor,
    cursorTo,
    sourcesN: batch.length,
    tokensPrompt: null as number | null,
    tokensCompletion: null as number | null,
    model: roleModel(config, MEMORY_ROLE),
    outcome: 'error',
    counts: {} as Row,
    errors: [] as Array<string>,
  };
  // The read-set of the request, resolved when it is assembled (below), and the run's context.
  let readSet: { rows: Array<Row>; context: Row } | null = null;
  const finish = async (
    outcome: string,
    extra: { counts?: Row; plan?: AnswerPlan | null; answer?: string | null } = {}
  ): Promise<SweepRun> => {
    run.outcome = outcome;
    run.finishedAt = new Date(now()).toISOString();
    Object.assign(run, { counts: extra.counts ?? run.counts });
    // A page is fine when its answer was written and not all of it was dropped. The cursor moves with the last page's
    // write, and only if every page before it was fine too.
    if (outcome !== 'ok') {
      state.ok = false;
      if (outcome === 'all_dropped') state.dropped = true;
    }
    let advance: Row | null = null;
    let pending: Row | null = null;
    if (last) {
      const final = settleState(state, { key, holdKey, cursor, cursorTo, tries, from: cursor });
      advance = final.advance;
      pending = final.pending;
    }
    let written: Row | null = null;
    try {
      written = (await write({
        kind: 'session',
        mode: settings.mode,
        run,
        plan: extra.plan ?? null,
        advance,
        pending,
        answer: extra.answer ? { text: extra.answer } : null,
        maxDelta: RELATIONSHIP_LIMITS.maxDeltaPerUpdate,
        now: now(),
        ...(readSet ? { reads: readSet.rows, readStep: String(page), context: readSet.context } : {}),
      })) as Row | null;
    } catch (error) {
      // A failed write is never an ok run, and the cursor did not move (it rides in the same transaction).
      run.errors.push(`write:${codeOf(error)}`);
      state.ok = false;
      log.warn?.('memory session: write failed', { code: codeOf(error) });
      const lost = { kind: 'memory-write', state: 'failed', ref: run.id };
      await write({ kind: 'request-archive', op: 'outcome', id: sessionRequestId(run.id), outcome: lost }).catch(
        () => null
      );
      return {
        scope: scope.key,
        outcome: 'write_failed',
        lines: batch.length,
        page,
        counts: run.counts,
        errors: run.errors,
      };
    }
    log.debug?.('memory session: run', {
      scope: scope.scope.scope_kind,
      outcome,
      lines: batch.length,
      page,
      ...run.counts,
    });
    return {
      scope: scope.key,
      outcome,
      lines: batch.length,
      page,
      counts: run.counts,
      errors: run.errors,
      ...(written?.replayed ? { replayed: true } : {}),
      ...(extra.plan ? { plan: extra.plan } : {}),
    };
  };

  let request: SessionRequest;
  try {
    request = (ctx.track ?? untracked)('session.request', () =>
      buildSessionRequest({
        db,
        scope,
        batch,
        config,
        prompts: hot.prompts,
        selfName: ctx.selfName ?? '',
        now: startedAt,
        page,
      })
    );
  } catch (error) {
    run.errors.push(`build:${codeOf(error)}`);
    return finish('build_error');
  }
  try {
    const issued = issueContext({
      kind: scope.scope.scope_kind === 'dm' ? 'dm' : 'group',
      iface: scope.scope.scope_iface ?? undefined,
      person: scope.scope.scope_dm,
      now: () => startedAt,
      newId: () => `ctx:session:${runId}`,
    });
    readSet = { rows: resolveSessionReads(db, request, issued.iface as string), context: contextRow(issued) };
  } catch (error) {
    // The run goes on without its read-set (and without bases): logged with a code, counted in its errors.
    run.errors.push(`reads:${codeOf(error)}`);
    log.warn?.('memory session: read-set failed', { code: codeOf(error) });
  }

  let completion: Completion | undefined;
  try {
    completion = await llm.complete(request.messages, {
      role: MEMORY_ROLE,
      purpose: SESSION_PURPOSE,
      archiveId: sessionRequestId(run.id),
      model: roleModel(config, MEMORY_ROLE),
      maxOutputTokens: settings.maxOutputTokens,
      timeoutMs: settings.timeoutMs,
      skipCalibration: true,
      cache: true,
      origin: SESSION_PURPOSE,
    });
  } catch (error) {
    run.errors.push(`llm:${codeOf(error)}`);
    run.model = pathThatRan(error as Row) ?? run.model;
    return finish(codeOf(error) === 'ROLE_KEY_MISSING' ? CODES.NOT_CONFIGURED : 'llm_error');
  }
  run.model = pathThatRan(completion) ?? run.model;
  run.tokensPrompt = Number(completion?.usage?.prompt_tokens) || null;
  run.tokensCompletion = Number(completion?.usage?.completion_tokens) || null;
  const answer = typeof completion?.text === 'string' && completion.text ? completion.text : null;

  const parsed = parseSessionAnswer(completion?.text);
  if (!parsed.ok) {
    run.errors.push(parsed.code);
    return finish('bad_answer', { answer });
  }
  const { plan, counts } = validateAnswer(parsed.value, { maps: request.maps, people: request.people });
  const counted = {
    lines: request.lines,
    sessions: joinOf(batch, settings, startedAt).sessions,
    cacheRead: Number(completion?.usage?.prompt_tokens_details?.cached_tokens) || 0,
    page,
    pages,
    kept: counts.kept,
    dropped: counts.dropped,
    claims: plan.claims.length,
    episodes: plan.episodes.length,
    affinity: plan.affinity.length,
    descriptions: plan.descriptions.length,
    people: plan.people.length,
  };
  return finish(counts.kept === 0 && Object.keys(counts.dropped).length > 0 ? 'all_dropped' : 'ok', {
    plan,
    counts: counted,
    answer,
  });
}

/** The status card's line for the session, from `sessionStatus` and `labels.status.memorySession`; '' without the label. */
export function memorySessionStatusLine(
  status: SessionStatus | null | undefined,
  labels: Row | null | undefined,
  fill = (template: unknown, values: Row): string =>
    String(template).replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all))
): string {
  const set = (labels?.status as { memorySession?: Row } | undefined)?.memorySession;
  if (!set || !status) return '';
  if (status.state === 'off') return asText(set.off ?? '');
  if (status.state === 'not_configured') return asText(set.notConfigured ?? '');
  if (status.state === 'refused') return fill(set.refused ?? '', { code: status.code });
  const line = fill(set.line ?? '', {
    mode: status.mode,
    path: status.path,
    sweeps: status.sweepsToday ?? 0,
    cap: status.sweepsPerDay,
    outcome: status.last?.outcome ?? '-',
    at: status.last?.at ?? '-',
  });
  // Batches waiting for another try (an all-dropped answer leaves its lines pending), with the most tries any has had.
  const waiting = status.pending ?? [];
  if (waiting.length === 0 || !set.pending) return line;
  return `${line}\n${fill(set.pending, { n: waiting.length, tries: Math.max(...waiting.map((batch) => Number(batch.tries))), limit: status.retryLimit ?? '-' })}`;
}
