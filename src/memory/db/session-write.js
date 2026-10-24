// The database writes of her memory session and description review (session.js, describe.js). They run on the
// writer connection: in the sync worker (sync-worker.js, message `memoryWrite`), or on the calling thread when there
// is no worker. This module imports nothing heavy, so the worker can load it.
//
// applyMemoryWrite(handle, update) -> counts
//   { kind: 'session', mode, run, plan, advance, maxDelta, now }
//       One transaction: the `session_runs` row of the request, the cursor (`advance`: a meta key and value), and
//       the plan the answer validated to.
//       - shadow: every op becomes one `decisions` row (`by` her, `action` `proposed:<op>`, the whole op in `extra`);
//         no claim, episode or attitude is touched.
//       - apply: claims (rows, versions, sources), episodes, attitude events and their effect on the score, and a
//         `decisions` row per op whose `action` is the op.
//   { kind: 'description', row }
//       One `description_versions` row with `origin` shadow, never current.
//
// A plan is the validated, resolved form of the answer: ids are database ids, never the request's `#n` / `cN`.
//   claims:       { op: 'add', subjectKind, subjectId, kind, text, how, sources, when }
//                 { op: 'confirm', id, sources } { op: 'revise', id, text, how, sources, reason }
//                 { op: 'retire', id, truth, reason, sources }
//   episodes:     { subjectId, what, feeling, sources }
//   affinity:     { personId, delta, reason, sources }
//   descriptions: { subjectKind, subjectId, field, why }
// Counts and codes only, never a text.

import { shortHash } from './ids.js';

const iso = (ms) => new Date(ms).toISOString();
const json = (value) => JSON.stringify(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

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

function insertRun(db, run, mode) {
  db.prepare(
    `INSERT OR REPLACE INTO session_runs (id, sweep_id, scope_key, scope_kind, scope_iface, scope_dm, mode, started_at, finished_at,
       cursor_from, cursor_to, sources_n, tokens_prompt, tokens_completion, model, outcome, counts, errors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.id, run.sweepId ?? null, run.scopeKey, run.scope?.scope_kind ?? null, run.scope?.scope_iface ?? null, run.scope?.scope_dm ?? null, mode,
    run.startedAt, run.finishedAt, run.cursorFrom ?? null, run.cursorTo ?? null, run.sourcesN ?? 0,
    run.tokensPrompt ?? null, run.tokensCompletion ?? null, run.model ?? null, run.outcome, json(run.counts ?? {}), json(run.errors ?? []),
  );
}

function insertDecision(db, { id, at, group, op, action, run }) {
  const target = targetOf(group, op);
  db.prepare(
    `INSERT OR REPLACE INTO decisions (id, at, by, target_kind, target_id, action, reason, extra, owner_file, position, retired_at)
     VALUES (?, ?, 'her', ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(id, at, target.kind, target.id, action, reasonOf(op), json({ run: run.id, scope: run.scope ?? null, op }));
}

function addSources(db, table, key, id, sources) {
  const insert = db.prepare(`INSERT INTO ${table} (${key}, source_id, position) VALUES (?, ?, ?)`);
  const have = new Set(db.prepare(`SELECT source_id FROM ${table} WHERE ${key} = ?`).all(id).map((row) => row.source_id));
  let position = have.size;
  for (const source of sources ?? []) {
    if (have.has(source)) continue;
    have.add(source);
    insert.run(id, source, position);
    position += 1;
  }
}

function version(db, { claimId, at, text, event, runId, index, extra = null }) {
  db.prepare(
    `INSERT OR REPLACE INTO claim_versions (id, claim_id, revision_id, text, extra, recorded_at, event, by, origin, owner_file, position, retired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'her', 'session', NULL, NULL, NULL)`,
  ).run(`cv:${claimId}:${shortHash(runId, index, event)}`, claimId, `rv:${shortHash(runId, index)}`, text, extra ? json(extra) : null, at, event);
}

function applyClaim(db, op, { at, runId, index, scope, counts }) {
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
  const claim = db.prepare('SELECT id, text FROM claims WHERE id = ? AND retired_at IS NULL').get(op.id);
  if (!claim) { counts.missing += 1; return; }
  if (op.op === 'confirm') {
    db.prepare('UPDATE claims SET last_seen_at = ? WHERE id = ?').run(at, op.id);
    addSources(db, 'claim_sources', 'claim_id', op.id, op.sources);
    version(db, { claimId: op.id, at, text: claim.text, event: 'confirm', runId, index });
    counts.confirmed += 1;
  } else if (op.op === 'revise') {
    db.prepare('UPDATE claims SET text = ?, how = ?, last_seen_at = ? WHERE id = ?').run(op.text, op.how, at, op.id);
    addSources(db, 'claim_sources', 'claim_id', op.id, op.sources);
    version(db, { claimId: op.id, at, text: op.text, event: 'revise', runId, index, extra: { before: claim.text, reason: op.reason ?? null } });
    counts.revised += 1;
  } else {
    // Disputed stays shown beside the claim it contradicts; historical and retired leave the shown set (still findable).
    const shown = op.truth === 'disputed' ? 1 : 0;
    const validTo = op.truth === 'disputed' ? null : at;
    db.prepare('UPDATE claims SET truth = ?, shown = ?, valid_to = COALESCE(?, valid_to) WHERE id = ?').run(op.truth, shown, validTo, op.id);
    addSources(db, 'claim_sources', 'claim_id', op.id, op.sources);
    version(db, { claimId: op.id, at, text: claim.text, event: 'retire', runId, index, extra: { truth: op.truth, reason: op.reason ?? null } });
    counts.retired += 1;
  }
  insertDecisionFor(db, { runId, index, at, op, action: op.op, target: op.id });
}

function insertDecisionFor(db, { runId, index, at, op, action, target }) {
  db.prepare(
    `INSERT OR REPLACE INTO decisions (id, at, by, target_kind, target_id, action, reason, extra, owner_file, position, retired_at)
     VALUES (?, ?, 'her', ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(`dec:${runId}:${index}`, at, action === 'episode' ? 'episode' : action === 'affinity' ? 'person' : 'claim', target, action, reasonOf(op), json({ run: runId, op }));
}

function applyEpisode(db, op, { at, runId, index, scope, counts }) {
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

function applyAffinity(db, op, { at, runId, index, scope, maxDelta, counts }) {
  const person = db.prepare('SELECT affinity FROM people WHERE id = ? AND retired_at IS NULL').get(op.personId);
  if (!person) { counts.missing += 1; return; }
  const before = Number.isFinite(person.affinity) ? person.affinity : 0;
  const cap = Number.isFinite(maxDelta) ? Math.abs(maxDelta) : Infinity;
  const applied = clamp(op.delta, -cap, cap);
  const score = Math.round(clamp(before + applied, -100, 100) * 100) / 100;
  db.prepare(
    `INSERT OR REPLACE INTO affinity_events (id, person_id, at, delta, applied, score, reason, scope_kind, scope_iface, scope_dm, extra, owner_file, position, retired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(`aff:${runId}:${index}`, op.personId, at, op.delta, applied, score, op.reason ?? null, scope.scope_kind, scope.scope_iface, scope.scope_dm, json({ run: runId, sources: op.sources }));
  db.prepare('UPDATE people SET affinity = ?, affinity_reason = ? WHERE id = ?').run(score, op.reason ?? null, op.personId);
  insertDecisionFor(db, { runId, index, at, op, action: 'affinity', target: op.personId });
  counts.affinity += 1;
}

/** Applies one write on the writer connection; returns counts. */
export function applyMemoryWrite(handle, update) {
  if (update?.kind === 'description') return writeDescription(handle, update.row);
  const { mode, run, plan, advance, now } = update;
  const at = iso(now ?? Date.now());
  const counts = { proposed: 0, added: 0, confirmed: 0, revised: 0, retired: 0, episodes: 0, affinity: 0, flags: 0, missing: 0 };
  handle.transaction(() => {
    const { db } = handle;
    insertRun(db, run, mode);
    if (plan) {
      let index = 0;
      for (const group of ['claims', 'episodes', 'affinity', 'descriptions']) {
        for (const op of plan[group] ?? []) {
          index += 1;
          if (mode === 'shadow') {
            insertDecision(db, { id: `dec:${run.id}:${index}`, at, group, op, action: `proposed:${nameOf(group, op)}`, run });
            counts.proposed += 1;
          } else if (group === 'claims') {
            applyClaim(db, op, { at, runId: run.id, index, scope: run.scope, counts });
          } else if (group === 'episodes') {
            applyEpisode(db, op, { at, runId: run.id, index, scope: run.scope, counts });
          } else if (group === 'affinity') {
            applyAffinity(db, op, { at, runId: run.id, index, scope: run.scope, maxDelta: update.maxDelta, counts });
          } else {
            insertDecision(db, { id: `dec:${run.id}:${index}`, at, group, op, action: 'flag:description', run });
            counts.flags += 1;
          }
        }
      }
    }
    if (advance) db.prepare(SET_META).run(advance.key, String(advance.value));
  });
  return counts;
}

/** One reviewed description as a `description_versions` row with origin shadow (never the current version). */
function writeDescription(handle, row) {
  handle.transaction(() => {
    handle.db.prepare(
      `INSERT OR REPLACE INTO description_versions (id, description_id, text, author, written_at, chars, kept, removed, added, reason, origin, extra,
         owner_file, position, retired_at)
       VALUES (?, ?, ?, 'her', ?, ?, ?, ?, ?, ?, 'shadow', ?, NULL, NULL, NULL)`,
    ).run(row.id, row.descriptionId, row.text, row.writtenAt, [...row.text].length, row.kept ?? null, row.removed ?? null, row.added ?? null, row.reason ?? null, json(row.extra ?? {}));
  });
  return { written: 1 };
}
