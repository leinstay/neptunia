// The persona memory writer for structured facts. `validateSemanticCandidate` resolves one entity or assertion against the
// typed tables, the issued context and what the run was shown, or refuses it with a stable code and writes nothing.
// The session's operations (`writeSessionEntity`, `writeSessionAssertion`) run a resolved write inside the session write's
// transaction: the claim, its version, the evidence, the arguments and premises, then the seal, the projections and the
// graph. The meaning is hers: code checks references, roles, evidence and compare-and-set, and her text is stored as she
// wrote it.
//
// The audience of a write is the meet of the issued context, the evidence, the premises and the endpoints, on audience ids.
// When it is narrower than the base claim's, the write forks a new claim and the base stays as it was. An entity known only
// privately narrows every fact that names it, so a public fact about it needs a separate entity and an equivalence.
// An `assertions` op may carry `claimId` with `baseVersionId` (a successor of that claim) and a full `evidence` list. The
// parser of the model's answer (src/memory/db/semantic-answer.ts) never sets them, so a session only creates; the writer
// itself revises, retires and forks, and the tests drive that through these fields.

import { projectRow } from './graph.ts';
import { ensureAudience, newestClaimVersion } from './rows.ts';
import {
  AUD_INTERNAL,
  AUD_NONE,
  allowedAudience,
  audienceParts,
  audienceWhere,
  dmAudienceId,
  groupAudienceId,
  narrowestAudience,
  scopeOfAudience,
} from './scope.ts';
import type { Context } from './scope.ts';
import {
  ASSERTION_HOW,
  EQUIVALENCE_PREDICATE,
  LABEL_PREDICATE,
  checkArguments,
  readEntityKind,
  readPredicate,
  validDate,
} from './semantic-registry.ts';
import { entityWitnesses, projectSealedVersion, visibleMerges } from './semantic-rows.ts';
import { writeSearchDocument } from './semantic-search.ts';
import { takeOverClaim } from './session-rows.ts';
import type { Db, Row } from './types.ts';
import type {
  ResolvedAssertion,
  ResolvedEntity,
  ResolvedSemanticWrite,
  SemanticArgument,
  SemanticCandidate,
  SemanticDependency,
  SemanticEntityCandidate,
  SemanticEvidence,
  SemanticReadSet,
  SemanticRef,
  SemanticRejection,
  SemanticWriteResult,
} from './semantic-types.ts';

type Checked<TValue> = { ok: true; value: TValue } | SemanticRejection;
const refused = (code: string): SemanticRejection => ({ ok: false, code });
const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const blank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';
const isObject = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);

const ENTITY_FIELDS = new Set(['kind', 'kindVersion', 'name', 'evidence', 'dependencies']);
const NAME_FIELDS = new Set(['text', 'language']);
const ASSERTION_FIELDS = new Set([
  'claimId',
  'baseVersionId',
  'assertionKind',
  'predicate',
  'text',
  'arguments',
  'evidence',
  'dependencies',
  'polarity',
  'state',
  'how',
  'validFrom',
  'validTo',
]);
const STATES = new Set(['current', 'historical', 'disputed', 'retired']);
const POLARITIES = new Set(['positive', 'negative']);
const EVIDENCE_ROLES = new Set(['supports', 'conflicts']);
const DEPENDENCY_ROLES = new Set(['supports', 'conflicts', 'identity']);
const onlyFields = (given: Row, allowed: ReadonlySet<string>): boolean =>
  Object.keys(given).every((key) => allowed.has(key));

/** The typed home of each reference kind, and the audience column of the homes that hold one. */
const REF_HOMES: Record<SemanticRef['kind'], { table: string; audience: boolean } | null> = {
  entity: null,
  person: { table: 'people', audience: false },
  account: { table: 'accounts', audience: false },
  participant: { table: 'participants', audience: false },
  place: { table: 'places', audience: false },
  source: { table: 'sources', audience: true },
  claim: { table: 'claims', audience: true },
  claim_version: null,
  episode: { table: 'episodes', audience: true },
  media: { table: 'media', audience: true },
};

const lookupOf =
  (db: Db) =>
  (placeId: string): Row | undefined =>
    db.prepare('SELECT iface, partner_person FROM places WHERE id = ?').get(placeId);

/** The audience every read of `ctx` is bound to, or null for a context that reads across audiences. */
function contextAudience(ctx: Context): string | null {
  if (ctx.internal === true || ctx.groups === true) return null;
  if (ctx.kind === 'group') return groupAudienceId(ctx.iface);
  return typeof ctx.place === 'string' && ctx.place !== '' ? dmAudienceId(ctx.place) : AUD_INTERNAL;
}

/** The audience of a claim version: its own snapshot, else its parent claim's. */
function versionAudience(db: Db, versionId: string): string | null {
  const row = db
    .prepare(
      `SELECT COALESCE(a.audience_id, c.audience_id) AS audience_id FROM claim_versions v
         LEFT JOIN semantic_assertion_versions a ON a.version_id = v.id
         LEFT JOIN claims c ON c.id = v.claim_id WHERE v.id = ?`
    )
    .get(versionId);
  return typeof row?.audience_id === 'string' ? row.audience_id : null;
}

/** What an entity's witnesses add to the meet: nothing when one of them is public, else its one private audience. */
function entityAudience(witnesses: ReadonlyArray<string>): string {
  const open = witnesses.find((id) => id === AUD_NONE || audienceParts(id)?.kind === 'group');
  if (open !== undefined) return open;
  return witnesses.length === 1 ? witnesses[0] : AUD_INTERNAL;
}

const validEvidence = (given: unknown): given is SemanticEvidence =>
  isObject(given) && typeof given.sourceId === 'string' && EVIDENCE_ROLES.has(String(given.role));
const validDependency = (given: unknown): given is SemanticDependency =>
  isObject(given) && typeof given.versionId === 'string' && DEPENDENCY_ROLES.has(String(given.role));

/** Every source must exist, be one the run was shown and be one the context may read; their audiences. */
function checkEvidence(db: Db, ctx: Context, evidence: unknown, read: SemanticReadSet): Checked<Array<string>> {
  if (!Array.isArray(evidence) || evidence.length === 0) return refused('no_evidence');
  const find = db.prepare('SELECT audience_id FROM sources WHERE id = ? AND retired_at IS NULL');
  const out: Array<string> = [];
  for (const one of evidence) {
    if (!validEvidence(one)) return refused('bad_evidence');
    const row = find.get(one.sourceId);
    if (!row) return refused('unknown_source');
    if (!read.sourceIds.includes(one.sourceId)) return refused('unread_source');
    if (!allowedAudience(row, ctx)) return refused('out_of_scope');
    out.push(String(row.audience_id));
  }
  return { ok: true, value: out };
}

/** Whether a premise chain from `versionIds` reaches a version of `claimId`. */
function reachesClaim(db: Db, versionIds: ReadonlyArray<string>, claimId: string): boolean {
  const seen = new Set<string>();
  const claimOf = db.prepare('SELECT claim_id FROM claim_versions WHERE id = ?');
  const premises = db.prepare('SELECT premise_version_id FROM semantic_dependencies WHERE version_id = ?');
  const frontier = [...versionIds];
  while (frontier.length > 0) {
    const id = frontier.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    if (claimOf.get(id)?.claim_id === claimId) return true;
    for (const row of premises.all(id)) frontier.push(String(row.premise_version_id));
  }
  return false;
}

/** Every premise must be stored, shown to the run and readable; a chain back to the claim being written is refused. */
function checkPremises(
  db: Db,
  ctx: Context,
  dependencies: unknown,
  read: SemanticReadSet,
  claimId: string | null
): Checked<Array<string>> {
  if (!Array.isArray(dependencies)) return refused('bad_dependency');
  const out: Array<string> = [];
  const exists = db.prepare('SELECT 1 AS ok FROM claim_versions WHERE id = ?');
  for (const one of dependencies) {
    if (!validDependency(one)) return refused('bad_dependency');
    if (!exists.get(one.versionId)) return refused('unknown_version');
    if (!read.versionIds.includes(one.versionId)) return refused('unread_version');
    const audience = versionAudience(db, one.versionId);
    if (audience === null || !allowedAudience({ audience_id: audience }, ctx)) return refused('out_of_scope');
    out.push(audience);
  }
  const ids = (dependencies as Array<SemanticDependency>).map((one) => one.versionId);
  if (claimId !== null && reachesClaim(db, ids, claimId)) return refused('premise_cycle');
  return { ok: true, value: out };
}

/** A reference resolves against its declared home and the context; what it adds to the audience's meet, or null. */
function endpointAudience(db: Db, ctx: Context, ref: SemanticRef): string | null | undefined {
  if (ref.kind === 'entity') {
    const entity = db.prepare('SELECT 1 AS ok FROM semantic_entities WHERE id = ? AND retired_at IS NULL').get(ref.id);
    if (!entity) return undefined;
    const witnesses = entityWitnesses(db, ctx, ref.id, null);
    return witnesses.length === 0 ? undefined : entityAudience(witnesses);
  }
  if (ref.kind === 'claim_version') {
    const audience = versionAudience(db, ref.id);
    return audience !== null && allowedAudience({ audience_id: audience }, ctx) ? audience : undefined;
  }
  const home = REF_HOMES[ref.kind];
  if (!home) return undefined;
  const row = db.prepare(`SELECT * FROM "${home.table}" WHERE id = ?`).get(ref.id);
  if (!row || (row.retired_at !== null && row.retired_at !== undefined)) return undefined;
  if (ref.kind === 'place' && (row.kind === 'dm' || row.conversation === 'dm')) {
    const audience = dmAudienceId(ref.id);
    return allowedAudience({ audience_id: audience }, ctx) ? audience : undefined;
  }
  if (!home.audience) return null;
  return allowedAudience(row, ctx) ? String(row.audience_id) : undefined;
}

const validRef = (ref: unknown): ref is SemanticRef =>
  isObject(ref) && typeof ref.id === 'string' && Object.hasOwn(REF_HOMES, String(ref.kind));

function checkEndpoints(db: Db, ctx: Context, given: ReadonlyArray<SemanticArgument>): Checked<Array<string>> {
  const out: Array<string> = [];
  for (const argument of given) {
    if (!('ref' in argument)) continue;
    if (!validRef(argument.ref)) return refused('unknown_ref');
    const audience = endpointAudience(db, ctx, argument.ref);
    if (audience === undefined) return refused('unknown_ref');
    if (audience !== null) out.push(audience);
  }
  return { ok: true, value: out };
}

/** The meet of the context and everything the write rests on, with the scope columns that are its projection. */
function resolveAudience(
  db: Db,
  ctx: Context,
  parts: ReadonlyArray<string>
): Pick<ResolvedEntity, 'audienceId' | 'scope'> {
  const lookup = lookupOf(db);
  const own = contextAudience(ctx);
  const audienceId = narrowestAudience(own === null ? parts : [own, ...parts], lookup);
  return { audienceId, scope: scopeOfAudience(audienceId, lookup) };
}

function validateEntity(db: Db, ctx: Context, given: SemanticEntityCandidate, read: SemanticReadSet) {
  if (!onlyFields(given, ENTITY_FIELDS)) return refused('unknown_field');
  if (!isObject(given.name) || !onlyFields(given.name, NAME_FIELDS)) return refused('unknown_field');
  if (!readEntityKind(db, given.kind, given.kindVersion)) return refused('unknown_kind');
  if (blank(given.name.text) || blank(given.name.language)) return refused('bad_name');
  const evidence = checkEvidence(db, ctx, given.evidence, read);
  if (!evidence.ok) return evidence;
  const premises = checkPremises(db, ctx, given.dependencies, read, null);
  if (!premises.ok) return premises;
  const resolved: ResolvedEntity = {
    kind: 'entity',
    entityKind: given.kind,
    kindVersion: given.kindVersion,
    name: { text: given.name.text, language: given.name.language },
    evidence: given.evidence,
    dependencies: given.dependencies,
    ...resolveAudience(db, ctx, [...evidence.value, ...premises.value]),
  };
  return { ok: true as const, resolved };
}

/** The fields of an assertion that need no database, in the order a reader of the code expects. */
function checkShape(given: SemanticCandidate): string | null {
  if (!Array.isArray(given.arguments)) return 'bad_arity';
  if (!ASSERTION_HOW.includes(given.how)) return 'bad_how';
  if (blank(given.text)) return 'no_text';
  if (!POLARITIES.has(given.polarity)) return 'bad_polarity';
  if (!STATES.has(given.state)) return 'bad_state';
  const { validFrom: from, validTo: to } = given;
  if ((from !== null && !validDate(from)) || (to !== null && !validDate(to))) return 'bad_interval';
  if (from !== null && to !== null && Date.parse(from) > Date.parse(to)) return 'bad_interval';
  if ((given.claimId === null) !== (given.baseVersionId === null)) return 'stale_base';
  return null;
}

const refOf = (given: ReadonlyArray<SemanticArgument>, role: string): string | null => {
  const found = given.find((one) => one.role === role);
  return found && 'ref' in found ? found.ref.id : null;
};
const literalOf = (given: ReadonlyArray<SemanticArgument>, role: string): unknown => {
  const found = given.find((one) => one.role === role);
  return found && 'literal' in found ? found.literal : undefined;
};

/** A label names its entity once, by a name or an alias that holds a word. */
function checkLabel(given: SemanticCandidate): string | null {
  const texts = ['name', 'alias'].map((role) => literalOf(given.arguments, role)).filter((one) => one !== undefined);
  if (texts.length !== 1) return 'bad_arity';
  return blank(texts[0]) ? 'bad_name' : null;
}

/** An equivalence in force may not close a loop among the merges this context reads. */
function checkEquivalence(db: Db, ctx: Context, given: SemanticCandidate): string | null {
  const from = refOf(given.arguments, 'from');
  const into = refOf(given.arguments, 'into');
  if (from === null || into === null || from === into) return 'equivalence_loop';
  if (given.state !== 'current' || given.polarity !== 'positive') return null;
  const merges = visibleMerges(db, ctx, null);
  const seen = new Set<string>();
  for (let at: string | undefined = into; at !== undefined && !seen.has(at); at = merges.get(at)) {
    if (at === from) return 'equivalence_loop';
    seen.add(at);
  }
  return null;
}

/** The base of a successor: the claim must be readable and the version still its newest. */
function checkBase(db: Db, ctx: Context, given: SemanticCandidate): Checked<string | null> {
  if (given.claimId === null) return { ok: true, value: null };
  const claim = db.prepare('SELECT audience_id FROM claims WHERE id = ?').get(given.claimId);
  if (!claim || !allowedAudience(claim, ctx)) return refused('stale_base');
  if (newestClaimVersion(db, given.claimId) !== given.baseVersionId) return refused('stale_base');
  return { ok: true, value: String(claim.audience_id) };
}

function validateAssertion(db: Db, ctx: Context, given: SemanticCandidate, read: SemanticReadSet) {
  if (!onlyFields(given, ASSERTION_FIELDS)) return refused('unknown_field');
  const shape = isObject(given.predicate) ? readPredicate(db, given.predicate.id, given.predicate.version) : null;
  if (!shape) return refused('unknown_predicate');
  if (shape.assertionKind !== given.assertionKind) return refused('bad_assertion_kind');
  const fields = checkShape(given);
  if (fields !== null) return refused(fields);
  const roles = checkArguments(shape, given.arguments);
  if (!roles.ok) return roles;
  const evidence = checkEvidence(db, ctx, given.evidence, read);
  if (!evidence.ok) return evidence;
  const endpoints = checkEndpoints(db, ctx, given.arguments);
  if (!endpoints.ok) return endpoints;
  if (shape.id === LABEL_PREDICATE) {
    const label = checkLabel(given);
    if (label !== null) return refused(label);
  }
  if (shape.id === EQUIVALENCE_PREDICATE) {
    const equivalence = checkEquivalence(db, ctx, given);
    if (equivalence !== null) return refused(equivalence);
  }
  const base = checkBase(db, ctx, given);
  if (!base.ok) return base;
  const premises = checkPremises(db, ctx, given.dependencies, read, given.claimId);
  if (!premises.ok) return premises;
  const audience = resolveAudience(db, ctx, [...evidence.value, ...endpoints.value, ...premises.value]);
  const forks = base.value !== null && base.value !== audience.audienceId;
  const resolved: ResolvedAssertion = {
    ...given,
    kind: 'assertion',
    claimId: forks ? null : given.claimId,
    derivedFrom: forks ? given.claimId : null,
    ...audience,
  };
  return { ok: true as const, resolved };
}

/**
 * Resolves one candidate or refuses it with a stable code; nothing is written. `read` is what the run was shown: a source
 * or a premise outside it is refused even when it exists. Throws without a valid context, like every memory read.
 */
export function validateSemanticCandidate(
  db: Db,
  ctx: Context,
  given: SemanticCandidate | SemanticEntityCandidate,
  read: SemanticReadSet
): { ok: true; resolved: ResolvedSemanticWrite } | SemanticRejection {
  audienceWhere(ctx);
  return 'name' in given ? validateEntity(db, ctx, given, read) : validateAssertion(db, ctx, given, read);
}

// ---------- the write ----------

type WriteDeps = { at: string; uuid: () => string };

const RESOLVED_ENTITY = new Set([
  'kind',
  'entityKind',
  'kindVersion',
  'name',
  'evidence',
  'dependencies',
  'audienceId',
  'scope',
]);
const RESOLVED_ASSERTION = new Set([...ASSERTION_FIELDS, 'kind', 'derivedFrom', 'audienceId', 'scope']);

/** The checks a resolved write must pass again on the writer: it may be old, and a message carries anything. */
function refuseForged(db: Db, given: unknown): asserts given is ResolvedSemanticWrite {
  if (!isObject(given) || typeof given.audienceId !== 'string' || !isObject(given.scope)) throw coded('BAD_SEMANTIC');
  if (given.kind === 'entity') {
    if (!onlyFields(given, RESOLVED_ENTITY)) throw coded('BAD_SEMANTIC');
    if (!readEntityKind(db, String(given.entityKind), Number(given.kindVersion))) throw coded('BAD_SEMANTIC');
  } else if (given.kind === 'assertion') {
    if (!onlyFields(given, RESOLVED_ASSERTION) || !isObject(given.predicate)) throw coded('BAD_SEMANTIC');
    const shape = readPredicate(db, String(given.predicate.id), Number(given.predicate.version));
    if (!shape || !checkArguments(shape, given.arguments as Array<SemanticArgument>).ok) throw coded('BAD_SEMANTIC');
  } else throw coded('BAD_SEMANTIC');
  const evidence = given.evidence;
  if (!Array.isArray(evidence) || evidence.length === 0 || !evidence.every(validEvidence)) throw coded('BAD_SEMANTIC');
  const stored = db.prepare('SELECT 1 AS ok FROM sources WHERE id = ?');
  if (!evidence.every((one) => stored.get(one.sourceId))) throw coded('BAD_SEMANTIC');
}

type Payload = {
  claimId: string | null;
  derivedFrom: string | null;
  assertionKind: string;
  predicate: { id: string; version: number };
  text: string;
  arguments: ReadonlyArray<SemanticArgument>;
  evidence: ReadonlyArray<SemanticEvidence>;
  dependencies: ReadonlyArray<SemanticDependency>;
  polarity: string;
  state: string;
  how: string;
  validFrom: string | null;
  validTo: string | null;
  audienceId: string;
  scope: ResolvedEntity['scope'];
};

/** A new claim row: `semantic` as its subject kind, so the readers of people's and places' prose never meet it. */
function insertClaim(db: Db, payload: Payload, { at, uuid }: WriteDeps): string {
  const id = `clm:${uuid()}`;
  const subject = payload.arguments.find((one) => 'ref' in one);
  db.prepare(
    `INSERT INTO claims (id, subject_kind, subject_id, kind, text, extra, first_seen_at, last_seen_at, how, author, truth, shown,
       scope_kind, scope_iface, scope_dm, created_at, audience_id)
     VALUES (?, 'semantic', ?, ?, ?, ?, ?, ?, ?, 'her', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    subject && 'ref' in subject ? subject.ref.id : null,
    payload.assertionKind,
    payload.text,
    payload.derivedFrom === null ? null : JSON.stringify({ derivedFrom: payload.derivedFrom }),
    at,
    at,
    payload.how,
    payload.state,
    payload.state === 'retired' ? 0 : 1,
    payload.scope.scope_kind,
    payload.scope.scope_iface,
    payload.scope.scope_dm,
    at,
    payload.audienceId
  );
  return id;
}

/** The parent's current words follow the newest version; every version keeps its own. */
function updateClaim(db: Db, claimId: string, payload: Payload, at: string): void {
  db.prepare('UPDATE claims SET text = ?, how = ?, truth = ?, shown = ?, last_seen_at = ? WHERE id = ?').run(
    payload.text,
    payload.how,
    payload.state,
    payload.state === 'retired' ? 0 : 1,
    at,
    claimId
  );
  takeOverClaim(db, claimId);
}

function insertArguments(db: Db, versionId: string, given: ReadonlyArray<SemanticArgument>): void {
  const insert = db.prepare(
    'INSERT INTO semantic_arguments (version_id, role, position, ref_kind, ref_id, literal_json) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const one of given) {
    if ('ref' in one) insert.run(versionId, one.role, one.position, one.ref.kind, one.ref.id, null);
    else insert.run(versionId, one.role, one.position, null, null, JSON.stringify(one.literal));
  }
}

/** One assertion in the seal's order: rows, evidence, arguments and premises, the immutable row, then what derives from it. */
function writeAssertion(db: Db, payload: Payload, deps: WriteDeps): { claimId: string; versionId: string } {
  const { at, uuid } = deps;
  ensureAudience(db, { ...payload.scope, audience_id: payload.audienceId }, { at });
  const claimId = payload.claimId ?? insertClaim(db, payload, deps);
  if (payload.claimId !== null) updateClaim(db, claimId, payload, at);
  const versionId = `cv:${uuid()}`;
  db.prepare(
    `INSERT INTO claim_versions (id, claim_id, revision_id, text, recorded_at, event, by, origin)
     VALUES (?, ?, ?, ?, ?, ?, 'her', 'session')`
  ).run(
    versionId,
    claimId,
    `rv:${uuid()}`,
    payload.text,
    at,
    payload.state === 'retired' ? 'retire' : payload.claimId === null ? 'add' : 'revise'
  );
  const link = db.prepare(
    'INSERT OR IGNORE INTO claim_version_sources (version_id, source_id, role, legacy) VALUES (?, ?, ?, 0)'
  );
  const held = db.prepare('SELECT COUNT(*) AS n FROM claim_sources WHERE claim_id = ?').get(claimId);
  let position = Number(held?.n ?? 0);
  const claimLink = db.prepare('INSERT INTO claim_sources (claim_id, source_id, position) VALUES (?, ?, ?)');
  const live = db.prepare(
    'SELECT 1 AS ok FROM claim_sources WHERE claim_id = ? AND source_id = ? AND retired_at IS NULL'
  );
  for (const one of payload.evidence) {
    link.run(versionId, one.sourceId, one.role);
    if (!live.get(claimId, one.sourceId)) claimLink.run(claimId, one.sourceId, position++);
  }
  insertArguments(db, versionId, payload.arguments);
  const premise = db.prepare(
    'INSERT INTO semantic_dependencies (version_id, premise_version_id, role) VALUES (?, ?, ?)'
  );
  for (const one of payload.dependencies) premise.run(versionId, one.versionId, one.role);
  db.prepare(
    `INSERT INTO semantic_assertion_versions (version_id, format_version, assertion_kind, predicate_id, predicate_version, truth_state,
       how, polarity, valid_from_at, valid_to_at, recorded_at, audience_id, historical_metadata_complete)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(
    versionId,
    payload.assertionKind,
    payload.predicate.id,
    payload.predicate.version,
    payload.state,
    payload.how,
    payload.polarity,
    payload.validFrom,
    payload.validTo,
    at,
    payload.audienceId
  );
  projectSealedVersion(db, versionId, payload.predicate.id);
  writeSearchDocument(db, {
    versionId,
    claimId,
    text: payload.text,
    arguments: payload.arguments,
    audienceId: payload.audienceId,
  });
  projectRow(db, 'claims', { id: claimId }, { at });
  return { claimId, versionId };
}

function writeEntity(db: Db, resolved: ResolvedEntity, deps: WriteDeps): SemanticWriteResult {
  const entityId = `ent:${deps.uuid()}`;
  db.prepare('INSERT INTO semantic_entities (id, kind, kind_version, created_at) VALUES (?, ?, ?, ?)').run(
    entityId,
    resolved.entityKind,
    resolved.kindVersion,
    deps.at
  );
  projectRow(db, 'semantic_entities', { id: entityId }, { at: deps.at });
  const written = writeAssertion(
    db,
    {
      claimId: null,
      derivedFrom: null,
      assertionKind: 'label',
      predicate: { id: LABEL_PREDICATE, version: 1 },
      text: resolved.name.text,
      arguments: [
        { role: 'entity', position: 0, ref: { kind: 'entity', id: entityId } },
        { role: 'name', position: 0, literal: resolved.name.text },
        { role: 'language', position: 0, literal: resolved.name.language },
      ],
      evidence: resolved.evidence,
      dependencies: resolved.dependencies,
      polarity: 'positive',
      state: 'current',
      how: 'said',
      validFrom: null,
      validTo: null,
      audienceId: resolved.audienceId,
      scope: resolved.scope,
    },
    deps
  );
  return { kind: 'entity', entityId, ...written };
}

/** A resolved write on a connection inside a transaction; a stale base is refused and nothing is written. */
function writeResolved(db: Db, resolved: unknown, deps: WriteDeps): SemanticWriteResult | SemanticRejection {
  refuseForged(db, resolved);
  if (resolved.kind === 'entity') return writeEntity(db, resolved, deps);
  // Compare-and-set in the writer: a fork names its base through `derivedFrom`, and that claim must not have moved.
  const target = resolved.claimId ?? resolved.derivedFrom;
  if (target !== null && newestClaimVersion(db, target) !== resolved.baseVersionId) return refused('stale_base');
  return { kind: 'assertion', ...writeAssertion(db, resolved, deps) };
}

// ---------- the session's operations ----------

/** What a session's operations share: the context, what the request showed, the handles of this answer's new entities. */
export type SessionSemantics = {
  ctx: Context;
  read: SemanticReadSet;
  handles: Map<string, string>;
  at: string;
  uuid: () => string;
};

const supporting = (sources: unknown): Array<SemanticEvidence> =>
  (sources as Array<string>).map((sourceId) => ({ sourceId, role: 'supports' }));

/** The newest registered version of an entity kind; a kind nobody registered is refused by the validation. */
const newestKindVersion = (db: Db, kind: unknown): number =>
  Number(db.prepare('SELECT MAX(version) AS v FROM semantic_entity_kinds WHERE id = ?').get(kind)?.v ?? 1);

/** One `entities` op of a validated answer, in the session write's transaction. */
export function writeSessionEntity(
  db: Db,
  op: Row,
  session: SessionSemantics
): { ok: true; result: SemanticWriteResult } | SemanticRejection {
  const checked = validateSemanticCandidate(
    db,
    session.ctx,
    {
      kind: String(op.kind),
      kindVersion: newestKindVersion(db, op.kind),
      name: { text: String(op.name), language: String(op.language) },
      evidence: supporting(op.sources),
      dependencies: [],
    },
    session.read
  );
  if (!checked.ok) return checked;
  const result = writeResolved(db, checked.resolved, session);
  if ('ok' in result) return result;
  if (result.kind === 'entity') session.handles.set(String(op.handle), result.entityId);
  return { ok: true, result };
}

/** An argument of the answer with a handle of this answer resolved to its entity; null when that entity was refused. */
function argumentOf(given: Row, handles: ReadonlyMap<string, string>): SemanticArgument | null {
  const { role, position } = given as { role: string; position: number };
  const ref = given.ref as (SemanticRef & { handle?: undefined }) | { handle: string } | undefined;
  if (ref === undefined) return { role, position, literal: given.literal as null };
  if (!('handle' in ref) || ref.handle === undefined) return { role, position, ref };
  const entity = handles.get(ref.handle);
  return entity === undefined ? null : { role, position, ref: { kind: 'entity', id: entity } };
}

/** One `assertions` op of a validated answer, in the session write's transaction. */
export function writeSessionAssertion(
  db: Db,
  op: Row,
  session: SessionSemantics
): { ok: true; result: SemanticWriteResult } | SemanticRejection {
  const given = (op.arguments as Array<Row>).map((one) => argumentOf(one, session.handles));
  if (given.some((one) => one === null)) return refused('unknown_ref');
  const checked = validateSemanticCandidate(
    db,
    session.ctx,
    {
      claimId: (op.claimId ?? null) as string | null,
      baseVersionId: (op.baseVersionId ?? null) as string | null,
      assertionKind: op.assertionKind as SemanticCandidate['assertionKind'],
      predicate: op.predicate as SemanticCandidate['predicate'],
      text: op.text as string,
      arguments: given as Array<SemanticArgument>,
      evidence: (op.evidence ?? supporting(op.sources)) as Array<SemanticEvidence>,
      dependencies: (op.dependencies ?? []) as Array<SemanticDependency>,
      polarity: op.polarity as SemanticCandidate['polarity'],
      state: op.state as SemanticCandidate['state'],
      how: op.how as string,
      validFrom: (op.validFrom ?? null) as string | null,
      validTo: (op.validTo ?? null) as string | null,
    },
    session.read
  );
  if (!checked.ok) return checked;
  const result = writeResolved(db, checked.resolved, session);
  return 'ok' in result ? result : { ok: true, result };
}
