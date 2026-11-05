// The database writes of her memory session and description review (session.ts, describe.ts). They run on the
// writer connection: in the writer worker (writer-worker.ts, message `memoryWrite`), or on the calling thread when there
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
//         and the old claim stays as it was. A confirm, revise or retire of a claim a file owns takes the claim over
//         (`owner_key` null, its `co_owners` rows gone): the unit sync never writes it again (upsert.ts), and the
//         profile shows it as the session left it (session-rows.ts). A file read before an attitude move never
//         writes over the move.
//   { kind: 'description', mode, row, subject, scope, expectCurrent, answers, now }
//       One `description_versions` row. `shadow`: origin `shadow`, never current. `apply`: origin
//       `review`, and in the same transaction the `descriptions` row is created or moved to this version.
//   { kind: 'context', context }
//       One `execution_contexts` row (scope.ts#contextRow of a context the core issued); a context already recorded is
//       left as it is. Not a memory write: no mode.
//   { kind: 'wake', op, ... } | { kind: 'skills', op, ... } | { kind: 'index-policy' | 'touch' | 'reembed', ... }
//       Schema v11: handed to wakes.ts#applyWakeWrite, skills.ts#applySkillsWrite and index-policy.ts#applyIndexWrite.
//       Bookkeeping of the database itself, not her memory: no mode.
//   { kind: 'publication', op: 'prepare' | 'sent' | 'failed' | 'unknown', ... }
//       The diary's mirrors (src/behavior/mirror.ts), handed to publish.ts#applyPublicationWrite; the claim and the
//       segments of a send (`claim`, `segment`, `settle` and the rest) to publication-delivery.ts#applyDeliveryWrite.
//   { kind: 'mirror', op: 'add' | 'configure' | 'remove' | 'slot' | 'complete', ... }
//       The owner's configuration of the mirrors, handed to mirror-config.ts#applyMirrorWrite.
//   { kind: 'entry-media', id, items, dataDir }
//       A diary entry's pictures and voice file, kept as files and `media` rows (diary-media.ts#applyEntryMedia).
//   { kind: 'unit', op, ... }
//       The memory units (record and journal lines, the store's cache, the module stores, participation, the diary,
//       the vectors) and the projection the writers finish, handed to unit-write.ts#applyUnitWrite.
//   { kind: 'backup', to, dataDir, now, commit, configHash }
//       The daily backup (backup.ts#writeBackup) taken on this connection, the writer's, by `VACUUM INTO`:
//       a consistent copy, no WAL file copied. Not a memory write: no mode; returns the manifest.
//
// Every row with the scope triple is written with its `audience_id` from the one resolver (scope.ts#audienceOf, through
// rows.ts), and her answer rows with their authority, author kind and `observed_at`. `update.audienceColumn` (stamped
// by the service) makes the scope check of a target claim read `audience_id`.
//
// A plan is the validated, resolved form of the answer: ids are database ids, never the request's `#n` / `cN`.
//   claims:       { op: 'add', subjectKind, subjectId, kind, text, how, sources, when }
//                 { op: 'confirm', id, sources } { op: 'revise', id, text, how, sources, reason }
//                 { op: 'retire', id, truth, reason, sources }
//   episodes:     { subjectId, what, feeling, sources }
//   affinity:     { personId, delta, reason, sources }
//   descriptions: { subjectKind, subjectId, field, why }
//   entities:     { handle, kind, name, language, sources }   (schema v31; semantic-write.ts#writeSessionEntity)
//   assertions:   { predicate, assertionKind, text, arguments, polarity, how, state, sources, dependencies }   (schema v31)
//                 An argument's `ref` is a typed reference or `{ handle }`, a new entity of this answer. An op the writer
//                 refuses is a `decisions` row `rejected:<code>`, and an assertion naming a refused entity is `unknown_ref`.
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
//   - a confirm, revise or retire op may carry `base`, the claim version the session read (session.ts fills it from the
//     request, never from her answer); when the claim's newest version is no longer `base`, the op is rejected whole as
//     `rejected:stale_base` (a `decisions` row). An op without `base` is not checked (a caller that read no version);
//     `base: null` says the session read the claim with no version, and a version written since makes it stale;
//   - `update.reads` (the rows `service.ts#turnReadRows` resolved when the request was assembled) are written to
//     `turn_reads` in the same transaction, `reader_kind` `session`, `turn_id` the run id, `step` `update.readStep` (the
//     page), `context_id` the run's context (`update.context`, an issued context's row, recorded in
//     `execution_contexts` the same way);
//   - every row written here is projected into the graph in the same transaction (graph.ts#projectRow).
//   { kind: 'semantic-embedding', documentKey, model, vector, now }
//       One embedding of a semantic search document (semantic-search.ts#applySemanticEmbedding).
//   { kind: 'semantic', resolved, now, uuid?, runId? }
//       One resolved entity or assertion from another thread (semantic-write.ts): checked again here, because a message
//       carries anything, and a base that moved since it was resolved answers `{ ok: false, code: 'stale_base' }`.
// Schema v31: every new claim version the session writes is sealed by its `semantic_assertion_versions` snapshot (`text`,
// polarity `unknown`), with the audience the meet of the run and its sources on audience ids.
// Counts and codes only, never a text.

import { applyPersonLinkWrite } from './person-links.ts';
import { applyRequestArchiveWrite, sessionRequestId, setRequestOutcome } from './request-archive.ts';
import { randomUUID } from 'node:crypto';
import { ownershipSql } from './storage-units.ts';

import { CORE_AUTHORITY, SELF_PERSON, linkId, newPersonId, otherSourceId, shortHash, survivorOf } from './ids.ts';
import {
  audienceOf,
  audienceParts,
  canRead,
  dmContext,
  groupContext,
  internalContext,
  isOpaquePerson,
  narrowestAudience,
  scopeOfAudience,
  SCOPE_INTERNAL,
} from './scope.ts';
import { NEWEST_CLAIM_VERSION_SQL, ensureAudience, ensureInterface, newestClaimVersion } from './rows.ts';
import { applySemanticEmbedding } from './semantic-search.ts';
import { applySemanticMessage, writeSessionAssertion, writeSessionEntity } from './semantic-write.ts';
import type { SessionSemantics } from './semantic-write.ts';
import { projectRow } from './graph.ts';
import { applyWakeWrite } from './wakes.ts';
import { applySkillsWrite } from './skills.ts';
import { applyIndexWrite } from './index-policy.ts';
import { applyUnitWrite } from './unit-write.ts';
import { applyPublicationWrite } from './publish.ts';
import { applyDeliveryWrite, isDeliveryOp } from './publication-delivery.ts';
import { applyMirrorWrite } from './mirror-config.ts';
import { applyEntryMedia } from './diary-media.ts';
import { writeBackup } from './backup.ts';
import { applyIngestWrite } from './ingest.ts';
import { applyWakeQueueWrite } from './wake-queue.ts';
import { applyBoardWrite } from '../../board/writer.ts';
import { takeOverClaim } from './session-rows.ts';
import { asText, dbOf, isFiniteNumber } from './types.ts';
import type { Db, MemoryHandle, Row } from './types.ts';
import type { Context, Scope } from './scope.ts';

export { NEWEST_CLAIM_VERSION_SQL, newestClaimVersion };
const hasTable = (db: Db, name: string): boolean =>
  db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

const iso = (ms: number): string => new Date(ms).toISOString();
const json = (value: unknown): string => JSON.stringify(value);
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const present = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** The counts a session write returns, by what it did. */
type Counts = Record<string, number>;

/** What the ops of one run share: the run and its scope, the clock, the counts and the position of the op. */
type WriteState = {
  at: string;
  runId: string;
  run: SessionRunRow;
  scope: Scope;
  maxDelta: unknown;
  counts: Counts;
  index: number;
  audienceColumn: boolean;
  uuid: () => string;
  /** The audience the run reads and writes under: the DM place of an opaque partner, which the triple cannot spell. */
  audience: string;
  semantics: SessionSemantics;
};

/** The run a session write records (see `insertRun`). */
type SessionRunRow = {
  id: string;
  sweepId?: string | null;
  scopeKey?: string;
  scope?: Scope | null;
  audienceId?: string | null;
  batchKey?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
  cursorFrom?: unknown;
  cursorTo?: unknown;
  sourcesN?: number;
  tokensPrompt?: number | null;
  tokensCompletion?: number | null;
  model?: string | null;
  outcome?: unknown;
  counts?: unknown;
  errors?: unknown;
};

const SET_META = 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';

/** The target of a proposed op, for its `decisions` row. */
function targetOf(group: unknown, op: Row): { kind: unknown; id: unknown } {
  switch (group) {
    case 'claims':
      return op.op === 'add' ? { kind: 'claim', id: null } : { kind: 'claim', id: op.id };
    case 'episodes':
      return { kind: 'episode', id: null };
    case 'affinity':
      return { kind: 'person', id: op.personId };
    case 'people':
      return { kind: op.subjectKind, id: op.subjectId };
    case 'entities':
      return { kind: 'semantic_entity', id: null };
    case 'assertions':
      return { kind: 'claim', id: null };
    default:
      return { kind: 'description', id: `desc:${asText(op.subjectId)}:${asText(op.field)}` };
  }
}

const GROUP_OPS: Record<string, string> = {
  descriptions: 'description',
  episodes: 'episode',
  affinity: 'affinity',
  entities: 'entity',
  assertions: 'assertion',
};
const nameOf = (group: unknown, op: Row): unknown =>
  group === 'claims' ? op.op : group === 'people' ? `people_${asText(op.op)}` : GROUP_OPS[asText(group)];
const reasonOf = (op: unknown): string | null =>
  typeof (op as Row).reason === 'string' && (op as Row).reason
    ? ((op as Row).reason as string)
    : typeof (op as Row).why === 'string' && (op as Row).why
      ? ((op as Row).why as string)
      : null;

const scopeOfRow = (row: Row): Scope => ({
  scope_kind: (row.scope_kind as string | null | undefined) ?? null,
  scope_iface: (row.scope_iface as string | null | undefined) ?? null,
  scope_dm: (row.scope_dm as string | null | undefined) ?? null,
});
function contextOf(scope: Scope | null | undefined, audienceColumn = false, audience: string | null = null): Context {
  let ctx = internalContext();
  if (scope?.scope_kind === 'group' && scope.scope_iface) ctx = groupContext(scope.scope_iface);
  else if (scope?.scope_kind === 'dm' && scope.scope_iface && scope.scope_dm)
    ctx = dmContext(scope.scope_dm, scope.scope_iface, audienceParts(audience)?.place_id ?? null);
  return audienceColumn === true ? { ...ctx, audienceColumn: true } : ctx;
}

/** The one stored DM place of an opaque partner on an interface; null for none and for several, which no triple can tell apart. */
function onlyDmPlaceOf(db: Db, scope: Scope): string | null {
  if (scope.scope_kind !== 'dm' || !isOpaquePerson(scope.scope_dm)) return null;
  const places = db
    .prepare("SELECT id FROM places WHERE partner_person = ? AND iface = ? AND (kind = 'dm' OR conversation = 'dm')")
    .all(scope.scope_dm, scope.scope_iface);
  return places.length === 1 ? String(places[0]?.id) : null;
}

/** The audience id of a scope (the one resolver), its audience row created when missing. */
function audienceIdOf(db: Db, scope: Scope | null | undefined, at: string): string {
  const dmPlace = scope ? onlyDmPlaceOf(db, scope) : null;
  const resolved = audienceOf(scope, { dmPlace });
  ensureAudience(db, resolved, { at });
  return resolved.audience_id;
}

const lookupPlaceOf =
  (db: Db) =>
  (placeId: string): Row | undefined =>
    db.prepare('SELECT iface, partner_person FROM places WHERE id = ?').get(placeId);

/** The audience of a row with the scope triple: its stored one, else what its triple resolves to. */
const audienceOfRow = (row: Row): unknown =>
  typeof row.audience_id === 'string' && row.audience_id !== ''
    ? row.audience_id
    : audienceOf(scopeOfRow(row)).audience_id;

/**
 * What a new row of this run is scoped to: the meet of the run's audience and of its own sources, on audience ids, because
 * the triple of an opaque partner names no conversation. Its audience row is created when missing.
 */
function narrowed(db: Db, state: WriteState, evidence: ReadonlyArray<Row>): { scope: Scope; audienceId: string } {
  const lookup = lookupPlaceOf(db);
  const audienceId = narrowestAudience([state.audience, ...evidence.map(audienceOfRow)], lookup);
  const scope = scopeOfAudience(audienceId, lookup);
  ensureAudience(db, { ...scope, audience_id: audienceId }, { at: state.at });
  return { scope, audienceId };
}

function insertRun(
  db: Db,
  run: SessionRunRow,
  mode: unknown,
  { applied, answerSource, at }: { applied: unknown; answerSource: unknown; at: string }
): void {
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
    typeof run.audienceId === 'string' ? run.audienceId : audienceIdOf(db, run.scope ?? null, at)
  );
}

function insertDecision(
  db: Db,
  {
    id,
    at,
    group,
    op,
    action,
    run,
  }: { id: string; at: string; group: unknown; op: Row; action: unknown; run: SessionRunRow }
): void {
  const target = targetOf(group, op);
  db.prepare(
    ownershipSql(
      db,
      `INSERT OR REPLACE INTO decisions (id, at, by, target_kind, target_id, action, reason, extra, owner_key, position, retired_at)
     VALUES (?, ?, 'her', ?, ?, ?, ?, ?, NULL, NULL, NULL)`
    )
  ).run(id, at, target.kind, target.id, action, reasonOf(op), json({ run: run.id, scope: run.scope ?? null, op }));
  projectRow(db, 'decisions', { id }, { at });
}

/** Her whole answer as a `sources` row of kind `kind`, scope internal; the thinking is kept in `think` as well. */
function insertAnswer(
  db: Db,
  { id, kind, text, at, extra }: { id: string; kind: string; text: string; at: string; extra: unknown }
): string {
  const thought = [...String(text).matchAll(/<think>([\s\S]*?)<\/think>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean)
    .join('\n\n');
  db.prepare(
    ownershipSql(
      db,
      `INSERT OR REPLACE INTO sources (id, kind, iface, native_id, revision, place_id, author_account, reply_to, occurred_at, recorded_at, seen_at, text, stems,
       media, mentions, direct, turn_id, op_id, think, extra, scope_kind, scope_iface, scope_dm, origin, owner_key, position,
       audience_id, authority_id, author_kind, observed_at)
     VALUES (?, ?, NULL, ?, 1, NULL, NULL, NULL, ?, ?, NULL, ?, NULL, NULL, NULL, 0, NULL, NULL, ?, ?, ?, ?, ?, 'memory', NULL, NULL, ?, ?, 'self', ?)`
    )
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

/** The live links of a claim or an episode; a retired link is not a link. Links the database writes leave `owner_key` null. */
function addSources(db: Db, table: string, key: string, id: string, sources: ReadonlyArray<unknown> | undefined): void {
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
function evidenceOf(db: Db, ids: unknown): Array<Row> | null {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const find = db.prepare(
    'SELECT id, scope_kind, scope_iface, scope_dm, audience_id FROM sources WHERE id = ? AND retired_at IS NULL'
  );
  const rows: Array<Row> = [];
  for (const id of ids) {
    const row = typeof id === 'string' ? find.get(id) : undefined;
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}

/** A new version of a claim, with its sources (`evidence`: `supports` or `conflicts`) in `claim_version_sources` (v9). */
function version(
  db: Db,
  {
    claimId,
    at,
    text,
    event,
    runId,
    index,
    extra = null,
    sources = [],
    evidence = 'supports',
    snapshot,
  }: {
    claimId: unknown;
    at: string;
    text: unknown;
    event: unknown;
    runId: unknown;
    index: number;
    extra?: unknown;
    sources?: ReadonlyArray<unknown>;
    evidence?: unknown;
    snapshot: { truth: unknown; how: unknown; audienceId: string };
  }
): void {
  const id = `cv:${asText(claimId)}:${shortHash(runId, index, event)}`;
  // A version is sealed by its snapshot below: the same op written again leaves it as it was.
  const snapshots = hasTable(db, 'semantic_assertion_versions');
  if (snapshots && db.prepare('SELECT 1 AS ok FROM semantic_assertion_versions WHERE version_id = ?').get(id)) return;
  db.prepare(
    ownershipSql(
      db,
      `INSERT OR REPLACE INTO claim_versions (id, claim_id, revision_id, text, extra, recorded_at, event, by, origin, owner_key, position, retired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'her', 'session', NULL, NULL, NULL)`
    )
  ).run(id, claimId, `rv:${shortHash(runId, index)}`, text, extra ? json(extra) : null, at, event);
  if (hasTable(db, 'claim_version_sources')) {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO claim_version_sources (version_id, source_id, role, legacy) VALUES (?, ?, ?, 0)'
    );
    for (const source of new Set(sources ?? [])) insert.run(id, source, evidence);
  }
  if (snapshots) {
    db.prepare(
      `INSERT INTO semantic_assertion_versions (version_id, format_version, assertion_kind, truth_state, how, polarity, recorded_at,
         audience_id, historical_metadata_complete)
       VALUES (?, 1, 'text', ?, ?, 'unknown', ?, ?, 1)`
    ).run(id, snapshot.truth ?? 'unknown', snapshot.how ?? null, at, snapshot.audienceId);
  }
  projectRow(db, 'claims', { id: claimId }, { at });
}

/** The kind of row a decision's action names; every other action names a claim. */
const DECISION_TARGETS: Record<string, string> = {
  episode: 'episode',
  affinity: 'person',
  entity: 'semantic_entity',
};

function insertDecisionFor(
  db: Db,
  {
    runId,
    index,
    at,
    op,
    action,
    target,
  }: { runId: unknown; index: number; at: string; op: unknown; action: unknown; target: unknown }
): void {
  db.prepare(
    ownershipSql(
      db,
      `INSERT OR REPLACE INTO decisions (id, at, by, target_kind, target_id, action, reason, extra, owner_key, position, retired_at)
     VALUES (?, ?, 'her', ?, ?, ?, ?, ?, NULL, NULL, NULL)`
    )
  ).run(
    `dec:${asText(runId)}:${index}`,
    at,
    DECISION_TARGETS[asText(action)] ?? 'claim',
    target,
    action,
    reasonOf(op),
    json({ run: runId, op })
  );
  projectRow(db, 'decisions', { id: `dec:${asText(runId)}:${index}` }, { at });
}

function reject(db: Db, state: WriteState, group: unknown, op: Row, why: unknown): void {
  state.counts.rejected += 1;
  insertDecision(db, {
    id: `dec:${state.runId}:${state.index}`,
    at: state.at,
    group,
    op,
    action: `rejected:${asText(why)}`,
    run: state.run,
  });
}

/** A claim of the scope `scope` made from `claim` (the old claim stays as it was); returns its id. */
function deriveClaim(
  db: Db,
  claim: Row,
  scope: Scope,
  {
    at,
    runId,
    index,
    text,
    how,
    truth,
    shown,
    audienceId,
  }: {
    at: string;
    runId: unknown;
    index: number;
    text?: unknown;
    how?: unknown;
    truth?: unknown;
    shown?: unknown;
    audienceId: string;
  }
): string {
  const id = `clm:${shortHash(runId, index, 'derived', claim.id)}`;
  let extra: Row = {};
  try {
    extra = claim.extra ? (JSON.parse(claim.extra as string) as Row) : {};
  } catch {
    extra = {};
  }
  db.prepare(
    ownershipSql(
      db,
      `INSERT OR REPLACE INTO claims (id, subject_kind, subject_id, kind, text, extra, weight, first_seen_at, last_seen_at, valid_to, superseded_by,
       how, author, from_person, truth, shown, scope_kind, scope_iface, scope_dm, created_at, retired_at, origin_file, owner_key, position, audience_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'her', NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`
    )
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
    audienceId
  );
  projectRow(db, 'claims', { id }, { at });
  return id;
}

function applyClaim(db: Db, op: Row, state: WriteState): void {
  const { at, runId, index, counts } = state;
  const evidence = evidenceOf(db, op.sources);
  if (!evidence) return reject(db, state, 'claims', op, 'unknown_source');
  // The scope of the NEW version: the narrowest of the run and of its own sources, never the old version's.
  const { scope, audienceId } = narrowed(db, state, evidence);
  if (op.op === 'add') {
    const id = `clm:${shortHash(runId, index, op.subjectId, op.text)}`;
    db.prepare(
      ownershipSql(
        db,
        `INSERT OR REPLACE INTO claims (id, subject_kind, subject_id, kind, text, extra, weight, first_seen_at, last_seen_at, valid_to, superseded_by,
         how, author, from_person, truth, shown, scope_kind, scope_iface, scope_dm, created_at, retired_at, origin_file, owner_key, position, audience_id)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, 'her', NULL, 'current', 1, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`
      )
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
      audienceId
    );
    addSources(db, 'claim_sources', 'claim_id', id, op.sources as Array<string>);
    version(db, {
      claimId: id,
      at,
      text: op.text,
      event: 'add',
      runId,
      index,
      sources: op.sources as Array<string>,
      snapshot: { truth: 'current', how: op.how, audienceId },
    });
    insertDecisionFor(db, { runId, index, at, op, action: 'add', target: id });
    counts.added += 1;
    return;
  }
  const claim = db.prepare('SELECT * FROM claims WHERE id = ? AND retired_at IS NULL').get(op.id);
  if (!claim) {
    counts.missing += 1;
    return;
  }
  if (!canRead(claim, contextOf(state.scope, state.audienceColumn, state.audience)))
    return reject(db, state, 'claims', op, 'out_of_scope');
  if ((op.op === 'revise' || op.op === 'retire') && !present(op.reason))
    return reject(db, state, 'claims', op, 'no_reason');
  // Compare-and-set on the claim: the version the session read must still be its newest (schema v9).
  if (Object.hasOwn(op, 'base') && (op.base ?? null) !== newestClaimVersion(db, op.id))
    return reject(db, state, 'claims', op, 'stale_base');
  const derived = audienceId !== audienceOfRow(claim);
  let target = op.id;
  if (op.op === 'confirm') {
    if (derived) target = deriveClaim(db, claim, scope, { at, runId, index, audienceId });
    else db.prepare('UPDATE claims SET last_seen_at = ? WHERE id = ?').run(at, op.id);
    addSources(db, 'claim_sources', 'claim_id', target as string, op.sources as Array<string>);
    version(db, {
      claimId: target,
      at,
      text: claim.text,
      event: 'confirm',
      runId,
      index,
      sources: op.sources as Array<string>,
      snapshot: { truth: claim.truth, how: claim.how, audienceId },
    });
    counts.confirmed += 1;
  } else if (op.op === 'revise') {
    if (derived) target = deriveClaim(db, claim, scope, { at, runId, index, text: op.text, how: op.how, audienceId });
    else
      db.prepare('UPDATE claims SET text = ?, how = ?, last_seen_at = ? WHERE id = ?').run(op.text, op.how, at, op.id);
    addSources(db, 'claim_sources', 'claim_id', target as string, op.sources as Array<string>);
    version(db, {
      claimId: target,
      at,
      text: op.text,
      event: 'revise',
      runId,
      index,
      extra: { before: claim.text, reason: op.reason },
      sources: op.sources as Array<string>,
      snapshot: { truth: claim.truth, how: op.how, audienceId },
    });
    counts.revised += 1;
  } else {
    // Disputed stays shown beside the claim it contradicts; historical and retired leave the shown set (still findable).
    const shown = op.truth === 'disputed' ? 1 : 0;
    const validTo = op.truth === 'disputed' ? null : at;
    if (derived) {
      target = deriveClaim(db, claim, scope, { at, runId, index, truth: op.truth, shown, audienceId });
      if (validTo) db.prepare('UPDATE claims SET valid_to = ? WHERE id = ?').run(validTo, target);
    } else {
      db.prepare('UPDATE claims SET truth = ?, shown = ?, valid_to = COALESCE(?, valid_to) WHERE id = ?').run(
        op.truth,
        shown,
        validTo,
        op.id
      );
    }
    addSources(db, 'claim_sources', 'claim_id', target as string, op.sources as Array<string>);
    version(db, {
      claimId: target,
      at,
      text: claim.text,
      event: 'retire',
      runId,
      index,
      extra: { truth: op.truth, reason: op.reason },
      sources: op.sources as Array<string>,
      evidence: 'conflicts',
      snapshot: { truth: op.truth, how: claim.how, audienceId },
    });
    counts.retired += 1;
  }
  if (derived) counts.derived += 1;
  else takeOverClaim(db, op.id);
  insertDecisionFor(db, { runId, index, at, op, action: op.op, target });
}

function applyEpisode(db: Db, op: Row, state: WriteState): void {
  const { at, runId, index, counts } = state;
  const evidence = evidenceOf(db, op.sources);
  if (!evidence) return reject(db, state, 'episodes', op, 'unknown_source');
  const { scope, audienceId } = narrowed(db, state, evidence);
  const id = `ep:${shortHash(runId, index, op.subjectId, op.what)}`;
  db.prepare(
    ownershipSql(
      db,
      `INSERT OR REPLACE INTO episodes (id, kind, subject_id, place_id, date, what, quote, feeling, feeling_at, reread, weight, world, status, perspective,
       start_ms, last_ms, extra, scope_kind, scope_iface, scope_dm, created_at, retired_at, owner_key, position, audience_id)
     VALUES (?, 'session', ?, NULL, ?, ?, NULL, ?, ?, NULL, NULL, NULL, 'open', NULL, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL, NULL, ?)`
    )
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
    audienceId
  );
  addSources(db, 'episode_sources', 'episode_id', id, op.sources as Array<string>);
  projectRow(db, 'episodes', { id }, { at });
  insertDecisionFor(db, { runId, index, at, op, action: 'episode', target: id });
  counts.episodes += 1;
}

function applyAffinity(db: Db, op: Row, state: WriteState): void {
  const { at, runId, index, counts } = state;
  const evidence = evidenceOf(db, op.sources);
  if (!evidence) return reject(db, state, 'affinity', op, 'unknown_source');
  if (!present(op.reason)) return reject(db, state, 'affinity', op, 'no_reason');
  const { scope, audienceId } = narrowed(db, state, evidence);
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
  const before = isFiniteNumber(person.affinity) ? person.affinity : 0;
  const cap = isFiniteNumber(state.maxDelta) ? Math.abs(state.maxDelta) : Infinity;
  const applied = clamp(op.delta as number, -cap, cap);
  const score = Math.round(clamp(before + applied, -100, 100) * 100) / 100;
  db.prepare(
    ownershipSql(
      db,
      `INSERT INTO affinity_events (id, person_id, at, delta, applied, score, reason, scope_kind, scope_iface, scope_dm, extra, owner_key, position, retired_at, audience_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`
    )
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
    json({ run: runId, sources: op.sources as Array<string> }),
    audienceId
  );
  db.prepare('UPDATE people SET affinity = ?, affinity_reason = ? WHERE id = ?').run(score, op.reason, op.personId);
  insertDecisionFor(db, { runId, index, at, op, action: 'affinity', target: op.personId });
  counts.affinity += 1;
}

/** The live link of an account or participant to a person (or, for a participant, to an account), if any. */
function liveLinkOf(db: Db, kind: unknown, id: unknown): Row | null {
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
function applyPeopleAdd(db: Db, op: Row, state: WriteState): void {
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
    ownershipSql(
      db,
      "INSERT INTO people (id, kind, first_seen_at, last_seen_at, status, owner_key) VALUES (?, 'person', ?, ?, 'active', NULL)"
    )
  ).run(person, at, at);
  projectRow(db, 'people', { id: person }, { at });
  let link: string;
  if (op.subjectKind === 'account') {
    link = linkId(op.subjectId, person);
    db.prepare(
      `INSERT INTO account_person_links (id, account_id, person_id, state, by, reason, evidence_id, valid_from_at, valid_to_at, recorded_at)
      VALUES (?, ?, ?, 'proposed', 'her', ?, ?, ?, NULL, ?)`
    ).run(link, op.subjectId, person, op.reason, (op.sources as Array<unknown>)[0], at, at);
    projectRow(db, 'account_person_links', { account_id: op.subjectId }, { at });
  } else {
    link = `plink:${asText(op.subjectId)}:${person}`;
    db.prepare(
      `INSERT INTO participant_links (id, participant_id, account_id, person_id, state, by, reason, evidence_id, valid_from_at, valid_to_at, recorded_at)
      VALUES (?, ?, NULL, ?, 'proposed', 'her', ?, ?, ?, NULL, ?)`
    ).run(link, op.subjectId, person, op.reason, (op.sources as Array<unknown>)[0], at, at);
    projectRow(db, 'participant_links', { participant_id: op.subjectId }, { at });
  }
  db.prepare(
    ownershipSql(
      db,
      `INSERT OR REPLACE INTO decisions (id, at, by, target_kind, target_id, action, reason, extra, owner_key, position, retired_at)
     VALUES (?, ?, 'her', 'person', ?, 'people_add', ?, ?, NULL, NULL, NULL)`
    )
  ).run(`dec:${runId}:${index}`, at, person, op.reason, json({ run: runId, op, link }));
  projectRow(db, 'decisions', { id: `dec:${runId}:${index}` }, { at });
  counts.people += 1;
}

const SEMANTIC_GROUPS: ReadonlySet<string> = new Set(['entities', 'assertions']);

/** An `entities` or `assertions` op: the writer's refusal is its decision, the rest of the answer stands. */
function applySemantic(db: Db, group: string, op: Row, state: WriteState): void {
  const write = group === 'entities' ? writeSessionEntity : writeSessionAssertion;
  const outcome = write(db, op, state.semantics);
  if (!outcome.ok) return reject(db, state, group, op, outcome.code);
  const { at, runId, index, counts } = state;
  const entity = outcome.result.kind === 'entity';
  insertDecisionFor(db, {
    runId,
    index,
    at,
    op,
    action: entity ? 'entity' : 'assertion',
    target: outcome.result.kind === 'entity' ? outcome.result.entityId : outcome.result.claimId,
  });
  if (entity) counts.entities += 1;
  else counts.assertions += 1;
}

/** What the run's request showed: the only sources and claim versions its structured ops may cite. */
function readSetOf(reads: unknown): SessionSemantics['read'] {
  const rows = (Array.isArray(reads) ? reads : []) as Array<Row>;
  return {
    sourceIds: rows.filter((row) => row.row_kind === 'sources').map((row) => String(row.row_id)),
    versionIds: rows
      .filter((row) => (row.row_kind === 'claims' || row.row_kind === 'claim_versions') && row.version_id)
      .map((row) => String(row.version_id)),
  };
}

/** What the ops of one run share, with the audience the run reads and writes under. */
function writeStateOf(db: Db, run: SessionRunRow, update: Row, counts: Counts, at: string): WriteState {
  const uuid = typeof update.uuid === 'function' ? (update.uuid as () => string) : randomUUID;
  const audience = typeof run.audienceId === 'string' ? run.audienceId : audienceIdOf(db, run.scope ?? null, at);
  return {
    at,
    runId: run.id,
    run,
    scope: run.scope as Scope,
    maxDelta: update.maxDelta,
    counts,
    index: 0,
    audienceColumn: update.audienceColumn === true,
    uuid,
    audience,
    semantics: {
      ctx: contextOf(run.scope, true, audience),
      read: readSetOf(update.reads),
      handles: new Map(),
      at,
      uuid,
    },
  };
}

const emptyCounts = (): Counts => ({
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
  entities: 0,
  assertions: 0,
});

/** Throws unless `mode` is one the writer knows. */
function guard(update: Row): void {
  if (update.mode !== 'shadow' && update.mode !== 'apply') throw coded('BAD_MODE');
}

/** The request of a session run learns what became of it, in the transaction that says so. */
function linkRequest(db: Db, run: SessionRunRow | null | undefined, applied: boolean): void {
  if (!run) return;
  const state = applied ? 'confirmed' : run.outcome === 'ok' ? 'shadow' : 'failed';
  setRequestOutcome(db, sessionRequestId(run.id), { kind: 'memory-write', state, ref: run.id });
}

/** The writers that take the handle and the whole update, by the update's kind. */
const WHOLE_WRITES = new Map<string, (handle: MemoryHandle, update: Row) => unknown>([
  ['wake-queue', applyWakeQueueWrite],
  ['board', applyBoardWrite],
  ['person-link', applyPersonLinkWrite],
  ['request-archive', applyRequestArchiveWrite],
  // The diary's mirrors: the state of a send, then the owner's configuration.
  [
    'publication',
    (handle, update) => (isDeliveryOp(update.op) ? applyDeliveryWrite : applyPublicationWrite)(handle, update),
  ],
  ['mirror', applyMirrorWrite],
  ['semantic', applySemanticMessage],
  ['semantic-embedding', applySemanticEmbedding],
]);

/** Applies one write on the writer connection; returns counts. */
export function applyMemoryWrite(handleGiven: unknown, updateGiven: unknown): unknown {
  const handle = handleGiven as MemoryHandle;
  const update = updateGiven as Row;
  const kind = update?.kind;
  if (kind === 'context') return writeContext(handle, update);
  if (kind === 'description') return writeDescription(handle, update);
  // Schema v11: the writers of wake runs, the skills registry and the index policy share this one writer path.
  if (kind === 'wake') return applyWakeWrite(handle, update);
  if (kind === 'skills') return applySkillsWrite(handle, update);
  if (kind === 'index-policy' || kind === 'touch' || kind === 'reembed') return applyIndexWrite(handle, update);
  if (kind === 'unit') return applyUnitWrite(handle, update);
  if (kind === 'entry-media') return applyEntryMedia(handle, update);
  // Schema v16: the event door's ingestion record (ingest.ts).
  if (kind === 'ingest' || kind === 'ingest-ack' || kind === 'ingest-release') return applyIngestWrite(handle, update);
  // Schema v18: the inner life's wake queue and leases (wake-queue.ts); the task board (src/board/writer.ts).
  const whole = WHOLE_WRITES.get(asText(kind));
  if (whole) return whole(handle, update);
  if (kind === 'backup') {
    return writeBackup(handle, {
      to: update.to as string,
      dataDir: update.dataDir as string,
      now: () => (update.now as number | undefined) ?? Date.now(),
      commit: update.commit ?? null,
      configHash: update.configHash ?? null,
    });
  }
  if (kind !== 'session') throw coded('BAD_UPDATE');
  const { mode } = update;
  const run = update.run as SessionRunRow | null | undefined;
  const plan = update.plan as Record<string, Array<Row> | undefined> | null | undefined;
  const advance = update.advance as { key: string; expect?: unknown; value: unknown } | null | undefined;
  const pending = update.pending as { key: string; value?: unknown } | null | undefined;
  const answer = update.answer as { text?: string } | null | undefined;
  const at = iso((update.now as number | undefined) ?? Date.now());
  return handle.transaction(() => {
    const db = dbOf(handle);
    guard(update);
    if (run && mode === 'apply' && run.batchKey) {
      const first = db.prepare('SELECT result FROM session_runs WHERE batch_key = ? AND applied = 1').get(run.batchKey);
      if (first) {
        let result: Row = {};
        try {
          result = first.result ? (JSON.parse(first.result as string) as Row) : {};
        } catch {
          result = {};
        }
        return { ...result, replayed: true };
      }
    }
    const counts = emptyCounts();
    const answerSource =
      run && answer?.text
        ? insertAnswer(db, {
            id: otherSourceId('memory_session', run.id),
            kind: 'memory_session',
            text: answer.text,
            at,
            extra: { run: run.id },
          })
        : null;
    const applied = run != null && mode === 'apply' && plan != null && run.outcome === 'ok';
    if (run) insertRun(db, run, mode, { applied, answerSource, at });
    // What the request rendered (the read-set of the run), in the run's context.
    let contextId = '';
    if (run && update.context) contextId = insertContext(db, update.context as Row) ?? '';
    if (run && Array.isArray(update.reads) && update.reads.length > 0) {
      writeTurnReadRows(
        db,
        run.id,
        asText(update.readStep ?? 0),
        (update.reads as Array<Row>).map((row) => ({ ...row, context_id: contextId, reader_kind: 'session' }))
      );
    }
    if (plan && run) {
      const state = writeStateOf(db, run, update, counts, at);
      for (const group of ['claims', 'episodes', 'affinity', 'descriptions', 'people', 'entities', 'assertions']) {
        for (const op of plan[group] ?? []) {
          state.index += 1;
          if (mode === 'shadow') {
            insertDecision(db, {
              id: `dec:${run.id}:${state.index}`,
              at,
              group,
              op,
              action: `proposed:${asText(nameOf(group, op))}`,
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
          } else if (SEMANTIC_GROUPS.has(group)) {
            applySemantic(db, group, op, state);
          } else {
            insertDecision(db, { id: `dec:${run.id}:${state.index}`, at, group, op, action: 'flag:description', run });
            counts.flags += 1;
          }
        }
      }
    }
    if (update.decision) {
      const { id, action, reason, extra, scope: target } = update.decision as Row;
      db.prepare(
        ownershipSql(
          db,
          `INSERT OR REPLACE INTO decisions (id, at, by, target_kind, target_id, action, reason, extra, owner_key, position, retired_at)
         VALUES (?, ?, 'engine', 'session_scope', ?, ?, ?, ?, NULL, NULL, NULL)`
        )
      ).run(`dec:${asText(id)}`, at, target ?? run?.scopeKey ?? null, action, reason ?? null, json(extra ?? {}));
      projectRow(db, 'decisions', { id: `dec:${asText(id)}` }, { at });
    }
    if (advance) {
      // Compare-and-set: the cursor moves from the value the batch was read at, or nothing is written.
      const current = db.prepare('SELECT value FROM meta WHERE key = ?').get(advance.key)?.value ?? '0';
      if (asText(current) !== asText(advance.expect ?? 0)) throw coded('CURSOR_CONFLICT');
      db.prepare(SET_META).run(advance.key, String(advance.value));
    }
    if (pending) {
      if (pending.value === null || pending.value === undefined)
        db.prepare('DELETE FROM meta WHERE key = ?').run(pending.key);
      else db.prepare(SET_META).run(pending.key, asText(pending.value));
    }
    if (applied) db.prepare('UPDATE session_runs SET result = ? WHERE id = ?').run(json(counts), run.id);
    linkRequest(db, run, applied);
    return counts;
  });
}

/**
 * One reviewed description as a `description_versions` row. In shadow its origin is `shadow` and it is never the
 * current version; in apply the same transaction creates or moves the `descriptions` row to it.
 * `expectCurrent` is the version the review was based on; if another one has become current meanwhile, nothing is written.
 */
function writeDescription(handle: MemoryHandle, update: Row): { written: number } {
  const { answers } = update;
  const row = update.row as Row & { id: string; descriptionId: string; text: string; extra?: Row };
  const subject = update.subject as { kind: string; id: string; field: string };
  const scope = update.scope as Scope;
  const at = iso((update.now as number | undefined) ?? Date.now());
  handle.transaction(() => {
    const db = dbOf(handle);
    guard(update);
    const applying = update.mode === 'apply';
    if (applying) {
      const current =
        db.prepare('SELECT current_version FROM descriptions WHERE id = ?').get(row.descriptionId)?.current_version ??
        null;
      if (current !== (update.expectCurrent ?? null)) throw coded('VERSION_CONFLICT');
    }
    const extra: Row = { ...(row.extra ?? {}) };
    if (Array.isArray(answers) && answers.length > 0) {
      extra.answers = (answers as Array<{ purpose: string; text: string }>).map((answer) => ({
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
      ownershipSql(
        db,
        `INSERT OR REPLACE INTO description_versions (id, description_id, text, author, written_at, chars, kept, removed, added, reason, origin, extra,
         owner_key, position, retired_at)
       VALUES (?, ?, ?, 'her', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`
      )
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
        ownershipSql(
          db,
          `INSERT INTO descriptions (id, subject_kind, subject_id, field, scope_kind, scope_iface, scope_dm, current_version, owner_key, audience_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET current_version = excluded.current_version`
        )
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

const contextOk = (row: unknown): row is Row =>
  !!row && typeof (row as Row).id === 'string' && !!(row as Row).id && typeof (row as Row).issued_at === 'string';

/** Records one issued context's row, inside the caller's transaction; returns its id (null for a malformed row). */
function insertContext(db: Db, row: Row): string | null {
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
  return row.id as string;
}

/**
 * Writes resolved read rows (service.ts#turnReadRows) of one step, inside the caller's transaction: the one writer of
 * `turn_reads` (service.ts#insertTurnReads wraps it in a transaction). A row's `context_id` is '' when no context was
 * issued, its `reader_kind` `turn` unless it says `session` or `wake`.
 */
export function writeTurnReadRows(db: Db, turnId: string, step: unknown, rows: ReadonlyArray<Row>): void {
  const insert =
    db.prepare(`INSERT OR IGNORE INTO turn_reads (turn_id, step, context_id, row_kind, row_id, block, ord, version_id, revision, reader_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows) {
    const contextId = typeof row.context_id === 'string' ? row.context_id : '';
    const readerKind = ['turn', 'session', 'wake'].includes(row.reader_kind as string) ? row.reader_kind : 'turn';
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
function writeContext(handle: MemoryHandle, update: Row): { written: number } {
  const row = update.context;
  if (!contextOk(row)) throw coded('BAD_CONTEXT');
  let written = 0;
  handle.transaction(() => {
    const db = dbOf(handle);
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

 */
export function mergePeople(
  handle: MemoryHandle,
  from: string,
  into: string,
  { by, reason = null, evidence = null, now }: { by?: string; reason?: unknown; evidence?: unknown; now?: number } = {}
): { id: string; survivor: string } {
  if (!present(from) || !present(into) || !present(by)) throw coded('BAD_MERGE');
  if (from === into) throw coded('SAME_PERSON');
  if (from === SELF_PERSON || into === SELF_PERSON) throw coded('SELF_PERSON');
  const at = iso(now ?? Date.now());
  return handle.transaction(() => {
    const db = dbOf(handle);
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
