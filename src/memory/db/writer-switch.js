// Her memory session as the memory writer (spec 2026-10-24-memory-authority, stage W3): the pure parts of the live
// schedule the service runs with `memoryDb.session.mode` `apply`, and the effective models the service names at its
// start. Reads only; every write goes through the service's writer.
//
//   dueScopes(db, config, now) -> [{ key, lines, full }]
//     The scopes a sweep should take now: at least `minMessages` settled lines after the scope's cursor, and either
//     `everyMinutes` since the scope's last run (no run yet counts as long ago) or `maxMessages` lines waiting (`full`),
//     and fewer than `sweepsPerScopePerDay` sweeps of the scope today (UTC). The lines are counted the way the sweep
//     reads them (session.js#batchOf: after the cursor, at most `maxMessages`, cut at the settle time).
//   openFlags(db, config, { skip, selfName }) -> [{ key, at, subject, field, readCtx }]
//     The description flags her session runs raised (`decisions` rows `flag:description`, `by` her) whose description
//     has no accepted review (`origin` `review`) written since the flag, one per description (its oldest open flag: a
//     flag raised after the last review opens the description again), in
//     the order the reviews are run: with `memoryDb.focus.enabled` the people of her focus close set first (by their
//     focus score), then every other flag by its age, oldest first. `skip`: description ids not to offer again today.
//   reviewsToday(db, now) -> number    the accepted reviews written on the UTC day of `now`
//   effectiveModels(config, env) -> [{ purpose, role, model, key }]
//     The model and the key variable each request of the memory writer and of every other named purpose goes out on,
//     resolved from the live config the way the callers resolve it (session.js / describe.js call roleModel with the
//     role alone; the analyzer purposes with their purpose) and openrouter.js#roleApiKey picks the key: the variable
//     `llm.keyByRole.<role>` names when it is set, else `OPENROUTER_CORE_KEY`, except the strict roles (`memory`), whose
//     key is null when its variable is unset: no other key stands in. Names only, never a value.
//   effectiveModelsLine(list) -> string[]    `purpose=model@KEY` per entry, for the start-up log line

import { ROLE_KEY_NAME, STRICT_KEY_ROLES } from '../../llm/openrouter.js';
import { MEMORY_PURPOSES, MEMORY_ROLE, PURPOSE_ROLES, roleModel } from '../../llm/roles.js';
import { batchOf, cursorKey, DESCRIPTION_FIELDS, scopeSweepsToday, scopesOf, sessionSettings } from './session.js';
import { descriptionIdFor, scopeOfContext } from './describe.js';
import { dmContext, groupContext } from './scope.ts';
import { SELF_PERSON } from './ids.ts';
import { LEGACY_IFACE } from './legacy-namespace.ts';
import { closePeople } from './focus.js';

const MINUTE = 60_000;
const MAIN_KEY = 'OPENROUTER_CORE_KEY';
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The scopes a scheduled sweep takes now (see the head of this file). */
export function dueScopes(db, config, now) {
  const settings = sessionSettings(config);
  const out = [];
  const settleBefore = now - settings.settleMinutes * MINUTE;
  for (const scope of scopesOf(db, { audienceColumn: config?.memoryDb?.audienceColumn === true })) {
    const cursor = Number(
      db.prepare('SELECT value FROM meta WHERE key = ?').get(cursorKey(settings.mode, scope.key))?.value ?? 0
    );
    const batch = batchOf(db, scope.scope, {
      cursor,
      since: settings.since,
      maxMessages: settings.maxMessages,
      settleBefore,
      audienceId: scope.audienceId ?? null,
    });
    if (batch.length < Math.min(settings.minMessages, settings.maxMessages)) continue;
    if (scopeSweepsToday(db, scope.key, now, settings.mode) >= settings.sweepsPerScopePerDay) continue;
    const full = batch.length >= settings.maxMessages;
    const last = db
      .prepare('SELECT MAX(started_at) AS at FROM session_runs WHERE scope_key = ? AND mode = ?')
      .get(scope.key, settings.mode)?.at;
    const lastMs = typeof last === 'string' ? Date.parse(last) : NaN;
    if (!full && Number.isFinite(lastMs) && now - lastMs < settings.everyMinutes * MINUTE) continue;
    out.push({ key: scope.key, lines: batch.length, full });
  }
  return out;
}

/** The accepted description reviews written on the UTC day of `now`. */
export function reviewsToday(db, now) {
  return db
    .prepare(
      "SELECT COUNT(*) AS n FROM description_versions WHERE origin = 'review' AND retired_at IS NULL AND substr(written_at, 1, 10) = ?"
    )
    .get(dayOf(now)).n;
}

/** The display name of a review's subject: an account's first name, a place's name, her own name. */
function subjectName(db, kind, id, selfName) {
  if (kind === 'self') return selfName || null;
  try {
    if (kind === 'place') return db.prepare('SELECT name FROM places WHERE id = ?').get(id)?.name ?? null;
    for (const row of db.prepare('SELECT names FROM accounts WHERE person_id = ? ORDER BY id').all(id)) {
      const names = parse(row.names);
      if (Array.isArray(names) && typeof names[0] === 'string' && names[0]) return names[0];
    }
  } catch {
    /* the id is the name */
  }
  return null;
}

/** The description flags waiting for a review, in review order (see the head of this file). */
export function openFlags(db, config, { skip = new Set(), selfName = '' } = {}) {
  const audienceColumn = config?.memoryDb?.audienceColumn === true;
  const rows = db
    .prepare(
      "SELECT id, at, extra FROM decisions WHERE action = 'flag:description' AND by = 'her' AND retired_at IS NULL ORDER BY at, id"
    )
    .all();
  const reviewed = db.prepare(
    "SELECT 1 AS ok FROM description_versions WHERE description_id = ? AND origin = 'review' AND retired_at IS NULL AND written_at >= ? LIMIT 1"
  );
  const seen = new Set();
  const flags = [];
  for (const row of rows) {
    const extra = parse(row.extra);
    const op = extra?.op;
    const kind = op?.subjectKind;
    if (
      !['person', 'place', 'self'].includes(kind) ||
      typeof op.subjectId !== 'string' ||
      !DESCRIPTION_FIELDS.includes(op.field)
    )
      continue;
    const scope = extra.scope ?? {};
    const iface = typeof scope.scope_iface === 'string' && scope.scope_iface ? scope.scope_iface : LEGACY_IFACE;
    const base = scope.scope_kind === 'dm' && scope.scope_dm ? dmContext(scope.scope_dm, iface) : groupContext(iface);
    const readCtx = audienceColumn ? { ...base, audienceColumn: true } : base;
    const subject = { kind, id: kind === 'self' ? SELF_PERSON : op.subjectId };
    const key = descriptionIdFor(db, subject, op.field, scopeOfContext(readCtx), { audienceColumn });
    // A flag an accepted review answered since is closed; a later flag of the same description opens it again.
    if (seen.has(key) || skip.has(key) || reviewed.get(key, row.at)) continue;
    seen.add(key);
    const name = subjectName(db, kind, subject.id, selfName);
    flags.push({ key, at: row.at, subject: name ? { ...subject, name } : subject, field: op.field, readCtx });
  }
  const close = config?.memoryDb?.focus?.enabled === true ? closePeople(db) : [];
  const rank = (flag) => {
    const at = flag.subject.kind === 'person' ? close.indexOf(flag.subject.id) : -1;
    return at === -1 ? Infinity : at;
  };
  return flags
    .map((flag, order) => ({ flag, order }))
    .sort((a, b) => rank(a.flag) - rank(b.flag) || a.order - b.order)
    .map(({ flag }) => flag);
}

/** The key variable a request of `role` goes out on (openrouter.js#roleApiKey's choice), by name; null for none. */
function keyNameOf(config, env, role) {
  const name = config?.llm?.keyByRole?.[role];
  const valid = typeof name === 'string' && ROLE_KEY_NAME.test(name);
  if (valid && typeof env?.[name] === 'string' && env[name].trim()) return name;
  return STRICT_KEY_ROLES.includes(role) ? null : MAIN_KEY;
}

/** The effective models (see the head of this file): the memory writer's purposes first, then every other purpose. */
export function effectiveModels(config, env) {
  const out = [];
  for (const purpose of MEMORY_PURPOSES) {
    out.push({
      purpose,
      role: MEMORY_ROLE,
      model: roleModel(config, MEMORY_ROLE) ?? null,
      key: keyNameOf(config, env, MEMORY_ROLE),
    });
  }
  for (const [purpose, role] of Object.entries(PURPOSE_ROLES)) {
    out.push({ purpose, role, model: roleModel(config, role, purpose) ?? null, key: keyNameOf(config, env, role) });
  }
  return out;
}

/** `purpose=model@KEY` per entry (`@none`: no key; the request would be refused). */
export function effectiveModelsLine(list) {
  return list.map((entry) => `${entry.purpose}=${entry.model ?? '-'}@${entry.key ?? 'none'}`);
}
