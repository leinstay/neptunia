// The database writes of her memory session and description review (session.js, describe.js). They run on the
// writer connection: in the sync worker (sync-worker.js, message `memoryWrite`), or on the calling thread when there
// is no worker. This module imports nothing heavy, so the worker can load it.
//
// applyMemoryWrite(handle, update) -> counts
//   { kind: 'session', mode, authority, run, plan, advance, pending, decision, answer, maxDelta, now }
//       `run` may be null for a write that only moves the cursor, the pending mark or records a `decision`.
//       One transaction: the `session_runs` row of the request, her whole answer as a `sources` row (kind
//       `memory_session`, scope internal), the cursor (`advance`: a meta key, the value, and the value it must still
//       have: a compare-and-set), the pending-batch mark (`pending`: a meta key and a value, or null to clear it), and
//       the plan the answer validated to. Any failure rolls the whole thing back: a cursor never moves without its writes.
//       - `mode` is `shadow` or `apply`; any other mode is refused (`BAD_MODE`). `apply` also needs `authority` `db`
//         (`APPLY_JSON_WRITER` otherwise): the caller (service.js) stamps it from the live config, the read switch alone
//         never unlocks a write.
//       - shadow: every op becomes one `decisions` row (`by` her, `action` `proposed:<op>`, the whole op in `extra`);
//         no claim, episode or attitude is touched.
//       - apply: claims (rows, versions, sources), episodes, attitude events and their effect on the score, and a
//         `decisions` row per op whose `action` is the op. A run is applied once: a second write of the same batch
//         (`run.batchKey`) returns the first result with `replayed: true` and changes nothing. An op whose declared
//         sources do not all resolve, whose reason is missing or whose target is outside the run's scope is rejected whole
//         (a `decisions` row `rejected:<why>`). A claim's scope is the narrowest scope of the run and of the NEW
//         sources; when it differs from the target claim's scope, the change is written as a new claim of that scope
//         and the old claim stays as it was.
//   { kind: 'description', mode, authority, row, subject, scope, expectCurrent, answers, now }
//       One `description_versions` row. `shadow`: origin `shadow`, never current. `apply` (authority `db`): origin
//       `review`, and in the same transaction the `descriptions` row is created or moved to this version.
//
// A plan is the validated, resolved form of the answer: ids are database ids, never the request's `#n` / `cN`.
//   claims:       { op: 'add', subjectKind, subjectId, kind, text, how, sources, when }
//                 { op: 'confirm', id, sources } { op: 'revise', id, text, how, sources, reason }
//                 { op: 'retire', id, truth, reason, sources }
//   episodes:     { subjectId, what, feeling, sources }
//   affinity:     { personId, delta, reason, sources }
//   descriptions: { subjectKind, subjectId, field, why }
// Counts and codes only, never a text.

import { otherSourceId, shortHash } from './ids.js';
import { allowed, dmContext, groupContext, internalContext, narrowest, SCOPE_INTERNAL } from './scope.js';

const iso = (ms) => new Date(ms).toISOString();
const json = (value) => JSON.stringify(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const coded = (code) => Object.assign(new Error(code), { code });
const present = (value) => typeof value === 'string' && value.trim() !== '';

const SET_META = 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';

/** The target of a proposed op, for its `decisions` row. */
function targetOf(group, op) {
  switch (group) {
    case 'claims': return op.op === 'add' ? { kind: 'claim', id: null } : { kind: 'claim', id: op.id };
    case 'episodes': return { kind: 'episode', id: null };
    case 'affinity': return { kind: 'person', id: op.personId };
    default: return { kind: 'description', id: `desc:${op.subjectId}:${op.field}` };
  }
}

const nameOf = (group, op) => (group === 'claims' ? op.op : group === 'descriptions' ? 'description' : group === 'episodes' ? 'episode' : 'affinity');
const reasonOf = (op) => (typeof op.reason === 'string' && op.reason ? op.reason : typeof op.why === 'string' && op.why ? op.why : null);

const scopeOfRow = (row) => ({ scope_kind: row.scope_kind ?? null, scope_iface: row.scope_iface ?? null, scope_dm: row.scope_dm ?? null });
const sameScope = (a, b) => (a.scope_kind ?? null) === (b.scope_kind ?? null) && (a.scope_iface ?? null) === (b.scope_iface ?? null) && (a.scope_dm ?? null) === (b.scope_dm ?? null);
function contextOf(scope) {
  if (scope?.scope_kind === 'group' && scope.scope_iface) return groupContext(scope.scope_iface);
  if (scope?.scope_kind === 'dm' && scope.scope_iface && scope.scope_dm) return dmContext(scope.scope_dm, scope.scope_iface);
  return internalContext();
}

function insertRun(db, run, mode, { applied, answerSource }) {
  db.prepare(
    `INSERT OR REPLACE INTO session_runs (id, sweep_id, scope_key, scope_kind, scope_iface, scope_dm, mode, started_at, finished_at,
       cursor_from, cursor_to, sources_n, tokens_prompt, tokens_completion, model, outcome, counts, errors, batch_key, applied, result, answer_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    run.id, run.sweepId ?? null, run.scopeKey, run.scope?.scope_kind ?? null, run.scope?.scope_iface ?? null, run.scope?.scope_dm ?? null, mode,
    run.startedAt, run.finishedAt, run.cursorFrom ?? null, run.cursorTo ?? null, run.sourcesN ?? 0,
    run.tokensPrompt ?? null, run.tokensCompletion ?? null, run.model ?? null, run.outcome, json(run.counts ?? {}), json(run.errors ?? []),
    run.batchKey ?? null, applied ? 1 : 0, answerSource ?? null,
  );
}

function insertDecision(db, { id, at, group, op, action, run }) {
  const target = targetOf(group, op);
  db.prepare(
    `INSERT OR REPLACE INTO decisions (id, at, by, target_kind, target_id, action, reason, extra, owner_file, position, retired_at)
     VALUES (?, ?, 'her', ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(id, at, target.kind, target.id, action, reasonOf(op), json({ run: run.id, scope: run.scope ?? null, op }));
}

/** Her whole answer as a `sources` row of kind `kind`, scope internal; the thinking is kept in `think` as well. */
function insertAnswer(db, { id, kind, text, at, extra }) {
  const thought = [...String(text).matchAll(/<think>([\s\S]*?)<\/think>/gi)].map((match) => match[1].trim()).filter(Boolean).join('\n\n');
  db.prepare(
    `INSERT OR REPLACE INTO sources (id, kind, iface, native_id, revision, place_id, author_account, reply_to, occurred_at, recorded_at, seen_at, text, stems,
       media, mentions, direct, turn_id, op_id, think, extra, scope_kind, scope_iface, scope_dm, origin, owner_file, position)
     VALUES (?, ?, NULL, ?, 1, NULL, NULL, NULL, ?, ?, NULL, ?, NULL, NULL, NULL, 0, NULL, NULL, ?, ?, ?, ?, ?, 'memory', NULL, NULL)`,
  ).run(id, kind, id, at, at, String(text), thought || null, extra ? json(extra) : null, SCOPE_INTERNAL.scope_kind, SCOPE_INTERNAL.scope_iface, SCOPE_INTERNAL.scope_dm);
  return id;
}

/** The live links of a claim or an episode; a retired link is not a link. Links the database writes leave `owner_file` null. */
function addSources(db, table, key, id, sources) {
  const insert = db.prepare(`INSERT INTO ${table} (${key}, source_id, position) VALUES (?, ?, ?)`);
  const have = new Set(db.prepare(`SELECT source_id FROM ${table} WHERE ${key} = ? AND retired_at IS NULL`).all(id).map((row) => row.source_id));
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
  const find = db.prepare('SELECT id, scope_kind, scope_iface, scope_dm FROM sources WHERE id = ? AND retired_at IS NULL');
  const rows = [];
  for (const id of ids) {
    const row = typeof id === 'string' ? find.get(id) : undefined;
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}

function version(db, { claimId, at, text, event, runId, index, extra = null }) {
  db.prepare(
    `INSERT OR REPLACE INTO claim_versions (id, claim_id, revision_id, text, extra, recorded_at, event, by, origin, owner_file, position, retired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'her', 'session', NULL, NULL, NULL)`,
  ).run(`cv:${claimId}:${shortHash(runId, index, event)}`, claimId, `rv:${shortHash(runId, index)}`, text, extra ? json(extra) : null, at, event);
}

function insertDecisionFor(db, { runId, index, at, op, action, target }) {
  db.prepare(
    `INSERT OR REPLACE INTO decisions (id, at, by, target_kind, target_id, action, reason, extra, owner_file, position, retired_at)
     VALUES (?, ?, 'her', ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(`dec:${runId}:${index}`, at, action === 'episode' ? 'episode' : action === 'affinity' ? 'person' : 'claim', target, action, reasonOf(op), json({ run: runId, op }));
}

function reject(db, state, group, op, why) {
  state.counts.rejected += 1;
  insertDecision(db, { id: `dec:${state.runId}:${state.index}`, at: state.at, group, op, action: `rejected:${why}`, run: state.run });
}

/** A claim of the scope `scope` made from `claim` (the old claim stays as it was); returns its id. */
function deriveClaim(db, claim, scope, { at, runId, index, text, how, truth, shown }) {
  const id = `clm:${shortHash(runId, index, 'derived', claim.id)}`;
  let extra = {};
  try { extra = claim.extra ? JSON.parse(claim.extra) : {}; } catch { extra = {}; }
  db.prepare(
    `INSERT OR REPLACE INTO claims (id, subject_kind, subject_id, kind, text, extra, weight, first_seen_at, last_seen_at, valid_to, superseded_by,
       how, author, from_person, truth, shown, scope_kind, scope_iface, scope_dm, created_at, retired_at, origin_file, owner_file, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'her', NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
  ).run(id, claim.subject_kind, claim.subject_id, claim.kind, text ?? claim.text, json({ ...extra, derivedFrom: claim.id }), claim.weight ?? null, at, at,
    how ?? claim.how, truth ?? claim.truth, shown ?? claim.shown, scope.scope_kind, scope.scope_iface, scope.scope_dm, at);
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
         how, author, from_person, truth, shown, scope_kind, scope_iface, scope_dm, created_at, retired_at, origin_file, owner_file, position)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, 'her', NULL, 'current', 1, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
    ).run(id, op.subjectKind, op.subjectId, op.kind, op.text, op.when ? json({ when: op.when }) : null, at, at, op.how, scope.scope_kind, scope.scope_iface, scope.scope_dm, at);
    addSources(db, 'claim_sources', 'claim_id', id, op.sources);
    version(db, { claimId: id, at, text: op.text, event: 'add', runId, index });
    insertDecisionFor(db, { runId, index, at, op, action: 'add', target: id });
    counts.added += 1;
    return;
  }
  const claim = db.prepare('SELECT * FROM claims WHERE id = ? AND retired_at IS NULL').get(op.id);
  if (!claim) { counts.missing += 1; return; }
  if (!allowed(claim, contextOf(state.scope))) return reject(db, state, 'claims', op, 'out_of_scope');
  if ((op.op === 'revise' || op.op === 'retire') && !present(op.reason)) return reject(db, state, 'claims', op, 'no_reason');
  const derived = !sameScope(scope, scopeOfRow(claim));
  let target = op.id;
  if (op.op === 'confirm') {
    if (derived) target = deriveClaim(db, claim, scope, { at, runId, index });
    else db.prepare('UPDATE claims SET last_seen_at = ? WHERE id = ?').run(at, op.id);
    addSources(db, 'claim_sources', 'claim_id', target, op.sources);
    version(db, { claimId: target, at, text: claim.text, event: 'confirm', runId, index });
    counts.confirmed += 1;
  } else if (op.op === 'revise') {
    if (derived) target = deriveClaim(db, claim, scope, { at, runId, index, text: op.text, how: op.how });
    else db.prepare('UPDATE claims SET text = ?, how = ?, last_seen_at = ? WHERE id = ?').run(op.text, op.how, at, op.id);
    addSources(db, 'claim_sources', 'claim_id', target, op.sources);
    version(db, { claimId: target, at, text: op.text, event: 'revise', runId, index, extra: { before: claim.text, reason: op.reason } });
    counts.revised += 1;
  } else {
    // Disputed stays shown beside the claim it contradicts; historical and retired leave the shown set (still findable).
    const shown = op.truth === 'disputed' ? 1 : 0;
    const validTo = op.truth === 'disputed' ? null : at;
    if (derived) {
      target = deriveClaim(db, claim, scope, { at, runId, index, truth: op.truth, shown });
      if (validTo) db.prepare('UPDATE claims SET valid_to = ? WHERE id = ?').run(validTo, target);
    } else {
      db.prepare('UPDATE claims SET truth = ?, shown = ?, valid_to = COALESCE(?, valid_to) WHERE id = ?').run(op.truth, shown, validTo, op.id);
    }
    addSources(db, 'claim_sources', 'claim_id', target, op.sources);
    version(db, { claimId: target, at, text: claim.text, event: 'retire', runId, index, extra: { truth: op.truth, reason: op.reason } });
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
       start_ms, last_ms, extra, scope_kind, scope_iface, scope_dm, created_at, retired_at, owner_file, position)
     VALUES (?, 'session', ?, NULL, ?, ?, NULL, ?, ?, NULL, NULL, NULL, 'open', NULL, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(id, op.subjectId, at.slice(0, 10), op.what, op.feeling || null, op.feeling ? at : null, scope.scope_kind, scope.scope_iface, scope.scope_dm, at);
  addSources(db, 'episode_sources', 'episode_id', id, op.sources);
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
  if (!person) { counts.missing += 1; return; }
  const eventId = `aff:${runId}:${index}`;
  // A second application of the same event is never a second delta.
  if (db.prepare('SELECT 1 AS ok FROM affinity_events WHERE id = ?').get(eventId)) { counts.duplicate += 1; return; }
  const before = Number.isFinite(person.affinity) ? person.affinity : 0;
  const cap = Number.isFinite(state.maxDelta) ? Math.abs(state.maxDelta) : Infinity;
  const applied = clamp(op.delta, -cap, cap);
  const score = Math.round(clamp(before + applied, -100, 100) * 100) / 100;
  db.prepare(
    `INSERT INTO affinity_events (id, person_id, at, delta, applied, score, reason, scope_kind, scope_iface, scope_dm, extra, owner_file, position, retired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(eventId, op.personId, at, op.delta, applied, score, op.reason, scope.scope_kind, scope.scope_iface, scope.scope_dm, json({ run: runId, sources: op.sources }));
  db.prepare('UPDATE people SET affinity = ?, affinity_reason = ? WHERE id = ?').run(score, op.reason, op.personId);
  insertDecisionFor(db, { runId, index, at, op, action: 'affinity', target: op.personId });
  counts.affinity += 1;
}

const emptyCounts = () => ({ proposed: 0, added: 0, confirmed: 0, revised: 0, retired: 0, episodes: 0, affinity: 0, flags: 0, missing: 0, rejected: 0, derived: 0, duplicate: 0 });

/** Throws unless `mode` is one the writer knows, and `apply` has the database as the writer. */
function guard(update) {
  if (update.mode !== 'shadow' && update.mode !== 'apply') throw coded('BAD_MODE');
  if (update.mode === 'apply' && update.authority !== 'db') throw coded('APPLY_JSON_WRITER');
}

/** Applies one write on the writer connection; returns counts. */
export function applyMemoryWrite(handle, update) {
  if (update?.kind === 'description') return writeDescription(handle, update);
  if (update?.kind !== 'session') throw coded('BAD_UPDATE');
  const { mode, run, plan, advance, pending, now } = update;
  const at = iso(now ?? Date.now());
  return handle.transaction(() => {
    const { db } = handle;
    guard(update);
    if (run && mode === 'apply' && run.batchKey) {
      const first = db.prepare('SELECT result FROM session_runs WHERE batch_key = ? AND applied = 1').get(run.batchKey);
      if (first) {
        let result = {};
        try { result = first.result ? JSON.parse(first.result) : {}; } catch { result = {}; }
        return { ...result, replayed: true };
      }
    }
    const counts = emptyCounts();
    const answerSource = run && update.answer?.text
      ? insertAnswer(db, { id: otherSourceId('memory_session', run.id), kind: 'memory_session', text: update.answer.text, at, extra: { run: run.id } })
      : null;
    const applied = run != null && mode === 'apply' && plan != null && run.outcome === 'ok';
    if (run) insertRun(db, run, mode, { applied, answerSource });
    if (plan && run) {
      const state = { at, runId: run.id, run, scope: run.scope, maxDelta: update.maxDelta, counts, index: 0 };
      for (const group of ['claims', 'episodes', 'affinity', 'descriptions']) {
        for (const op of plan[group] ?? []) {
          state.index += 1;
          if (mode === 'shadow') {
            insertDecision(db, { id: `dec:${run.id}:${state.index}`, at, group, op, action: `proposed:${nameOf(group, op)}`, run });
            counts.proposed += 1;
          } else if (group === 'claims') {
            applyClaim(db, op, state);
          } else if (group === 'episodes') {
            applyEpisode(db, op, state);
          } else if (group === 'affinity') {
            applyAffinity(db, op, state);
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
         VALUES (?, ?, 'engine', 'session_scope', ?, ?, ?, ?, NULL, NULL, NULL)`,
      ).run(`dec:${id}`, at, target ?? run?.scopeKey ?? null, action, reason ?? null, json(extra ?? {}));
    }
    if (advance) {
      // Compare-and-set: the cursor moves from the value the batch was read at, or nothing is written.
      const current = db.prepare('SELECT value FROM meta WHERE key = ?').get(advance.key)?.value ?? '0';
      if (String(current) !== String(advance.expect ?? 0)) throw coded('CURSOR_CONFLICT');
      db.prepare(SET_META).run(advance.key, String(advance.value));
    }
    if (pending) {
      if (pending.value === null || pending.value === undefined) db.prepare('DELETE FROM meta WHERE key = ?').run(pending.key);
      else db.prepare(SET_META).run(pending.key, String(pending.value));
    }
    if (applied) db.prepare('UPDATE session_runs SET result = ? WHERE id = ?').run(json(counts), run.id);
    return counts;
  });
}

/**
 * One reviewed description as a `description_versions` row. In shadow its origin is `shadow` and it is never the
 * current version; in apply (authority `db`) the same transaction creates or moves the `descriptions` row to it.
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
      const current = db.prepare('SELECT current_version FROM descriptions WHERE id = ?').get(row.descriptionId)?.current_version ?? null;
      if (current !== (update.expectCurrent ?? null)) throw coded('VERSION_CONFLICT');
    }
    const extra = { ...(row.extra ?? {}) };
    if (Array.isArray(answers) && answers.length > 0) {
      extra.answers = answers.map((answer) => ({
        purpose: answer.purpose,
        source: insertAnswer(db, { id: otherSourceId('description_review', `${row.id}:${answer.purpose}`), kind: 'description_review', text: answer.text, at, extra: { description: row.descriptionId, purpose: answer.purpose } }),
      }));
    }
    db.prepare(
      `INSERT OR REPLACE INTO description_versions (id, description_id, text, author, written_at, chars, kept, removed, added, reason, origin, extra,
         owner_file, position, retired_at)
       VALUES (?, ?, ?, 'her', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    ).run(row.id, row.descriptionId, row.text, row.writtenAt, [...row.text].length, row.kept ?? null, row.removed ?? null, row.added ?? null, row.reason ?? null, applying ? 'review' : 'shadow', json(extra));
    if (applying) {
      db.prepare(
        `INSERT INTO descriptions (id, subject_kind, subject_id, field, scope_kind, scope_iface, scope_dm, current_version, owner_file)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET current_version = excluded.current_version`,
      ).run(row.descriptionId, subject.kind, subject.id, subject.field, scope.scope_kind, scope.scope_iface, scope.scope_dm, row.id);
    }
  });
  return { written: 1 };
}
