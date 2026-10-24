// Her memory session (plan 2026-10-20-memory-f, section 8; docs/prompt-contract.md, "Memory session"). She reads the
// new chat lines of one scope from the database and says what she keeps; the engine checks every part of the answer
// against what it sent, then writes it (shadow: as proposals; apply: into the database).
//
// sweep(ctx) -> { status, code?, runs[] }
//   A sweep is one pass over the scopes with new lines: the public channels of an interface together (`group:<iface>`),
//   each private conversation alone (`dm:<iface>:<person>`). Each scope has a cursor in `meta`
//   (`memory_session.cursor.<mode>.<scope>`, a `sources.rowid`), so a line is read once. At most `sweepsPerDay` sweeps a
//   UTC day. One request per scope with at least `minMessages` new lines, at most `maxMessages` lines each, serial.
//   The cursor moves only when the answer parsed; a failed request or an unreadable answer leaves the lines for the
//   next sweep.
//
// The request (buildSessionRequest): the system text her turns get (system prompt, card, rules, format), then
// prompts/memory-session.md; the user content in blocks, stable first: <self> <place> <people> <episodes>
// <intentions> <batch>. People are rendered by the renderer her turns use (behavior/prompt.js#renderProfile) from the
// profile the database rebuilds (export.js#exportOne), then the attitude (the affinity number) and the claims shown
// with their ids. Ids in the request are short and local: `#n` for lines, `cN` / `sN` for claims, `eN` for episodes.
// The answer is mapped back to database ids here; an id the request did not carry, a line it did not number, a kind or
// a source list that is missing or wrong is dropped and counted, never guessed.
//
// Context (`ctx`): { db (a connection that can read), write (session-write.js through the writer: the service's
// `memoryWrite`), llm (`complete`), hot ({ config, prompts }), env, now, log, selfName, rng? }.
// The sweep reads hot.config at the moment of use. No provider reasoning is ever sent. Logs carry counts and codes.

import { block, fillPromptTemplate, renderProfile } from '../../behavior/prompt.js';
import { concernsMember, isOpen } from '../../intentions/model.js';
import { ROLE_KEY_NAME } from '../../llm/openrouter.js';
import { MEMORY_ROLE, roleModel } from '../../llm/roles.js';
import { exportOne } from './export.js';
import { SELF_PERSON, nativeOf, shortHash } from './ids.js';
import { dmContext, groupContext, whereFor } from './scope.js';

export const SESSION_PURPOSE = 'memory-session';
export const CLAIM_KINDS = Object.freeze(['detail', 'interest', 'alias', 'injoke', 'self_fact', 'lesson', 'pattern']);
export const HOW = Object.freeze(['said', 'saw', 'claimed', 'inferred', 'taught']);
export const TRUTHS = Object.freeze(['historical', 'disputed', 'retired']);
export const DESCRIPTION_FIELDS = Object.freeze(['character', 'style', 'relationship', 'purpose', 'topics', 'tone', 'patterns', 'starters', 'self_view']);
/** Status codes. */
export const CODES = Object.freeze({ OFF: 'off', NOT_CONFIGURED: 'not_configured', APPLY_REFUSED: 'APPLY_JSON_WRITER', NO_PROMPT: 'no_prompt', SWEEP_CAP: 'sweep_cap', NOT_READY: 'not_ready' });

const DEFAULTS = Object.freeze({
  mode: 'off', maxMessages: 200, minMessages: 5, sweepsPerDay: 4, settleMinutes: 10, since: null, maxPeople: 12,
  claimsPerPerson: 30, selfMax: 40, episodesMax: 20, maxOutputTokens: 4000, timeoutMs: 300000, descriptionMaxOutputTokens: 1500,
});
const MODES = ['off', 'shadow', 'apply'];
const MINUTE = 60_000;

const posInt = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);

/** The session settings of this moment, from the live config. */
export function sessionSettings(config) {
  const given = config?.memoryDb?.session ?? {};
  return {
    mode: MODES.includes(given.mode) ? given.mode : DEFAULTS.mode,
    maxMessages: posInt(given.maxMessages, DEFAULTS.maxMessages),
    minMessages: posInt(given.minMessages, DEFAULTS.minMessages),
    sweepsPerDay: posInt(given.sweepsPerDay, DEFAULTS.sweepsPerDay),
    settleMinutes: Number.isFinite(given.settleMinutes) && given.settleMinutes >= 0 ? given.settleMinutes : DEFAULTS.settleMinutes,
    since: typeof given.since === 'string' && given.since ? given.since : null,
    maxPeople: posInt(given.maxPeople, DEFAULTS.maxPeople),
    claimsPerPerson: posInt(given.claimsPerPerson, DEFAULTS.claimsPerPerson),
    selfMax: posInt(given.selfMax, DEFAULTS.selfMax),
    episodesMax: posInt(given.episodesMax, DEFAULTS.episodesMax),
    maxOutputTokens: posInt(given.maxOutputTokens, DEFAULTS.maxOutputTokens),
    timeoutMs: posInt(given.timeoutMs, DEFAULTS.timeoutMs),
    descriptionMaxOutputTokens: posInt(given.descriptionMaxOutputTokens, DEFAULTS.descriptionMaxOutputTokens),
  };
}

/**
 * Whether the memory role has its own key: `llm.keyByRole.memory` names a variable (OPENROUTER_*) that is set in
 * `env`. No other key stands in. `name` is the variable's name (never its value).
 */
export function memoryKeyState(config, env) {
  const name = config?.llm?.keyByRole?.memory;
  const valid = typeof name === 'string' && ROLE_KEY_NAME.test(name);
  const value = valid && env ? env[name] : undefined;
  return { ok: typeof value === 'string' && value.trim() !== '', name: valid ? name : null };
}

/**
 * Why the session cannot run now, or null: `off` (mode), `not_configured` (no key of its own), `APPLY_JSON_WRITER`
 * (mode apply while `memoryDb.read` is not on: the JSON files are still the writer), `no_prompt`.
 */
export function refusalOf(config, env, prompts) {
  const { mode } = sessionSettings(config);
  if (mode === 'off') return CODES.OFF;
  if (!memoryKeyState(config, env).ok) return CODES.NOT_CONFIGURED;
  if (mode === 'apply' && config?.memoryDb?.read !== true) return CODES.APPLY_REFUSED;
  if (typeof prompts?.['memory-session'] !== 'string' || !prompts['memory-session'].trim()) return CODES.NO_PROMPT;
  return null;
}

/** The system text her turns get (system prompt, card, rules, format), then `extra` (a prompt of the memory family). */
export function systemTextOf(prompts, selfName, extra) {
  const fill = (text) => fillPromptTemplate(text, { name: selfName });
  return [prompts?.['system-prompt'], prompts?.['character-card'], prompts?.rules, prompts?.format, extra]
    .map((text) => (typeof text === 'string' ? fill(text) : ''))
    .filter(Boolean)
    .join('\n\n');
}

const parseJson = (text) => {
  if (typeof text !== 'string' || !text) return null;
  try { return JSON.parse(text); } catch { return null; }
};

/** `2026-10-24 10:05` in `timezone` (a line's time in the batch, the cutoff). */
export function stamp(ms, timezone = 'UTC') {
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
  return parts.replace(/ /g, ' ');
}

// ---------- scopes and batches ----------

/** `current`: the newest revision of a chat line, not retired, not deleted (alias `s`). */
const CURRENT = `s.kind IN ('seen', 'said') AND s.retired_at IS NULL
  AND s.revision IS (SELECT MAX(t.revision) FROM sources t WHERE t.native_id = s.native_id AND t.kind IN ('seen', 'said') AND t.retired_at IS NULL)
  AND s.rowid = (SELECT MIN(t.rowid) FROM sources t WHERE t.native_id = s.native_id AND t.kind IN ('seen', 'said') AND t.retired_at IS NULL AND t.revision IS s.revision)
  AND NOT EXISTS (SELECT 1 FROM sources d WHERE d.native_id = s.native_id AND d.kind = 'deleted' AND d.retired_at IS NULL)`;

/** A scope as the sweep walks it: `{ key, scope: { scope_kind, scope_iface, scope_dm }, ctx }`. */
function scopeOf(row) {
  if (row.scope_kind === 'group') {
    return { key: `group:${row.scope_iface}`, scope: { scope_kind: 'group', scope_iface: row.scope_iface, scope_dm: null }, ctx: groupContext(row.scope_iface) };
  }
  return { key: `dm:${row.scope_iface}:${row.scope_dm}`, scope: { scope_kind: 'dm', scope_iface: row.scope_iface, scope_dm: row.scope_dm }, ctx: dmContext(row.scope_dm, row.scope_iface) };
}

/** The scopes that have chat lines, group first, in a stable order. */
export function scopesOf(db) {
  const rows = db.prepare(
    `SELECT DISTINCT scope_kind, scope_iface, scope_dm FROM sources
      WHERE kind IN ('seen', 'said') AND retired_at IS NULL AND scope_kind IN ('group', 'dm') AND scope_iface IS NOT NULL
      ORDER BY scope_kind, scope_iface, scope_dm`,
  ).all();
  return rows.map(scopeOf);
}

export const cursorKey = (mode, scopeKey) => `memory_session.cursor.${mode}.${scopeKey}`;

const metaOf = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;

/** The lines of a scope after its cursor, up to `maxMessages`, cut at the first line newer than `settleBefore` (ms). */
export function batchOf(db, scope, { cursor, since, maxMessages, settleBefore }) {
  const where = ['s.rowid > ?', 's.scope_kind = ?', 's.scope_iface = ?', CURRENT];
  const params = [cursor, scope.scope_kind, scope.scope_iface];
  if (scope.scope_kind === 'dm') { where.push('s.scope_dm = ?'); params.push(scope.scope_dm); }
  if (since) { where.push('s.occurred_at >= ?'); params.push(since); }
  const rows = db.prepare(
    `SELECT s.rowid AS rowid, s.id, s.native_id, s.kind, s.place_id, s.author_account, s.occurred_at, s.text, s.direct
       FROM sources s WHERE ${where.join(' AND ')} ORDER BY s.rowid LIMIT ?`,
  ).all(...params, maxMessages);
  const out = [];
  for (const row of rows) {
    const at = Date.parse(row.occurred_at);
    if (Number.isFinite(settleBefore) && Number.isFinite(at) && at > settleBefore) break;
    out.push({ ...row, at: Number.isFinite(at) ? at : 0 });
  }
  return out;
}

// ---------- the request ----------

const foldName = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** The names and ids of the accounts and people a batch touches. */
function peopleOf(db, batch, selfName) {
  const accountIds = [...new Set(batch.map((line) => line.author_account).filter(Boolean))];
  const accounts = new Map();
  for (const id of accountIds) {
    const row = db.prepare('SELECT id, person_id, native_id, names FROM accounts WHERE id = ?').get(id);
    if (!row) continue;
    const names = parseJson(row.names);
    accounts.set(id, { personId: row.person_id, native: row.native_id ?? nativeOf(id), name: Array.isArray(names) && typeof names[0] === 'string' && names[0] ? names[0] : (row.native_id ?? id) });
  }
  const byPerson = new Map();
  for (const line of batch) {
    if (line.kind === 'said') continue;
    const account = accounts.get(line.author_account);
    if (!account?.personId) continue;
    const entry = byPerson.get(account.personId) ?? { id: account.personId, native: account.native, name: account.name, count: 0 };
    entry.count += 1;
    byPerson.set(account.personId, entry);
  }
  return { accounts, people: [...byPerson.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)), selfName };
}

/** One line of the batch: `#n [time] name: text`, a line addressed to her led by `→ `, her own under her self label. */
function lineText(line, n, { accounts, selfName, labels, timezone }) {
  const own = line.kind === 'said';
  const author = own ? String(labels?.self ?? '{name}').replace('{name}', selfName) : (accounts.get(line.author_account)?.name ?? line.author_account ?? '?');
  const lead = !own && line.direct ? '→ ' : '';
  return `${lead}#${n} [${stamp(line.at, timezone)}] ${author}: ${String(line.text).replace(/\s*\n\s*/g, ' ⏎ ')}`;
}

function claimLine(label, row) {
  const text = String(row.text ?? '').replace(/\s+/g, ' ').trim();
  return `[${label}] ${row.kind ? `${row.kind}: ` : ''}${text}`;
}

function currentDescriptions(db, subjectIds, ctx) {
  if (subjectIds.length === 0) return [];
  const scope = whereFor(ctx, 'd');
  return db.prepare(
    `SELECT d.subject_id AS subject_id, d.field AS field, v.text AS text FROM descriptions d JOIN description_versions v ON v.id = d.current_version
      WHERE d.retired_at IS NULL AND d.subject_id IN (${subjectIds.map(() => '?').join(', ')}) AND ${scope.sql} ORDER BY d.subject_id, d.field`,
  ).all(...subjectIds, ...scope.params);
}

/**
 * The request of one batch. Returns `{ messages, maps, lines, people, places }`: `maps` carries what the answer's local
 * ids stand for (`sources`: `#n` -> source id, `claims`: `cN` / `sN` -> claim id, `episodes`: `eN` -> episode id).
 * @param {{ db: object, scope: object, batch: object[], config: object, prompts: object, selfName: string, now: number }} input
 */
export function buildSessionRequest({ db, scope, batch, config, prompts, selfName, now }) {
  const settings = sessionSettings(config);
  const labels = prompts?.labels ?? {};
  const timezone = config?.bot?.timezone ?? 'UTC';
  const { ctx } = scope;
  const maps = { sources: new Map(), claims: new Map(), episodes: new Map() };
  const touched = peopleOf(db, batch, selfName);
  const nameOf = (id) => {
    for (const account of touched.accounts.values()) if (account.native === String(id)) return account.name;
    return null;
  };

  // <batch>
  const rendered = [];
  let n = 0;
  for (const line of batch) {
    if (typeof line.text !== 'string' || line.text.trim() === '') continue;
    n += 1;
    maps.sources.set(`#${n}`, line.id);
    rendered.push(lineText(line, n, { accounts: touched.accounts, selfName, labels, timezone }));
  }
  const cutoff = batch.length > 0 ? batch[batch.length - 1].at : now;
  const batchBody = [`cutoff: ${stamp(cutoff, timezone)}`, ...rendered].join('\n');

  // <self>
  const selfScope = whereFor(ctx, 'c');
  const selfClaims = db.prepare(
    `SELECT c.id, c.kind, c.text FROM claims c WHERE c.subject_kind = 'self' AND c.retired_at IS NULL AND c.shown = 1 AND c.truth IN ('current', 'disputed')
       AND ${selfScope.sql} ORDER BY c.last_seen_at DESC, c.id LIMIT ?`,
  ).all(...selfScope.params, settings.selfMax);
  const selfLines = selfClaims.map((row, index) => {
    maps.claims.set(`s${index + 1}`, row.id);
    return claimLine(`s${index + 1}`, row);
  });

  // <place>
  const placeIds = [...new Set(batch.map((line) => line.place_id).filter(Boolean))];
  const placeRows = placeIds.map((id) => db.prepare('SELECT id, kind, name, topic, parent_id FROM places WHERE id = ?').get(id)).filter(Boolean);
  const guilds = [...new Set(placeRows.map((row) => row.parent_id).filter(Boolean))];
  const placeLines = [`scope: ${scope.scope.scope_kind}`];
  for (const row of placeRows) placeLines.push(`${row.kind === 'dm' ? 'dm' : 'channel'}: ${[row.name, row.topic].filter(Boolean).join(' - ') || row.id}`);
  for (const description of currentDescriptions(db, [...guilds, ...placeIds], ctx)) placeLines.push(`${description.field}: ${description.text}`);
  const placeScope = whereFor(ctx, 'c');
  const placeSubjects = [...guilds, ...placeIds];
  const placeClaims = placeSubjects.length === 0 ? [] : db.prepare(
    `SELECT c.id, c.kind, c.text FROM claims c WHERE c.subject_kind = 'place' AND c.subject_id IN (${placeSubjects.map(() => '?').join(', ')}) AND c.retired_at IS NULL
       AND c.shown = 1 AND c.truth IN ('current', 'disputed') AND ${placeScope.sql} ORDER BY c.last_seen_at DESC, c.id LIMIT ?`,
  ).all(...placeSubjects, ...placeScope.params, settings.claimsPerPerson);
  let claimNumber = 0;
  for (const row of placeClaims) {
    claimNumber += 1;
    maps.claims.set(`c${claimNumber}`, row.id);
    placeLines.push(claimLine(`c${claimNumber}`, row));
  }

  // <people>
  const shown = touched.people.slice(0, settings.maxPeople);
  const profileOptions = {
    interlocutor: true,
    relationships: true,
    maxInterests: config?.memory?.maxInterests,
    maxDetails: config?.memory?.maxDetails,
    maxAliases: config?.memory?.maxAliases,
    aliasHalfLifeDays: config?.memory?.aliasHalfLifeDays,
    addressHalfLifeDays: config?.memory?.addressHalfLifeDays,
    interestHalfLifeDays: config?.memory?.interestHalfLifeDays,
    detailHalfLifeDays: config?.memory?.detailHalfLifeDays,
    confirmAfter: config?.memory?.confirmAfter,
    staleDays: config?.memory?.interestStaleDays,
    supersededShownDays: config?.memory?.supersededShownDays,
    now,
    nameOf,
  };
  const peopleBodies = [];
  const personScope = whereFor(ctx, 'c');
  for (const person of shown) {
    const file = db.prepare("SELECT path FROM files WHERE path LIKE ? ESCAPE '\\' ORDER BY path LIMIT 1").get(`guilds/%/users/${person.native}.json`);
    let profile = null;
    if (file) {
      try {
        const found = exportOne(db, file.path);
        if (found.found) profile = found.value;
      } catch { /* the profile is shown without the stored text */ }
    }
    let text = '';
    try {
      text = profile ? renderProfile(profile, labels, profileOptions) : '';
    } catch { text = ''; }
    const row = db.prepare('SELECT affinity FROM people WHERE id = ?').get(person.id);
    const claims = db.prepare(
      `SELECT c.id, c.kind, c.text FROM claims c WHERE c.subject_kind = 'person' AND c.subject_id = ? AND c.retired_at IS NULL AND c.shown = 1
         AND c.truth IN ('current', 'disputed') AND ${personScope.sql} ORDER BY c.last_seen_at DESC, c.id LIMIT ?`,
    ).all(person.id, ...personScope.params, settings.claimsPerPerson);
    const lines = [text || `## ${person.name}`, `id: <@${person.native}>`];
    if (row && Number.isFinite(row.affinity)) lines.push(`affinity: ${row.affinity}`);
    for (const claim of claims) {
      claimNumber += 1;
      maps.claims.set(`c${claimNumber}`, claim.id);
      lines.push(claimLine(`c${claimNumber}`, claim));
    }
    peopleBodies.push(lines.join('\n'));
  }

  // <episodes>
  const episodeLines = [];
  if (shown.length > 0) {
    const episodeScope = whereFor(ctx, 'e');
    const ids = shown.map((person) => person.id);
    const rows = db.prepare(
      `SELECT e.id, e.subject_id, e.date, e.what, e.feeling FROM episodes e
        WHERE e.retired_at IS NULL AND (e.status IS NULL OR e.status != 'closed') AND e.subject_id IN (${ids.map(() => '?').join(', ')}) AND ${episodeScope.sql}
        ORDER BY COALESCE(e.last_ms, 0) DESC, e.date DESC, e.id LIMIT ?`,
    ).all(...ids, ...episodeScope.params, settings.episodesMax);
    rows.forEach((row, index) => {
      maps.episodes.set(`e${index + 1}`, row.id);
      const who = shown.find((person) => person.id === row.subject_id)?.name ?? row.subject_id;
      episodeLines.push(`[e${index + 1}] ${[row.date, who].filter(Boolean).join(' ')}: ${row.what}${row.feeling ? ` (${row.feeling})` : ''}`);
    });
  }

  // <intentions>
  const intentionLines = [];
  const intentionScope = whereFor(ctx, 'i');
  const records = db.prepare(`SELECT i.record FROM intentions i WHERE i.archived = 0 AND i.retired_at IS NULL AND ${intentionScope.sql} ORDER BY i.created_ms`).all(...intentionScope.params);
  for (const row of records) {
    const record = parseJson(row.record);
    if (!record || !isOpen(record.status)) continue;
    const concerns = shown.some((person) => concernsMember(record, { userId: person.native, names: [person.name] }))
      || placeIds.some((id) => JSON.stringify(record).includes(nativeOf(id) ?? '\u0000'));
    if (concerns && typeof record.purpose === 'string') intentionLines.push(`${record.status}: ${record.purpose}`);
  }

  const system = systemTextOf(prompts, selfName, prompts?.['memory-session']);
  const user = [
    block('self', selfLines.join('\n')),
    block('place', placeLines.join('\n')),
    block('people', peopleBodies.join('\n\n')),
    block('episodes', episodeLines.join('\n')),
    block('intentions', intentionLines.join('\n')),
    block('batch', batchBody),
  ].filter(Boolean).join('\n\n');
  return { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maps, lines: rendered.length, people: shown, places: placeIds };
}

// ---------- the answer ----------

/**
 * The `<memory>` object of an answer: the block after the thinking, a JSON object (a code fence around it is
 * tolerated). `{ ok: true, value }` or `{ ok: false, code }` (`no_block`, `bad_json`, `not_object`).
 */
export function parseSessionAnswer(text) {
  const raw = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const open = raw.lastIndexOf('<memory>');
  if (open === -1) return { ok: false, code: 'no_block' };
  let body = raw.slice(open + '<memory>'.length);
  const close = body.indexOf('</memory>');
  if (close !== -1) body = body.slice(0, close);
  body = body.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let value;
  try { value = JSON.parse(body); } catch { return { ok: false, code: 'bad_json' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'not_object' };
  return { ok: true, value };
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Checks a parsed answer against the request and resolves it to database ids. Anything that does not hold is dropped
 * and counted by reason, never repaired. Returns `{ plan, counts }`; `counts.kept` and `counts.dropped` (by reason).
 * @param {object} value  The `<memory>` object.
 * @param {{ maps: object, people: object[], placeId: string|null, scopeKey: string }} request
 */
export function validateAnswer(value, { maps, people, placeId }) {
  const plan = { claims: [], episodes: [], affinity: [], descriptions: [] };
  const counts = { kept: 0, dropped: {} };
  const drop = (reason) => { counts.dropped[reason] = (counts.dropped[reason] ?? 0) + 1; };
  const personByKey = new Map();
  const ambiguous = new Set();
  for (const person of people) {
    for (const key of [foldName(person.name), person.id, person.native, `<@${person.native}>`]) {
      if (personByKey.has(key) && personByKey.get(key) !== person) ambiguous.add(key);
      personByKey.set(key, person);
    }
  }

  const sourcesOf = (list) => {
    const out = [];
    for (const ref of Array.isArray(list) ? list : []) {
      const key = typeof ref === 'number' ? `#${ref}` : text(ref).replace(/^(?!#)/, '#');
      const id = maps.sources.get(key);
      if (id) { if (!out.includes(id)) out.push(id); } else drop('unknown_source');
    }
    return out;
  };
  const person = (subject) => {
    const key = foldName(subject);
    if (ambiguous.has(key)) return null;
    return personByKey.get(key) ?? personByKey.get(text(subject)) ?? null;
  };
  const subjectOf = (subject) => {
    const word = foldName(subject);
    if (word === 'self') return { kind: 'self', id: SELF_PERSON };
    if (word === 'place') return placeId ? { kind: 'place', id: placeId } : null;
    const found = person(subject);
    return found ? { kind: 'person', id: found.id } : null;
  };
  const keep = (group, entry) => { plan[group].push(entry); counts.kept += 1; };

  const list = (key) => {
    const given = value[key];
    if (given === undefined) return [];
    if (!Array.isArray(given)) { drop(`${key}_not_list`); return []; }
    return given;
  };

  for (const item of list('claims')) {
    if (!isObject(item)) { drop('bad_op'); continue; }
    const op = text(item.op);
    if (op === 'add') {
      const subject = subjectOf(item.subject);
      if (!subject) { drop('unknown_subject'); continue; }
      if (!CLAIM_KINDS.includes(item.kind)) { drop('bad_kind'); continue; }
      if (!text(item.text)) { drop('no_text'); continue; }
      if (!HOW.includes(item.how)) { drop('bad_how'); continue; }
      const sources = sourcesOf(item.sources);
      if (sources.length === 0) { drop('no_sources'); continue; }
      keep('claims', { op, subjectKind: subject.kind, subjectId: subject.id, kind: item.kind, text: text(item.text), how: item.how, sources, when: text(item.when) || null });
    } else if (op === 'confirm' || op === 'revise' || op === 'retire') {
      const id = maps.claims.get(text(item.id));
      if (!id) { drop('unknown_id'); continue; }
      const sources = sourcesOf(item.sources);
      if (sources.length === 0) { drop('no_sources'); continue; }
      if (op === 'confirm') { keep('claims', { op, id, sources }); continue; }
      if (op === 'revise') {
        if (!text(item.text)) { drop('no_text'); continue; }
        if (!HOW.includes(item.how)) { drop('bad_how'); continue; }
        keep('claims', { op, id, text: text(item.text), how: item.how, sources, reason: text(item.reason) || null });
        continue;
      }
      if (!TRUTHS.includes(item.truth)) { drop('bad_truth'); continue; }
      keep('claims', { op, id, truth: item.truth, reason: text(item.reason) || null, sources });
    } else {
      drop('bad_op');
    }
  }

  for (const item of list('episodes')) {
    if (!isObject(item)) { drop('bad_op'); continue; }
    const found = person(item.subject);
    if (!found) { drop('unknown_subject'); continue; }
    if (!text(item.what)) { drop('no_text'); continue; }
    const sources = sourcesOf(item.sources);
    if (sources.length === 0) { drop('no_sources'); continue; }
    keep('episodes', { subjectId: found.id, what: text(item.what), feeling: text(item.feeling), sources });
  }

  for (const item of list('affinity')) {
    if (!isObject(item)) { drop('bad_op'); continue; }
    const found = person(item.person);
    if (!found) { drop('unknown_subject'); continue; }
    if (typeof item.delta !== 'number' || !Number.isFinite(item.delta) || Math.round(item.delta) === 0) { drop('bad_delta'); continue; }
    const sources = sourcesOf(item.sources);
    if (sources.length === 0) { drop('no_sources'); continue; }
    keep('affinity', { personId: found.id, delta: Math.round(item.delta), reason: text(item.reason) || null, sources });
  }

  for (const item of list('descriptions')) {
    if (!isObject(item)) { drop('bad_op'); continue; }
    const subject = subjectOf(item.subject);
    if (!subject) { drop('unknown_subject'); continue; }
    if (!DESCRIPTION_FIELDS.includes(item.field)) { drop('bad_field'); continue; }
    keep('descriptions', { subjectKind: subject.kind, subjectId: subject.id, field: item.field, why: text(item.why) || null });
  }
  return { plan, counts };
}

// ---------- the sweep ----------

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const codeOf = (error) => error?.code ?? error?.name ?? 'ERROR';

/** How many sweeps have started on the UTC day of `now`. */
export function sweepsToday(db, now) {
  return db.prepare("SELECT COUNT(DISTINCT sweep_id) AS n FROM session_runs WHERE substr(started_at, 1, 10) = ? AND sweep_id IS NOT NULL").get(dayOf(now)).n;
}

/**
 * The state of the session for the status card: `{ mode, state, code, sweepsToday, last }` (`state`: `off`,
 * `not_configured`, `refused`, `ready`). `last` is the newest run's outcome and time.
 */
export function sessionStatus({ db, config, env, prompts, now = Date.now() }) {
  const { mode, sweepsPerDay } = sessionSettings(config);
  const code = refusalOf(config, env, prompts);
  let state = 'ready';
  if (code === CODES.OFF) state = 'off';
  else if (code === CODES.NOT_CONFIGURED) state = 'not_configured';
  else if (code) state = 'refused';
  let today = null;
  let last = null;
  if (db) {
    try {
      today = sweepsToday(db, now);
      const row = db.prepare('SELECT outcome, finished_at, scope_key FROM session_runs ORDER BY finished_at DESC, rowid DESC LIMIT 1').get();
      if (row) last = { outcome: row.outcome, at: row.finished_at };
    } catch { /* an older database without the table */ }
  }
  return { mode, state, code, sweepsToday: today, sweepsPerDay, last };
}

/**
 * One sweep (see the head of this file). Options: `scope` (a scope key: only that one), `limit` (a smaller
 * `maxMessages`), `ignoreSweepCap`. Resolves `{ status, code?, runs }`; `runs` has one entry per request.
 * @param {object} ctx
 */
export async function sweep(ctx, options = {}) {
  const { db, hot, env } = ctx;
  const now = ctx.now ?? Date.now;
  const config = hot.config;
  const refused = refusalOf(config, env, hot.prompts);
  if (refused) return { status: refused === CODES.OFF ? 'off' : 'refused', code: refused, runs: [] };
  const settings = sessionSettings(config);
  const started = now();
  if (!options.ignoreSweepCap && sweepsToday(db, started) >= settings.sweepsPerDay) return { status: 'refused', code: CODES.SWEEP_CAP, runs: [] };
  const sweepId = `sweep:${new Date(started).toISOString()}`;
  const maxMessages = options.limit ? Math.min(options.limit, settings.maxMessages) : settings.maxMessages;
  const runs = [];

  for (const scope of scopesOf(db)) {
    if (options.scope && options.scope !== scope.key) continue;
    const key = cursorKey(settings.mode, scope.key);
    const cursor = Number(metaOf(db, key) ?? 0);
    const batch = batchOf(db, scope.scope, { cursor, since: settings.since, maxMessages, settleBefore: now() - settings.settleMinutes * MINUTE });
    if (batch.length < Math.min(settings.minMessages, maxMessages)) { runs.push({ scope: scope.key, outcome: 'quiet', lines: batch.length }); continue; }
    runs.push(await runScope(ctx, { scope, batch, cursor, key, sweepId, settings, maxMessages }));
  }
  return { status: 'ok', runs };
}

/** One request: build, send, parse, validate, write. Never throws; the outcome is in the result. */
async function runScope(ctx, { scope, batch, cursor, key, sweepId, settings, maxMessages }) {
  const { db, write, llm, hot, log = {} } = ctx;
  const now = ctx.now ?? Date.now;
  const config = hot.config;
  const startedAt = now();
  const runId = `run:${shortHash(sweepId, scope.key)}`;
  const run = {
    id: runId, sweepId, scopeKey: scope.key, scope: scope.scope, startedAt: new Date(startedAt).toISOString(), finishedAt: null,
    cursorFrom: cursor, cursorTo: batch[batch.length - 1].rowid, sourcesN: batch.length, tokensPrompt: null, tokensCompletion: null,
    model: roleModel(config, MEMORY_ROLE), outcome: 'error', counts: {}, errors: [],
  };
  const finish = async (outcome, extra = {}) => {
    run.outcome = outcome;
    run.finishedAt = new Date(now()).toISOString();
    Object.assign(run, extra);
    const advance = extra.plan ? { key, value: run.cursorTo } : null;
    try {
      await write({ kind: 'session', mode: settings.mode, run, plan: extra.plan ?? null, advance, maxDelta: config?.relationships?.maxDeltaPerUpdate, now: now() });
    } catch (error) {
      run.errors.push(`write:${codeOf(error)}`);
      log.warn?.('memory session: write failed', { code: codeOf(error) });
    }
    log.debug?.('memory session: run', { scope: scope.scope.scope_kind, outcome, lines: batch.length, ...run.counts });
    return { scope: scope.key, outcome, lines: batch.length, counts: run.counts, errors: run.errors, ...(extra.plan ? { plan: extra.plan } : {}) };
  };

  let request;
  try {
    request = buildSessionRequest({
      db, scope, batch, config, prompts: hot.prompts, selfName: ctx.selfName ?? '', now: startedAt,
    });
  } catch (error) {
    run.errors.push(`build:${codeOf(error)}`);
    return finish('build_error');
  }
  const placeId = request.places.length > 0 ? (db.prepare('SELECT parent_id FROM places WHERE id = ?').get(request.places[0])?.parent_id ?? request.places[0]) : null;

  let completion;
  try {
    completion = await llm.complete(request.messages, {
      role: MEMORY_ROLE,
      purpose: SESSION_PURPOSE,
      model: roleModel(config, MEMORY_ROLE),
      maxOutputTokens: settings.maxOutputTokens,
      timeoutMs: settings.timeoutMs,
      temperature: config?.llm?.temperature,
      skipCalibration: true,
      cache: false,
      origin: SESSION_PURPOSE,
    });
  } catch (error) {
    run.errors.push(`llm:${codeOf(error)}`);
    return finish(codeOf(error) === 'ROLE_KEY_MISSING' ? CODES.NOT_CONFIGURED : 'llm_error');
  }
  run.tokensPrompt = Number(completion?.usage?.prompt_tokens) || null;
  run.tokensCompletion = Number(completion?.usage?.completion_tokens) || null;

  const parsed = parseSessionAnswer(completion?.text);
  if (!parsed.ok) {
    run.errors.push(parsed.code);
    return finish('bad_answer');
  }
  const { plan, counts } = validateAnswer(parsed.value, { maps: request.maps, people: request.people, placeId, scopeKey: scope.key });
  run.counts = { lines: request.lines, kept: counts.kept, dropped: counts.dropped, claims: plan.claims.length, episodes: plan.episodes.length, affinity: plan.affinity.length, descriptions: plan.descriptions.length };
  return finish(counts.kept === 0 && Object.keys(counts.dropped).length > 0 ? 'all_dropped' : 'ok', { plan });
}

/** The status card's line for the session, from `sessionStatus` and `labels.status.memorySession`; '' without the label. */
export function memorySessionStatusLine(status, labels, fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (all, key) => (key in values ? String(values[key]) : all))) {
  const set = labels?.status?.memorySession;
  if (!set || !status) return '';
  if (status.state === 'off') return set.off ?? '';
  if (status.state === 'not_configured') return set.notConfigured ?? '';
  if (status.state === 'refused') return fill(set.refused ?? '', { code: status.code });
  return fill(set.line ?? '', { mode: status.mode, sweeps: status.sweepsToday ?? 0, cap: status.sweepsPerDay, outcome: status.last?.outcome ?? '-', at: status.last?.at ?? '-' });
}
