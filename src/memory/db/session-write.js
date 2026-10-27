// The database writes of her memory session and description review (session.js, describe.js). They run on the
// writer connection: in the writer worker (writer-worker.js, message `memoryWrite`), or on the calling thread when there
// is no worker. This module imports nothing heavy, so the worker can load it.
//
// applyMemoryWrite(handle, update) -> counts
//   { kind: 'session', mode, run, plan, advance, pending, decision, answer, maxDelta, now }
//       `run` may be null for a write that only moves the cursor, the pending mark or records a `decision`.
//       One transaction: the `session_runs` row of the request, her whole answer as a `sources` row (kind
//       `memory_session`, scope internal), the cursor (`advance`: a meta key, the value, and the value it must still
//       have: a compare-and-set), the pending-batch mark (`pending`: a meta key and a value, or null to clear it), and
//       the plan the answer validated to. Any failure rolls the whole thing back: a cursor never moves without its writes.
//       - `mode` is `shadow` or `apply`; any other mode is refused (`BAD_MODE`).
//       - shadow: every op becomes one `decisions` row (`by` her, `action` `proposed:<op>`, the whole op in `extra`);
//         no claim, episode or attitude is touched.
//       - apply: claims (rows, versions, sources), episodes, attitude events and their effect on the score, and a
//         `decisions` row per op whose `action` is the op. A run is applied once: a second write of the same batch
//         (`run.batchKey`) returns the first result with `replayed: true` and changes nothing. An op whose declared
//         sources do not all resolve, whose reason is missing or whose target is outside the run's scope is rejected whole
//         (a `decisions` row `rejected:<why>`). A claim's scope is the narrowest scope of the run and of the NEW
//         sources; when it differs from the target claim's scope, the change is written as a new claim of that scope
//         and the old claim stays as it was.
//   { kind: 'description', mode, row, subject, scope, expectCurrent, answers, now }
//       One `description_versions` row. `shadow`: origin `shadow`, never current. `apply`: origin
//       `review`, and in the same transaction the `descriptions` row is created or moved to this version.
//   { kind: 'context', context }
//       One `execution_contexts` row (scope.ts#contextRow of a context the core issued); a context already recorded is
//       left as it is. Not a memory write: no mode.
//   { kind: 'wake', op, ... } | { kind: 'skills', entries, now } | { kind: 'index-policy' | 'touch' | 'reembed', ... }
//       Schema v11: handed to wakes.js#applyWakeWrite, skills.js#applySkillsWrite and index-policy.js#applyIndexWrite.
//       Bookkeeping of the database itself, not her memory: no mode.
//   { kind: 'publication', op: 'prepare' | 'sent' | 'failed' | 'unknown', ... }
//       The diary's mirrors (src/behavior/mirror.ts), handed to publish.js#applyPublicationWrite.
//   { kind: 'unit', op, ... }
//       The memory units (record and journal lines, the store's cache, the module stores, participation, the diary,
//       the vectors) and the projection the writers finish, handed to unit-write.js#applyUnitWrite.
//   { kind: 'backup', to, dataDir, now, commit, configHash }
//       The daily backup (backup.js#writeBackup) taken on this connection, the writer's, by `VACUUM INTO`:
//       a consistent copy, no WAL file copied. Not a memory write: no mode; returns the manifest.
//
// Every row with the scope triple is written with its `audience_id` from the one resolver (scope.ts#audienceOf, through
// rows.js), and her answer rows with their authority, author kind and `observed_at`. `update.audienceColumn` (stamped
// by the service from `memoryDb.audienceColumn`) makes the scope check of a target claim read `audience_id`.
//
// A plan is the validated, resolved form of the answer: ids are database ids, never the request's `#n` / `cN`.
//   claims:       { op: 'add', subjectKind, subjectId, kind, text, how, sources, when }
//                 { op: 'confirm', id, sources } { op: 'revise', id, text, how, sources, reason }
//                 { op: 'retire', id, truth, reason, sources }
//   episodes:     { subjectId, what, feeling, sources }
//   affinity:     { personId, delta, reason, sources }
//   descriptions: { subjectKind, subjectId, field, why }
//   people:       { op: 'add', subjectKind: 'account' | 'participant', subjectId, sources, reason }   (schema v8)
//                 shadow: a `decisions` row `proposed:people_add`. apply: a new person `person:<uuid>` (kind `person`,
//                 the uuid minted here; `update.uuid` injects it in tests), a `proposed` link (`account_person_links`
//                 or `participant_links`, evidence the first source) and a `decisions` row `people_add`. The account's
//                 `person_id` is not set: it stays the projection of a verified link. A subject that already has a
//                 person or a live link is rejected (`has_person`); the request does not offer the op yet.
// mergePeople(handle, from, into, { by, reason, evidence, now }) is the writer of `people_merges` (no session op yet):
// one row, the merged person's `status` `merged_into:<into>`; nothing else is rewritten (claims keep their subject,
// links keep their rows); a merge into a person that resolves back to `from` is refused (`MERGE_CYCLE`).
//
// Schema v9 (stage 3):
//   - every new claim version writes its sources into `claim_version_sources` (`supports` for add, confirm and revise,
//     `conflicts` for retire: the lines that speak against the claim);
//   - a confirm, revise or retire op may carry `base`, the claim version the session read (session.js fills it from the
//     request, never from her answer); when the claim's newest version is no longer `base`, the op is rejected whole as
//     `rejected:stale_base` (a `decisions` row). An op without `base` is not checked (a caller that read no version);
//     `base: null` says the session read the claim with no version, and a version written since makes it stale;
//   - `update.reads` (the rows `service.js#turnReadRows` resolved when the request was assembled) are written to
//     `turn_reads` in the same transaction, `reader_kind` `session`, `turn_id` the run id, `step` `update.readStep` (the
//     page), `context_id` the run's context (`update.context`, an issued context's row, recorded in
//     `execution_contexts` the same way);
//   - every row written here is projected into the graph in the same transaction (graph.js#projectRow).
// Counts and codes only, never a text.

import { randomUUID } from 'node:crypto';
import { CORE_AUTHORITY, SELF_PERSON, linkId, newPersonId, otherSourceId, shortHash, survivorOf } from './ids.ts';
import { audienceOf, canRead, dmContext, groupContext, internalContext, narrowest, SCOPE_INTERNAL } from './scope.ts';
import { ensureAudience, ensureInterface } from './rows.js';
import { projectRow } from './graph.js';
import { applyWakeWrite } from './wakes.js';
import { applySkillsWrite } from './skills.js';
import { applyIndexWrite } from './index-policy.js';
import { applyUnitWrite } from './unit-write.js';
import { applyPublicationWrite } from './publish.js';
import { writeBackup } from './backup.js';

/**
 * The newest live version of a claim (recorded time, then row order): the version a read of the claim is said to have
 * read (service.js#turnReadRows) and the one a `base` is checked against. Its one spelling.
 */
export const NEWEST_CLAIM_VERSION_SQL =
  "SELECT id FROM claim_versions WHERE claim_id = ? AND retired_at IS NULL ORDER BY COALESCE(recorded_at, '') DESC, rowid DESC LIMIT 1";
/** The id of the newest live version of a claim, or null. */
export const newestClaimVersion = (db, claimId) => db.prepare(NEWEST_CLAIM_VERSION_SQL).get(claimId)?.id ?? null;
const hasTable = (db, name) =>
  db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

const iso = (ms) => new Date(ms).toISOString();
const json = (value) => JSON.stringify(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const coded = (code) => Object.assign(new Error(code), { code });
const present = (value) => typeof value === 'string' && value.trim() !== '';

const SET_META = 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';

/** The target of a proposed op, for its `decisions` row. */
function targetOf(group, op) {
  switch (group) {
    case 'claims':
      return op.op === 'add' ? { kind: 'claim', id: null } : { kind: 'claim', id: op.id };
    case 'episodes':
      return { kind: 'episode', id: null };
    case 'affinity':
      return { kind: 'person', id: op.personId };
    case 'people':
      return { kind: op.subjectKind, id: op.subjectId };
    default:
      return { kind: 'description', id: `desc:${op.subjectId}:${op.field}` };
  }
}

const nameOf = (group, op) =>
  group === 'claims'
    ? op.op
    : group === 'descriptions'
      ? 'description'
      : group === 'episodes'
        ? 'episode'
        : group === 'people'
          ? `people_${op.op}`
          : 'affinity';
const reasonOf = (op) =>
  typeof op.reason === 'string' && op.reason ? op.reason : typeof op.why === 'string' && op.why ? op.why : null;

const scopeOfRow = (row) => ({
  scope_kind: row.scope_kind ?? null,
  scope_iface: row.scope_iface ?? null,
  scope_dm: row.scope_dm ?? null,
});
const sameScope = (a, b) =>
  (a.scope_kind ?? null) === (b.scope_kind ?? null) &&
  (a.scope_iface ?? null) === (b.scope_iface ?? null) &&
  (a.scope_dm ?? null) === (b.scope_dm ?? null);
function contextOf(scope, audienceColumn = false) {
  let ctx = internalContext();
  if (scope?.scope_kind === 'group' && scope.scope_iface) ctx = groupContext(scope.scope_iface);
  else if (scope?.scope_kind === 'dm' && scope.scope_iface && scope.scope_dm)
    ctx = dmContext(scope.scope_dm, scope.scope_iface);
  return audienceColumn === true ? { ...ctx, audienceColumn: true } : ctx;
}

/** The audience id of a scope (the one resolver), its audience row created when missing. */
function audienceIdOf(db, scope, at) {
  const resolved = audienceOf(scope);
  ensureAudience(db, resolved, { at });
  return resolved.audience_id;
}

function insertRun(db, run, mode, { applied, answerSource, at }) {
  db.prepare(
    `INSERT OR REPLACE INTO session_runs (id, sweep_id, scope_key, scope_kind, scope_iface, scope_dm, mode, started_at, finished_at,
       cursor_from, cursor_to, sources_n, tokens_prompt, tokens_completion, model, outcome, counts, errors, batch_key, applied, result, answer_source, audience_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  ).run(
    run.id,
    run.sweepId ?? null,
    run.scopeKey,
    run.scope?.scope_kind ?? null,
    run.scope?.scope_iface ?? null,
    run.scope?.scope_dm ?? null,
    mode,
    run.startedAt,
    run.finishedAt,
    run.cursorFrom ?? null,
    run.cursorTo ?? null,
    run.sourcesN ?? 0,
    run.tokensPrompt ?? null,
    run.tokensCompletion ?? null,
    run.model ?? null,
    run.outcome,
    json(run.counts ?? {}),
    json(run.errors ?? []),
    run.batchKey ?? null,
    applied ? 1 : 0,
    answerSource ?? null,
    audienceIdOf(db, run.scope ?? null, at)
  );
}

function insertDecision(db, { id, at, group, op, action, run }) {
  const target = targetOf(group, op);
  db.prepare(
    `INSERT OR REPLACE INTO decisions (id, at, by, target_kind, target_id, action, reason, extra, owner_file, position, retired_at)
     VALUES (?, ?, 'her', ?, ?, ?, ?, ?, NULL, NULL, NULL)`
  ).run(id, at, target.kind, target.id, action, reasonOf(op), json({ run: run.id, scope: run.scope ?? null, op }));
  projectRow(db, 'decisions', { id }, { at });
}

/** Her whole answer as a `sources` row of kind `kind`, scope internal; the thinking is kept in `think` as well. */
function insertAnswer(db, { id, kind, text, at, extra }) {
  const thought = [...String(text).matchAll(/<think>([\s\S]*?)<\/think>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean)
    .join('\n\n');
  db.prepare(
    `INSERT OR REPLACE INTO sources (id, kind, iface, native_id, revision, place_id, author_account, reply_to, occurred_at, recorded_at, seen_at, text, stems,
       media, mentions, direct, turn_id, op_id, think, extra, scope_kind, scope_iface, scope_dm, origin, owner_file, position,
       audience_id, authority_id, author_kind, observed_at)
     VALUES (?, ?, NULL, ?, 1, NULL, NULL, NULL, ?, ?, NULL, ?, NULL, NULL, NULL, 0, NULL, NULL, ?, ?, ?, ?, ?, 'memory', NULL, NULL, ?, ?, 'self', ?)`
  ).run(
    id,
    kind,
    id,
    at,
    at,
    String(text),
    thought || null,
    extra ? json(extra) : null,
    SCOPE_INTERNAL.scope_kind,
    SCOPE_INTERNAL.scope_iface,
    SCOPE_INTERNAL.scope_dm,
    audienceIdOf(db, SCOPE_INTERNAL, at),
    CORE_AUTHORITY,
    at
  );
  projectRow(db, 'sources', { id }, { at });
  return id;
}

/** The live links of a claim or an episode; a retired link is not a link. Links the database writes leave `owner_file` null. */
function addSources(db, table, key, id, sources) {
  const insert = db.prepare(`INSERT INTO ${table} (${key}, source_id, position) VALUES (?, ?, ?)`);
  const have = new Set(
    db
      .prepare(`SELECT source_id FROM ${table} WHERE ${key} = ? AND retired_at IS NULL`)
      .all(id)
      .map((row) => row.source_id)
  );
  let position = have.size;
  for (const source of sources ?? []) {
    if (have.has(source)) continue;
    have.add(source);
    insert.run(id, source, position);
    position += 1;
  }
}

/** The rows of the declared sources, or null when any of them does not resolve (the op is then rejected whole). */
function evidenceOf(db, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const find = db.prepare(
    'SELECT id, scope_kind, scope_iface, scope_dm FROM sources WHERE id = ? AND retired_at IS NULL'
  );
  const rows = [];
  for (const id of ids) {
    const row = typeof id === 'string' ? find.get(id) : undefined;
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}

/** A new version of a claim, with its sources (`evidence`: `supports` or `conflicts`) in `claim_version_sources` (v9). */
function version(db, { claimId, at, text, event, runId, index, extra = null, sources = [], evidence = 'supports' }) {
  const id = `cv:${claimId}:${shortHash(runId, index, event)}`;
  db.prepare(
    `INSERT OR REPLACE INTO claim_versions (id, claim_id, revision_id, text, extra, recorded_at, event, by, origin, owner_file, position, retired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'her', 'session', NULL, NULL, NULL)`
  ).run(id, claimId, `rv:${shortHash(runId, index)}`, text, extra ? json(extra) : null, at, event);
  if (hasTable(db, 'claim_version_sources')) {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO claim_version_sources (version_id, source_id, role, legacy) VALUES (?, ?, ?, 0)'
    );
    for (const source of new Set(sources ?? [])) insert.run(id, source, evidence);
  }
  projectRow(db, 'claims', { id: claimId }, { at });
}

function insertDecisionFor(db, { runId, index, at, op, action, target }) {
  db.prepare(
    `INSERT OR REPLACE INTO decisions (id, at, by, target_kind, target_id, action, reason, extra, owner_file, position, retired_at)
     VALUES (?, ?, 'her', ?, ?, ?, ?, ?, NULL, NULL, NULL)`
  ).run(
    `dec:${runId}:${index}`,
    at,
    action === 'episode' ? 'episode' : action === 'affinity' ? 'person' : 'claim',
    target,
    action,
    reasonOf(op),
    json({ run: runId, op })
  );
  projectRow(db, 'decisions', { id: `dec:${runId}:${index}` }, { at });
}

function reject(db, state, group, op, why) {
  state.counts.rejected += 1;
  insertDecision(db, {
    id: `dec:${state.runId}:${state.index}`,
    at: state.at,
    group,
    op,
    action: `rejected:${why}`,
    run: state.run,
  });
}

/** A claim of the scope `scope` made from `claim` (the old claim stays as it was); returns its id. */
function deriveClaim(db, claim, scope, { at, runId, index, text, how, truth, shown }) {
  const id = `clm:${shortHash(runId, index, 'derived', claim.id)}`;
  let extra = {};
  try {
    extra = claim.extra ? JSON.parse(claim.extra) : {};
  } catch {
    extra = {};
  }
  db.prepare(
    `INSERT OR REPLACE INTO claims (id, subject_kind, subject_id, kind, text, extra, weight, first_seen_at, last_seen_at, valid_to, superseded_by,
       how, author, from_person, truth, shown, scope_kind, scope_iface, scope_dm, created_at, retired_at, origin_file, owner_file, position, audience_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'her', NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`
  ).run(
    id,
    claim.subject_kind,
    claim.subject_id,
    claim.kind,
    text ?? claim.text,
    json({ ...extra, derivedFrom: claim.id }),
    claim.weight ?? null,
    at,
    at,
    how ?? claim.how,
    truth ?? claim.truth,
    shown ?? claim.shown,
    scope.scope_kind,
    scope.scope_iface,
    scope.scope_dm,
    at,
    audienceIdOf(db, scope, at)
  );
  projectRow(db, 'claims', { id }, { at });
  return id;
}

function applyClaim(db, op, state) {
  const { at, runId, index, counts } = state;
  const evidence = evidenceOf(db, op.sources);
  if (!evidence) return reject(db, state, 'claims', op, 'unknown_source');
  // The scope of the NEW version: the narrowest of the run and of its own sources, never the old version's.
  const scope = narrowest([state.scope, ...evidence.map(scopeOfRow)]);
  if (op.op === 'add') {
    const id = `clm:${shortHash(runId, index, op.subjectId, op.text)}`;
    db.prepare(
      `INSERT OR REPLACE INTO claims (id, subject_kind, subject_id, kind, text, extra, weight, first_seen_at, last_seen_at, valid_to, superseded_by,
         how, author, from_person, truth, shown, scope_kind, scope_iface, scope_dm, created_at, retired_at, origin_file, owner_file, position, audience_id)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, 'her', NULL, 'current', 1, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`
    ).run(
      id,
      op.subjectKind,
      op.subjectId,
      op.kind,
      op.text,
      op.when ? json({ when: op.when }) : null,
      at,
      at,
      op.how,
      scope.scope_kind,
      scope.scope_iface,
      scope.scope_dm,
      at,
      audienceIdOf(db, scope, at)
    );
    addSources(db, 'claim_sources', 'claim_id', id, op.sources);
    version(db, { claimId: id, at, text: op.text, event: 'add', runId, index, sources: op.sources });
    insertDecisionFor(db, { runId, index, at, op, action: 'add', target: id });
    counts.added += 1;
    return;
  }
  const claim = db.prepare('SELECT * FROM claims WHERE id = ? AND retired_at IS NULL').get(op.id);
  if (!claim) {
    counts.missing += 1;
    return;
  }
  if (!canRead(claim, contextOf(state.scope, state.audienceColumn)))
    return reject(db, state, 'claims', op, 'out_of_scope');
  if ((op.op === 'revise' || op.op === 'retire') && !present(op.reason))
    return reject(db, state, 'claims', op, 'no_reason');
  // Compare-and-set on the claim: the version the session read must still be its newest (schema v9).
  if (Object.hasOwn(op, 'base') && (op.base ?? null) !== newestClaimVersion(db, op.id))
    return reject(db, state, 'claims', op, 'stale_base');
  const derived = !sameScope(scope, scopeOfRow(claim));
  let target = op.id;
  if (op.op === 'confirm') {
    if (derived) target = deriveClaim(db, claim, scope, { at, runId, index });
    else db.prepare('UPDATE claims SET last_seen_at = ? WHERE id = ?').run(at, op.id);
    addSources(db, 'claim_sources', 'claim_id', target, op.sources);
    version(db, { claimId: target, at, text: claim.text, event: 'confirm', runId, index, sources: op.sources });
    counts.confirmed += 1;
  } else if (op.op === 'revise') {
    if (derived) target = deriveClaim(db, claim, scope, { at, runId, index, text: op.text, how: op.how });
    else
      db.prepare('UPDATE claims SET text = ?, how = ?, last_seen_at = ? WHERE id = ?').run(op.text, op.how, at, op.id);
    addSources(db, 'claim_sources', 'claim_id', target, op.sources);
    version(db, {
      claimId: target,
      at,
      text: op.text,
      event: 'revise',
      runId,
      index,
      extra: { before: claim.text, reason: op.reason },
      sources: op.sources,
    });
    counts.revised += 1;
  } else {
    // Disputed stays shown beside the claim it contradicts; historical and retired leave the shown set (still findable).
    const shown = op.truth === 'disputed' ? 1 : 0;
    const validTo = op.truth === 'disputed' ? null : at;
    if (derived) {
      target = deriveClaim(db, claim, scope, { at, runId, index, truth: op.truth, shown });
      if (validTo) db.prepare('UPDATE claims SET valid_to = ? WHERE id = ?').run(validTo, target);
    } else {
      db.prepare('UPDATE claims SET truth = ?, shown = ?, valid_to = COALESCE(?, valid_to) WHERE id = ?').run(
        op.truth,
        shown,
        validTo,
        op.id
      );
    }
    addSources(db, 'claim_sources', 'claim_id', target, op.sources);
    version(db, {
      claimId: target,
      at,
      text: claim.text,
      event: 'retire',
      runId,
      index,
      extra: { truth: op.truth, reason: op.reason },
      sources: op.sources,
      evidence: 'conflicts',
    });
    counts.retired += 1;
  }
  if (derived) counts.derived += 1;
  insertDecisionFor(db, { runId, index, at, op, action: op.op, target });
}

function applyEpisode(db, op, state) {
  const { at, runId, index, counts } = state;
  const evidence = evidenceOf(db, op.sources);
  if (!evidence) return reject(db, state, 'episodes', op, 'unknown_source');
  const scope = narrowest([state.scope, ...evidence.map(scopeOfRow)]);
  const id = `ep:${shortHash(runId, index, op.subjectId, op.what)}`;
  db.prepare(
    `INSERT OR REPLACE INTO episodes (id, kind, subject_id, place_id, date, what, quote, feeling, feeling_at, reread, weight, world, status, perspective,
       start_ms, last_ms, extra, scope_kind, scope_iface, scope_dm, created_at, retired_at, owner_file, position, audience_id)
     VALUES (?, 'session', ?, NULL, ?, ?, NULL, ?, ?, NULL, NULL, NULL, 'open', NULL, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL, NULL, ?)`
  ).run(
    id,
    op.subjectId,
    at.slice(0, 10),
    op.what,
    op.feeling || null,
    op.feeling ? at : null,
    scope.scope_kind,
    scope.scope_iface,
    scope.scope_dm,
    at,
    audienceIdOf(db, scope, at)
  );
  addSources(db, 'episode_sources', 'episode_id', id, op.sources);
  projectRow(db, 'episodes', { id }, { at });
  insertDecisionFor(db, { runId, index, at, op, action: 'episode', target: id });
  counts.episodes += 1;
}

function applyAffinity(db, op, state) {
  const { at, runId, index, counts } = state;
  const evidence = evidenceOf(db, op.sources);
  if (!evidence) return reject(db, state, 'affinity', op, 'unknown_source');
  if (!present(op.reason)) return reject(db, state, 'affinity', op, 'no_reason');
  const scope = narrowest([state.scope, ...evidence.map(scopeOfRow)]);
  const person = db.prepare('SELECT affinity FROM people WHERE id = ? AND retired_at IS NULL').get(op.personId);
  if (!person) {
    counts.missing += 1;
    return;
  }
  const eventId = `aff:${runId}:${index}`;
  // A second application of the same event is never a second delta.
  if (db.prepare('SELECT 1 AS ok FROM affinity_events WHERE id = ?').get(eventId)) {
    counts.duplicate += 1;
    return;
  }
  const before = Number.isFinite(person.affinity) ? person.affinity : 0;
  const cap = Number.isFinite(state.maxDelta) ? Math.abs(state.maxDelta) : Infinity;
  const applied = clamp(op.delta, -cap, cap);
  const score = Math.round(clamp(before + applied, -100, 100) * 100) / 100;
  db.prepare(
    `INSERT INTO affinity_events (id, person_id, at, delta, applied, score, reason, scope_kind, scope_iface, scope_dm, extra, owner_file, position, retired_at, audience_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`
  ).run(
    eventId,
    op.personId,
    at,
    op.delta,
    applied,
    score,
    op.reason,
    scope.scope_kind,
    scope.scope_iface,
    scope.scope_dm,
    json({ run: runId, sources: op.sources }),
    audienceIdOf(db, scope, at)
  );
  db.prepare('UPDATE people SET affinity = ?, affinity_reason = ? WHERE id = ?').run(score, op.reason, op.personId);
  insertDecisionFor(db, { runId, index, at, op, action: 'affinity', target: op.personId });
  counts.affinity += 1;
}

/** The live link of an account or participant to a person (or, for a participant, to an account), if any. */
function liveLinkOf(db, kind, id) {
  if (kind === 'account') {
    return (
      db
        .prepare(
          "SELECT id FROM account_person_links WHERE account_id = ? AND state IN ('proposed', 'verified') AND valid_to_at IS NULL LIMIT 1"
        )
        .get(id) ?? null
    );
  }
  return (
    db
      .prepare(
        "SELECT id FROM participant_links WHERE participant_id = ? AND state IN ('proposed', 'verified') AND valid_to_at IS NULL LIMIT 1"
      )
      .get(id) ?? null
  );
}

/** people:add in apply: a tentative person, its `proposed` link and a decision (see the head of this file). */
function applyPeopleAdd(db, op, state) {
  const { at, runId, index, counts } = state;
  const evidence = evidenceOf(db, op.sources);
  if (!evidence) return reject(db, state, 'people', op, 'unknown_source');
  if (!present(op.reason)) return reject(db, state, 'people', op, 'no_reason');
  if (op.subjectKind !== 'account' && op.subjectKind !== 'participant')
    return reject(db, state, 'people', op, 'bad_subject');
  const subject =
    op.subjectKind === 'account'
      ? db.prepare('SELECT id, person_id FROM accounts WHERE id = ? AND retired_at IS NULL').get(op.subjectId)
      : db.prepare('SELECT id, NULL AS person_id FROM participants WHERE id = ?').get(op.subjectId);
  if (!subject) {
    counts.missing += 1;
    return;
  }
  if (subject.person_id || liveLinkOf(db, op.subjectKind, op.subjectId))
    return reject(db, state, 'people', op, 'has_person');
  const person = newPersonId(state.uuid);
  db.prepare(
    "INSERT INTO people (id, kind, first_seen_at, last_seen_at, status, owner_file) VALUES (?, 'person', ?, ?, 'active', NULL)"
  ).run(person, at, at);
  projectRow(db, 'people', { id: person }, { at });
  let link;
  if (op.subjectKind === 'account') {
    link = linkId(op.subjectId, person);
    db.prepare(
      `INSERT INTO account_person_links (id, account_id, person_id, state, by, reason, evidence_id, valid_from_at, valid_to_at, recorded_at)
      VALUES (?, ?, ?, 'proposed', 'her', ?, ?, ?, NULL, ?)`
    ).run(link, op.subjectId, person, op.reason, op.sources[0], at, at);
    projectRow(db, 'account_person_links', { account_id: op.subjectId }, { at });
  } else {
    link = `plink:${op.subjectId}:${person}`;
    db.prepare(
      `INSERT INTO participant_links (id, participant_id, account_id, person_id, state, by, reason, evidence_id, valid_from_at, valid_to_at, recorded_at)
      VALUES (?, ?, NULL, ?, 'proposed', 'her', ?, ?, ?, NULL, ?)`
    ).run(link, op.subjectId, person, op.reason, op.sources[0], at, at);
    projectRow(db, 'participant_links', { participant_id: op.subjectId }, { at });
  }
  db.prepare(
    `INSERT OR REPLACE INTO decisions (id, at, by, target_kind, target_id, action, reason, extra, owner_file, position, retired_at)
     VALUES (?, ?, 'her', 'person', ?, 'people_add', ?, ?, NULL, NULL, NULL)`
  ).run(`dec:${runId}:${index}`, at, person, op.reason, json({ run: runId, op, link }));
  projectRow(db, 'decisions', { id: `dec:${runId}:${index}` }, { at });
  counts.people += 1;
}

const emptyCounts = () => ({
  proposed: 0,
  added: 0,
  confirmed: 0,
  revised: 0,
  retired: 0,
  episodes: 0,
  affinity: 0,
  flags: 0,
  missing: 0,
  rejected: 0,
  derived: 0,
  duplicate: 0,
  people: 0,
});

/** Throws unless `mode` is one the writer knows. */
function guard(update) {
  if (update.mode !== 'shadow' && update.mode !== 'apply') throw coded('BAD_MODE');
}

/** Applies one write on the writer connection; returns counts. */
export function applyMemoryWrite(handle, update) {
  const kind = /** @type {unknown} */ (update?.kind);
  if (kind === 'context') return writeContext(handle, update);
  if (kind === 'description') return writeDescription(handle, update);
  // Schema v11: the writers of wake runs, the skills registry and the index policy share this one writer path.
  if (kind === 'wake') return applyWakeWrite(handle, update);
  if (kind === 'skills') return applySkillsWrite(handle, update);
  if (kind === 'index-policy' || kind === 'touch' || kind === 'reembed') return applyIndexWrite(handle, update);
  if (kind === 'unit') return applyUnitWrite(handle, update);
  if (kind === 'publication') return applyPublicationWrite(handle, update);
  if (kind === 'backup') {
    return writeBackup(handle, {
      to: update.to,
      dataDir: update.dataDir,
      now: () => update.now ?? Date.now(),
      commit: update.commit ?? null,
      configHash: update.configHash ?? null,
    });
  }
  if (kind !== 'session') throw coded('BAD_UPDATE');
  const { mode, run, plan, advance, pending, now } = update;
  const at = iso(now ?? Date.now());
  return handle.transaction(() => {
    const { db } = handle;
    guard(update);
    if (run && mode === 'apply' && run.batchKey) {
      const first = db.prepare('SELECT result FROM session_runs WHERE batch_key = ? AND applied = 1').get(run.batchKey);
      if (first) {
        let result = {};
        try {
          result = first.result ? JSON.parse(first.result) : {};
        } catch {
          result = {};
        }
        return { ...result, replayed: true };
      }
    }
    const counts = emptyCounts();
    const answerSource =
      run && update.answer?.text
        ? insertAnswer(db, {
            id: otherSourceId('memory_session', run.id),
            kind: 'memory_session',
            text: update.answer.text,
            at,
            extra: { run: run.id },
          })
        : null;
    const applied = run != null && mode === 'apply' && plan != null && run.outcome === 'ok';
    if (run) insertRun(db, run, mode, { applied, answerSource, at });
    // What the request rendered (the read-set of the run), in the run's context.
    let contextId = '';
    if (run && update.context) contextId = insertContext(db, update.context) ?? '';
    if (run && Array.isArray(update.reads) && update.reads.length > 0) {
      writeTurnReadRows(
        db,
        run.id,
        String(update.readStep ?? 0),
        update.reads.map((row) => ({ ...row, context_id: contextId, reader_kind: 'session' }))
      );
    }
    if (plan && run) {
      const state = {
        at,
        runId: run.id,
        run,
        scope: run.scope,
        maxDelta: update.maxDelta,
        counts,
        index: 0,
        audienceColumn: update.audienceColumn === true,
        uuid: typeof update.uuid === 'function' ? update.uuid : randomUUID,
      };
      for (const group of ['claims', 'episodes', 'affinity', 'descriptions', 'people']) {
        for (const op of plan[group] ?? []) {
          state.index += 1;
          if (mode === 'shadow') {
            insertDecision(db, {
              id: `dec:${run.id}:${state.index}`,
              at,
              group,
              op,
              action: `proposed:${nameOf(group, op)}`,
              run,
            });
            counts.proposed += 1;
          } else if (group === 'claims') {
            applyClaim(db, op, state);
          } else if (group === 'episodes') {
            applyEpisode(db, op, state);
          } else if (group === 'affinity') {
            applyAffinity(db, op, state);
          } else if (group === 'people') {
            if (op.op === 'add') applyPeopleAdd(db, op, state);
            else reject(db, state, 'people', op, 'bad_op');
          } else {
            insertDecision(db, { id: `dec:${run.id}:${state.index}`, at, group, op, action: 'flag:description', run });
            counts.flags += 1;
          }
        }
      }
    }
    if (update.decision) {
      const { id, action, reason, extra, scope: target } = update.decision;
      db.prepare(
        `INSERT OR REPLACE INTO decisions (id, at, by, target_kind, target_id, action, reason, extra, owner_file, position, retired_at)
         VALUES (?, ?, 'engine', 'session_scope', ?, ?, ?, ?, NULL, NULL, NULL)`
      ).run(`dec:${id}`, at, target ?? run?.scopeKey ?? null, action, reason ?? null, json(extra ?? {}));
      projectRow(db, 'decisions', { id: `dec:${id}` }, { at });
    }
    if (advance) {
      // Compare-and-set: the cursor moves from the value the batch was read at, or nothing is written.
      const current = db.prepare('SELECT value FROM meta WHERE key = ?').get(advance.key)?.value ?? '0';
      if (String(current) !== String(advance.expect ?? 0)) throw coded('CURSOR_CONFLICT');
      db.prepare(SET_META).run(advance.key, String(advance.value));
    }
    if (pending) {
      if (pending.value === null || pending.value === undefined)
        db.prepare('DELETE FROM meta WHERE key = ?').run(pending.key);
      else db.prepare(SET_META).run(pending.key, String(pending.value));
    }
    if (applied) db.prepare('UPDATE session_runs SET result = ? WHERE id = ?').run(json(counts), run.id);
    return counts;
  });
}

/**
 * One reviewed description as a `description_versions` row. In shadow its origin is `shadow` and it is never the
 * current version; in apply the same transaction creates or moves the `descriptions` row to it.
 * `expectCurrent` is the version the review was based on; if another one has become current meanwhile, nothing is written.
 */
function writeDescription(handle, update) {
  const { row, subject, scope, answers } = update;
  const at = iso(update.now ?? Date.now());
  handle.transaction(() => {
    const { db } = handle;
    guard(update);
    const applying = update.mode === 'apply';
    if (applying) {
      const current =
        db.prepare('SELECT current_version FROM descriptions WHERE id = ?').get(row.descriptionId)?.current_version ??
        null;
      if (current !== (update.expectCurrent ?? null)) throw coded('VERSION_CONFLICT');
    }
    const extra = { ...(row.extra ?? {}) };
    if (Array.isArray(answers) && answers.length > 0) {
      extra.answers = answers.map((answer) => ({
        purpose: answer.purpose,
        source: insertAnswer(db, {
          id: otherSourceId('description_review', `${row.id}:${answer.purpose}`),
          kind: 'description_review',
          text: answer.text,
          at,
          extra: { description: row.descriptionId, purpose: answer.purpose },
        }),
      }));
    }
    db.prepare(
      `INSERT OR REPLACE INTO description_versions (id, description_id, text, author, written_at, chars, kept, removed, added, reason, origin, extra,
         owner_file, position, retired_at)
       VALUES (?, ?, ?, 'her', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`
    ).run(
      row.id,
      row.descriptionId,
      row.text,
      row.writtenAt,
      [...row.text].length,
      row.kept ?? null,
      row.removed ?? null,
      row.added ?? null,
      row.reason ?? null,
      applying ? 'review' : 'shadow',
      json(extra)
    );
    if (applying) {
      db.prepare(
        `INSERT INTO descriptions (id, subject_kind, subject_id, field, scope_kind, scope_iface, scope_dm, current_version, owner_file, audience_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET current_version = excluded.current_version`
      ).run(
        row.descriptionId,
        subject.kind,
        subject.id,
        subject.field,
        scope.scope_kind,
        scope.scope_iface,
        scope.scope_dm,
        row.id,
        audienceIdOf(db, scope, at)
      );
    }
    projectRow(db, 'description_versions', { description_id: row.descriptionId }, { at });
  });
  return { written: 1 };
}

const contextOk = (row) => row && typeof row.id === 'string' && row.id && typeof row.issued_at === 'string';

/** Records one issued context's row, inside the caller's transaction; returns its id (null for a malformed row). */
function insertContext(db, row) {
  if (!contextOk(row)) return null;
  if (row.iface) ensureInterface(db, row.iface);
  db.prepare(
    `INSERT OR IGNORE INTO execution_contexts (id, mode, iface, destination_place_id, partner_person_id, policy_version, issued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.mode,
    row.iface ?? null,
    row.destination_place_id ?? null,
    row.partner_person_id ?? null,
    row.policy_version ?? 1,
    row.issued_at
  );
  return row.id;
}

/**
 * Writes resolved read rows (service.js#turnReadRows) of one step, inside the caller's transaction: the one writer of
 * `turn_reads` (service.js#insertTurnReads wraps it in a transaction). A row's `context_id` is '' when no context was
 * issued, its `reader_kind` `turn` unless it says `session` or `wake`.
 */
export function writeTurnReadRows(db, turnId, step, rows) {
  const insert =
    db.prepare(`INSERT OR IGNORE INTO turn_reads (turn_id, step, context_id, row_kind, row_id, block, ord, version_id, revision, reader_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows) {
    const contextId = typeof row.context_id === 'string' ? row.context_id : '';
    const readerKind = ['turn', 'session', 'wake'].includes(row.reader_kind) ? row.reader_kind : 'turn';
    insert.run(
      String(turnId),
      String(step),
      contextId,
      row.row_kind,
      row.row_id,
      row.block ?? null,
      row.ord ?? null,
      row.version_id ?? null,
      row.revision ?? null,
      readerKind
    );
  }
}

/** One issued context as an `execution_contexts` row (scope.ts#contextRow); one already recorded is left alone. */
function writeContext(handle, update) {
  const row = update.context;
  if (!contextOk(row)) throw coded('BAD_CONTEXT');
  let written = 0;
  handle.transaction(() => {
    const { db } = handle;
    const before = db.prepare('SELECT 1 AS ok FROM execution_contexts WHERE id = ?').get(row.id);
    insertContext(db, row);
    written = before ? 0 : 1;
  });
  return { written };
}

/**
 * Merges person `from` into person `into` (schema v8; the writer of `people_merges`, no session op yet). One
 * transaction: a `people_merges` row (from, into, at, by, reason, evidence) and `from`'s `status` `merged_into:<into>`.
 * History is never rewritten: claims, links and audiences keep their rows (a merge cannot widen a DM audience: those
 * are per DM place). Refused, with a coded error: an unknown person (`UNKNOWN_PERSON`), one person (`SAME_PERSON`), her
 * own row (`SELF_PERSON`), a person already merged (`ALREADY_MERGED`), a merge whose target resolves back to `from`
 * (`MERGE_CYCLE`), no `by` (`BAD_MERGE`). Returns `{ id, survivor }`: the final survivor of the chain `into` starts.
 * @param {{ db: object, transaction: (fn: () => any) => any }} handle
 * @param {string} from
 * @param {string} into
 * @param {{ by: string, reason?: string, evidence?: any, now?: number }} opts
 */
export function mergePeople(handle, from, into, { by, reason = null, evidence = null, now } = {}) {
  if (!present(from) || !present(into) || !present(by)) throw coded('BAD_MERGE');
  if (from === into) throw coded('SAME_PERSON');
  if (from === SELF_PERSON || into === SELF_PERSON) throw coded('SELF_PERSON');
  const at = iso(now ?? Date.now());
  return handle.transaction(() => {
    const { db } = handle;
    const exists = db.prepare('SELECT 1 AS ok FROM people WHERE id = ?');
    if (!exists.get(from) || !exists.get(into)) throw coded('UNKNOWN_PERSON');
    if (db.prepare('SELECT 1 AS ok FROM people_merges WHERE from_person = ?').get(from)) throw coded('ALREADY_MERGED');
    const survivor = survivorOf(db, into);
    if (survivor === from) throw coded('MERGE_CYCLE');
    const id = `merge:${from}`;
    db.prepare(
      'INSERT INTO people_merges (id, from_person, into_person, at, by, reason, evidence) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, from, into, at, by, reason, evidence === null || evidence === undefined ? null : json(evidence));
    db.prepare('UPDATE people SET status = ? WHERE id = ?').run(`merged_into:${into}`, from);
    return { id, survivor };
  });
}
