// Her memory session as the memory writer (spec 2026-10-24-memory-authority, stage W3): the pure parts of the live
// schedule the service runs with `memoryDb.session.mode` `apply`, and the effective models the service names at its
// start. Reads only; every write goes through the service's writer.
//
//   dueScopes(db, config, now, { log }) -> [{ key, lines, full }]
//     The scopes a sweep should take now: at least `minMessages` settled lines after the scope's cursor, and either
//     `everyMinutes` since the scope's last run (no run yet counts as long ago) or `maxMessages` lines waiting (`full`),
//     and fewer than `sweepsPerScopePerDay` ordinary sweeps of the scope today (UTC). The lines are counted the way the
//     sweep reads them (session.ts#batchOf: after the cursor, at most `maxMessages`, cut at the settle time). A quiet
//     scope is due for its media pass while the pass has old lines left, under `mediaPassPerDay`, and `everyMinutes`
//     after the scope's last run of any kind: a media pass is never `full`. A scope left out at a daily cap is logged
//     `memory session: capped` once per scope, cap and day.
//   openFlags(db, config, { skip, selfName }) -> [{ key, at, subject, field, readCtx }]
//     The description flags her session runs raised (`decisions` rows `flag:description`, `by` her) whose description
//     has no accepted review (`origin` `review`) written since the flag, one per description (its oldest open flag: a
//     flag raised after the last review opens the description again), in
//     the order the reviews are run: the people of her focus close set first (by their
//     focus score), then every other flag by its age, oldest first. `skip`: description ids not to offer again today.
//   reviewsToday(db, now) -> number    the accepted reviews written on the UTC day of `now`
//   effectiveModels(config, ring) -> [{ purpose, role, model, key }]
//     The model and the key each request of the memory writer and of every other named purpose goes out on, resolved
//     from the live config the way the callers resolve it (session.ts / describe.ts call roleModel with the role alone;
//     the analyzer purposes with their purpose), the key by the name the core's key ring routes the role to now (null
//     without one: the request would be refused). Names only, never a value.
//   effectiveModelsLine(list) -> string[]    `purpose=model@KEY` per entry, for the start-up log line

import { entityLabels } from './semantic-read.ts';
import type { KeyRing } from '../../keys/ring.ts';
import { MEMORY_PURPOSES, MEMORY_ROLE, PURPOSE_ROLES, roleModel } from '../../llm/roles.ts';
import {
  batchOf,
  cursorKey,
  DESCRIPTION_FIELDS,
  joinOf,
  mediaPassBatch,
  scopeSweepsToday,
  scopesOf,
  sessionSettings,
} from './session.ts';
import { descriptionIdFor, scopeOfContext } from './describe.ts';
import { dmContext, groupContext } from './scope.ts';
import type { Context } from './scope.ts';
import { SELF_PERSON } from './ids.ts';
import { LEGACY_IFACE } from './legacy-namespace.ts';
import { closePeople } from './focus.ts';
import type { SessionSettings } from './session.ts';
import type { SweepScope } from './session-scopes.ts';
import type { Config, Db, Log, Row } from './types.ts';

const MINUTE = 60_000;
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const parse = (text: unknown): Row | null => {
  try {
    return JSON.parse(text as string) as Row | null;
  } catch {
    return null;
  }
};

// The capped lines already logged, per database: one per scope, cap and day, so a capped scope is not said every minute.
const cappedSaid = new WeakMap<Db, Set<string>>();

type CappedLine = { scope: string; cap: 'sweepsPerScopePerDay' | 'mediaPassPerDay'; count: number; now: number };

/** Logs `memory session: capped` for the scope once per cap and day. */
function sayCapped(db: Db, log: Partial<Log> | undefined, { scope, cap, count, now }: CappedLine): void {
  const day = dayOf(now);
  const said = cappedSaid.get(db) ?? new Set<string>();
  cappedSaid.set(db, said);
  const key = `${day}|${cap}|${scope}`;
  if (said.has(key)) return;
  for (const old of said) if (!old.startsWith(`${day}|`)) said.delete(old);
  said.add(key);
  log?.info?.('memory session: capped', { scope, cap, count });
}

/** The old media lines the quiet scope's media pass would read now; 0 while the pass is off. */
function mediaPassLines(db: Db, settings: SessionSettings, sweepScope: SweepScope, cursor: number): number {
  if (!settings.mediaPass) return 0;
  const passCursor = Number(
    db.prepare('SELECT value FROM meta WHERE key = ?').get(`${cursorKey(settings.mode, sweepScope.key)}:media-pass`)
      ?.value ?? 0
  );
  return mediaPassBatch(db, sweepScope, {
    after: passCursor,
    upTo: cursor,
    maxMessages: settings.maxMessages,
    since: settings.since,
  }).length;
}

/** The scopes a scheduled sweep takes now (see the head of this file). */
export function dueScopes(
  db: Db,
  config: Config,
  now: number,
  { log }: { log?: Partial<Log> } = {}
): Array<{ key: string; lines: number; full: boolean }> {
  const settings = sessionSettings(config);
  const out: Array<{ key: string; lines: number; full: boolean }> = [];
  const settleBefore = now - settings.settleMinutes * MINUTE;
  for (const sweepScope of scopesOf(db, { audienceColumn: true })) {
    const cursor = Number(
      db.prepare('SELECT value FROM meta WHERE key = ?').get(cursorKey(settings.mode, sweepScope.key))?.value ?? 0
    );
    const batch = batchOf(db, sweepScope.scope, {
      cursor,
      since: settings.since,
      maxMessages: settings.maxMessages,
      settleBefore,
      audienceId: sweepScope.audienceId ?? null,
    });
    const quiet = batch.length < Math.min(settings.minMessages, settings.maxMessages);
    const lines = quiet ? mediaPassLines(db, settings, sweepScope, cursor) : batch.length;
    if (lines === 0 || (!quiet && joinOf(batch, settings, now).reason === 'wait')) continue;
    const cap = quiet ? 'mediaPassPerDay' : 'sweepsPerScopePerDay';
    const count = scopeSweepsToday(db, sweepScope.key, now, settings.mode, quiet);
    if (count >= settings[cap]) {
      sayCapped(db, log, { scope: sweepScope.key, cap, count, now });
      continue;
    }
    // Only ordinary new lines skip the wait: a media pass always finds old lines and would run every minute.
    const full = !quiet && lines >= settings.maxMessages;
    const last = db
      .prepare('SELECT MAX(started_at) AS at FROM session_runs WHERE scope_key = ? AND mode = ?')
      .get(sweepScope.key, settings.mode)?.at;
    const lastMs = typeof last === 'string' ? Date.parse(last) : NaN;
    if (!full && Number.isFinite(lastMs) && now - lastMs < settings.everyMinutes * MINUTE) continue;
    out.push({ key: sweepScope.key, lines, full });
  }
  return out;
}

/** The accepted description reviews written on the UTC day of `now`. */
export function reviewsToday(db: Db, now: number): number {
  return db
    .prepare(
      "SELECT COUNT(*) AS n FROM description_versions WHERE origin = 'review' AND retired_at IS NULL AND substr(written_at, 1, 10) = ?"
    )
    .get(dayOf(now))?.n as number;
}

/** The display name of a review's subject: an account's first name, a place's name, her own name. */
function subjectName(db: Db, kind: string, id: string, selfName: string): string | null {
  if (kind === 'self') return selfName || null;
  try {
    if (kind === 'place')
      return (db.prepare('SELECT name FROM places WHERE id = ?').get(id)?.name as string | undefined) ?? null;
    for (const row of db.prepare('SELECT names FROM accounts WHERE person_id = ? ORDER BY id').all(id)) {
      const names = parse(row.names) as unknown;
      if (Array.isArray(names) && typeof names[0] === 'string' && names[0]) return names[0];
    }
  } catch {
    /* the id is the name */
  }
  return null;
}

/** The description flags waiting for a review, in review order (see the head of this file). */
/** A description flag waiting for a review, with the context its subject is read in. */
export type OpenFlag = {
  key: string;
  at: unknown;
  subject: { kind: string; id: string; name?: string };
  field: string;
  readCtx: Context;
};

/**
 * The context a flag's subject is read in: the group of its interface, or the DM its run swept: the stored place of
 * the run's audience (`audiences.place_id`), since a meta-person names no place.
 */
function flagContext(scope: Row, run: Row | undefined): Context {
  const iface = typeof scope.scope_iface === 'string' && scope.scope_iface ? scope.scope_iface : LEGACY_IFACE;
  if (scope.scope_kind !== 'dm' || !scope.scope_dm) return groupContext(iface);
  return dmContext(scope.scope_dm as string, iface, typeof run?.place_id === 'string' ? run.place_id : null);
}

export function openFlags(
  db: Db,
  config: Config,
  { skip = new Set<string>(), selfName = '' }: { skip?: Set<string>; selfName?: string } = {}
): Array<OpenFlag> {
  const audienceColumn = true;
  const rows = db
    .prepare(
      "SELECT id, at, extra FROM decisions WHERE action = 'flag:description' AND by = 'her' AND retired_at IS NULL ORDER BY at, id"
    )
    .all();
  const reviewed = db.prepare(
    "SELECT 1 AS ok FROM description_versions WHERE description_id = ? AND origin = 'review' AND retired_at IS NULL AND written_at >= ? LIMIT 1"
  );
  const runPlace = db.prepare(
    'SELECT u.place_id FROM session_runs r JOIN audiences u ON u.id = r.audience_id WHERE r.id = ?'
  );
  const seen = new Set<string>();
  const flags: Array<OpenFlag> = [];
  for (const row of rows) {
    const extra = parse(row.extra);
    const op = extra?.op as Row | undefined;
    const kind = op?.subjectKind as string | undefined;
    if (
      !op ||
      !['person', 'place', 'self', 'entity'].includes(kind as string) ||
      typeof op.subjectId !== 'string' ||
      !DESCRIPTION_FIELDS.includes(op.field as string)
    )
      continue;
    const scope = (extra?.scope ?? {}) as Row;
    const base = flagContext(scope, typeof extra?.run === 'string' ? runPlace.get(extra.run) : undefined);
    const readCtx: Context = audienceColumn ? { ...base, audienceColumn: true } : base;
    const subject = { kind: kind as string, id: kind === 'self' ? SELF_PERSON : op.subjectId };
    const key = descriptionIdFor(db, subject, op.field, scopeOfContext(readCtx), {
      audienceColumn,
      dmPlace: readCtx.place ?? null,
    });
    // A flag an accepted review answered since is closed; a later flag of the same description opens it again.
    if (seen.has(key) || skip.has(key) || reviewed.get(key, row.at)) continue;
    seen.add(key);
    const name =
      subject.kind === 'entity'
        ? (entityLabels(db, readCtx, subject.id, { recordedBefore: null })[0]?.text ?? null)
        : subjectName(db, subject.kind, subject.id, selfName);
    flags.push({ key, at: row.at, subject: name ? { ...subject, name } : subject, field: op.field as string, readCtx });
  }
  const close = closePeople(db);
  const rank = (flag: OpenFlag): number => {
    const at = flag.subject.kind === 'person' ? close.indexOf(flag.subject.id) : -1;
    return at === -1 ? Infinity : at;
  };
  return flags
    .map((flag, order) => ({ flag, order }))
    .sort((a, b) => rank(a.flag) - rank(b.flag) || a.order - b.order)
    .map(({ flag }) => flag);
}

/** The name of the key a request of `role` goes out on now, as the key ring routes it; null without a key or a ring. */
function keyNameOf(ring: KeyRing | null | undefined, role: string): string | null {
  return ring?.route(role)?.name ?? null;
}

/** The effective models (see the head of this file): the memory writer's purposes first, then every other purpose. */
/** One purpose with its role, its model and the name of the key a request goes out on. */
export type EffectiveModel = { purpose: string; role: string; model: string | null; key: string | null };

export function effectiveModels(config: Config, ring: KeyRing | null | undefined): Array<EffectiveModel> {
  const out: Array<EffectiveModel> = [];
  for (const purpose of MEMORY_PURPOSES) {
    out.push({
      purpose,
      role: MEMORY_ROLE,
      model: roleModel(config, MEMORY_ROLE) ?? null,
      key: keyNameOf(ring, MEMORY_ROLE),
    });
  }
  for (const [purpose, role] of Object.entries(PURPOSE_ROLES)) {
    out.push({ purpose, role, model: roleModel(config, role, purpose) ?? null, key: keyNameOf(ring, role) });
  }
  return out;
}

/** `purpose=model@KEY` per entry (`@none`: no key; the request would be refused). */
export function effectiveModelsLine(list: ReadonlyArray<EffectiveModel>): Array<string> {
  return list.map((entry) => `${entry.purpose}=${entry.model ?? '-'}@${entry.key ?? 'none'}`);
}
