// The description review (plan 2026-10-20-memory-f, section 9; docs/prompt-contract.md, "Description review"): she
// rewrites her account of one subject (a person, a place or herself) in one field, in two calls.
//
//   Call 1 (prompts/description-draft.md): the system text her turns get, then <subject> (who, which field, the display
//   cap), <claims> (every claim of the subject with its dates and whether it is shown or historical), <evidence> (what
//   changed since the last review, with sources and dates) and <samples> (lines from older periods, spread over time).
//   The old description text is NOT sent. Answer: <description> and <reason>.
//   Call 2 (prompts/description-check.md): <draft>, <current> (the stored description, empty when there is none) and
//   <diff> (the claims the stored text showed and the draft does not, and the reverse). Answer: <description> (final)
//   and <reason>.
//
// A claim "is shown" by a text when the text carries most of the claim's words (the claim-level diff is a text match,
// not a model call). The draft and the final go into one `description_versions` row (the draft rides in `extra`, with
// the exact evidence and claim ids both calls were given, the model, the hash of both prompts and the `sources` rows
// that hold her two whole answers as they came). A final over the display cap is stored as it came with
// `extra.overCap`; nothing is cut or rewritten by the engine.
//   - shadow: origin `shadow`, never current, and it does not move the "last reviewed" mark the next review reads.
//   - apply (`memoryDb.session.mode` `apply`): origin `review`, and the same
//     transaction moves `descriptions.current_version` to it (session-write.ts).
// A description is identified by its scope as well as its subject and field: the id of one this module creates is
// `desc:<scope>:<subject>:<field>`; a stored row of the same subject, field and scope keeps the id it has.
//
// reviewDescription(db, subject, field, { ctx }) -> { status, code?, draft?, final?, reason?, row? }
//   subject: { kind: 'person' | 'place' | 'self' | 'entity', id, name? }
//            An entity's claims are the assertions that name it, read under the review's own context.
//   ctx:     { llm, hot ({ config, prompts }), env, now, write, log, selfName, readCtx (a scope context, group by default) }
//   The review reads (and finds its description) through `audience_id`, not the triple.

import { MEMORY_ROLE, roleModel } from '../../llm/roles.ts';
import { MEMORY_LIMITS, RELATIONSHIP_LIMITS } from '../text-limits.ts';
import { shortHash } from './ids.ts';
import { namedIface } from './live-iface.ts';
import { audienceOf, dmScope, groupContext, groupScope, scopeWhere } from './scope.ts';
import type { MemoryPath } from '../../subharness/memory-path.ts';
import { CODES, DESCRIPTION_FIELDS, memoryKeyState, sessionSettings, stamp, systemTextOf } from './session.ts';
import { block } from '../../behavior/prompt.ts';
import { asText } from './types.ts';
import type { Config, Db, Row } from './types.ts';
import type { KeyRing } from '../../keys/ring.ts';
import type { Context, Scope } from './scope.ts';
import { CURRENT_REVISION, LINE_KIND, LINE_MOMENT, LINE_ROWID } from './source-current.ts';
import type { Completion, SessionContext } from './session.ts';

export const DRAFT_PURPOSE = 'description-draft';
export const CHECK_PURPOSE = 'description-check';
const EVIDENCE_MAX = 40;
const SAMPLES_MAX = 8;
// The latest lines a place review reads of the place and the places under it.
const PLACE_LINES = 40;
const SOURCES_PER_ITEM = 3;
const SOURCE_CHARS = 200;

const codeOf = (error: unknown): string => {
  const { code, name } = (error ?? {}) as { code?: string; name?: string };
  return code ?? name ?? 'ERROR';
};
const present = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

/** What a review is about: a person, a place or herself, by id (and name when it is known). */
export type ReviewSubject = { kind: string; id: string; name?: string };

/**
 * The display cap of a field, in characters: the limits the store applies to the same kind of text
 * (`relationships.textChars` for a relationship, twice `memory.fieldChars` for the server notes, `memory.fieldChars`
 * for a portrait; config.json's values when missing).
 */
export function fieldCap(config: Config, field: unknown): number {
  const fieldChars = MEMORY_LIMITS.fieldChars;
  if (field === 'relationship') return RELATIONSHIP_LIMITS.textChars;
  if (field === 'patterns' || field === 'starters') return fieldChars * 2;
  return fieldChars;
}

const wordsOf = (text: unknown): Array<string> => [
  ...new Set(
    asText(text ?? '')
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]{4,}/gu) ?? []
  ),
];

/** Whether `description` carries the claim: most of the claim's words (4 letters or more) occur in it. */
export function showsClaim(description: unknown, claim: Row): boolean {
  const words = wordsOf(claim.text);
  if (words.length === 0) return false;
  const haystack = asText(description ?? '')
    .normalize('NFKC')
    .toLowerCase();
  const found = words.filter((word) => haystack.includes(word)).length;
  return found / words.length >= 0.6;
}

/** The claim-level diff of two texts over a subject's claims: `{ lost, gained, kept }` (claims). */
export function claimDiff(
  claims: ReadonlyArray<Row>,
  before: unknown,
  after: unknown
): { lost: Array<Row>; gained: Array<Row>; kept: number } {
  const lost: Array<Row> = [];
  const gained: Array<Row> = [];
  let kept = 0;
  for (const claim of claims) {
    const was = showsClaim(before, claim);
    const is = showsClaim(after, claim);
    if (was && is) kept += 1;
    else if (was) lost.push(claim);
    else if (is) gained.push(claim);
  }
  return { lost, gained, kept };
}

const claimStatus = (claim: Row): string =>
  claim.shown === 1 && (claim.truth === 'current' || claim.truth === 'disputed')
    ? `shown, ${claim.truth}`
    : `historical${claim.valid_to ? ` since ${asText(claim.valid_to)}` : ''}, ${asText(claim.truth)}`;
const claimLine = (claim: Row): string =>
  `[${asText(claim.id)}] ${claim.kind ? `${asText(claim.kind)}: ` : ''}${asText(claim.text ?? '')
    .replace(/\s+/g, ' ')
    .trim()} (${[claim.first_seen_at, claim.last_seen_at].filter(Boolean).join(' to ') || 'undated'}; ${claimStatus(claim)})`;

/** The scope columns a review reads and writes in: the read context's own. */
export function scopeOfContext(readCtx: Context | undefined): Scope {
  return readCtx?.kind === 'dm'
    ? dmScope(readCtx.person as string, readCtx.iface as string)
    : groupScope(readCtx?.iface ?? null);
}

/**
 * The id of the description of `subject` and `field` in `scope`: the stored row's, else the scoped id of a new one.
 * `audienceColumn`: the stored row is found by its `audience_id` (the scope's audience, a DM's through the context's
 * place `dmPlace`), else by the triple.
 */
export function descriptionIdFor(
  db: Db,
  subject: { id: unknown },
  field: unknown,
  scope: Scope,
  { audienceColumn = false, dmPlace = null }: { audienceColumn?: boolean; dmPlace?: unknown } = {}
): string {
  const found =
    audienceColumn === true
      ? db
          .prepare(
            'SELECT id FROM descriptions WHERE subject_id = ? AND field = ? AND audience_id = ? AND retired_at IS NULL ORDER BY id LIMIT 1'
          )
          .get(subject.id, field, audienceOf(scope, { dmPlace }).audience_id)
      : db
          .prepare(
            `SELECT id FROM descriptions WHERE subject_id = ? AND field = ? AND scope_kind IS ? AND scope_iface IS ? AND scope_dm IS ? AND retired_at IS NULL ORDER BY id LIMIT 1`
          )
          .get(subject.id, field, scope.scope_kind, scope.scope_iface, scope.scope_dm);
  if (found) return found.id as string;
  const tag =
    scope.scope_kind === 'dm'
      ? `dm.${scope.scope_iface}.${scope.scope_dm}`
      : `${scope.scope_kind}.${scope.scope_iface}`;
  return `desc:${tag}:${asText(subject.id)}:${asText(field)}`;
}

function sourceLines(db: Db, claimId: unknown, timezone: unknown, seen: Set<unknown> | undefined): Array<string> {
  return db
    .prepare(
      `SELECT s.id, s.occurred_at, s.text FROM claim_sources cs JOIN sources s ON s.id = cs.source_id WHERE cs.claim_id = ? AND cs.retired_at IS NULL AND s.retired_at IS NULL
      ORDER BY cs.position LIMIT ?`
    )
    .all(claimId, SOURCES_PER_ITEM)
    .map((row) => {
      seen?.add(row.id);
      return `  source ${Number.isFinite(Date.parse(row.occurred_at as string)) ? stamp(Date.parse(row.occurred_at as string), timezone) : '?'}: ${asText(
        row.text ?? ''
      )
        .replace(/\s+/g, ' ')
        .slice(0, SOURCE_CHARS)}`;
    });
}

/** What the first call is given, from the database. */
/** What a review answers: how it ended, and on success the draft, the final text and the row written. */
export type ReviewResult = Row & {
  status: string;
  code?: string;
  step?: string;
  draft?: string;
  final?: string;
  reason?: string | null;
};

/** Which claims a subject's review reads: an entity's are the assertions that name it. Two parameters, kind and id. */
const claimsOfSubject = (kind: string): string =>
  kind === 'entity'
    ? `c.subject_kind = 'semantic' AND ? IS NOT NULL AND c.id IN (SELECT v.claim_id FROM semantic_arguments g
        JOIN claim_versions v ON v.id = g.version_id WHERE g.ref_kind = 'entity' AND g.ref_id = ?)`
    : 'c.subject_kind = ? AND c.subject_id = ?';

/** What the first call of a review is given, from the database. */
export type Gathered = {
  descriptionId: string;
  scope: Scope;
  claims: Array<Row>;
  byId: Map<unknown, Row>;
  current: string;
  currentVersion: unknown;
  last: string | null;
  evidence: Array<string>;
  evidenceClaims: Array<unknown>;
  sourceIds: Array<unknown>;
  samples: Array<string>;
  lines: Array<string>;
};

/**
 * The latest lines of a place and of the places under it that the context reads, oldest first, her own marked with her
 * name. A direct chat keeps what it is about in its lines more than in claims about the place.
 */
function placeLines(
  db: Db,
  subject: { kind: string; id: string },
  readCtx: Context,
  timezone: unknown,
  selfName: string,
  seen: Set<unknown>
) {
  if (subject.kind !== 'place') return [];
  const scope = scopeWhere(readCtx, 's');
  const rows = db
    .prepare(
      `WITH RECURSIVE under(id) AS (SELECT ? UNION SELECT p.id FROM places p JOIN under u ON p.parent_id = u.id)
      SELECT s.id, ${LINE_KIND} AS kind, ${LINE_MOMENT} AS occurred_at, s.text FROM sources s JOIN under u ON u.id = s.place_id
      WHERE ${CURRENT_REVISION} AND ${scope.sql}
      ORDER BY ${LINE_MOMENT} DESC, ${LINE_ROWID} DESC LIMIT ?`
    )
    .all(subject.id, ...scope.params, PLACE_LINES);
  return rows.reverse().map((row) => {
    seen.add(row.id);
    const at = Date.parse(row.occurred_at as string);
    const who = row.kind === 'said' && selfName ? `${selfName}: ` : '';
    return `${Number.isFinite(at) ? stamp(at, timezone) : '?'}: ${who}${asText(row.text ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, SOURCE_CHARS)}`;
  });
}

export function gatherReview(
  db: Db,
  subject: { kind: string; id: string },
  field: unknown,
  { config, readCtx, selfName = '' }: { config: Config; readCtx: Context; selfName?: string }
): Gathered {
  const scopeColumns = scopeOfContext(readCtx);
  const descriptionId = descriptionIdFor(db, subject, field, scopeColumns, {
    audienceColumn: readCtx?.audienceColumn === true,
    dmPlace: readCtx.place,
  });
  const sourceIds = new Set<unknown>();
  const timezone = config?.bot?.timezone ?? 'UTC';
  const scope = scopeWhere(readCtx, 'c');
  const claims = db
    .prepare(
      `SELECT c.id, c.kind, c.text, c.first_seen_at, c.last_seen_at, c.valid_to, c.truth, c.shown FROM claims c
      WHERE ${claimsOfSubject(subject.kind)} AND c.retired_at IS NULL AND ${scope.sql} ORDER BY c.first_seen_at, c.id LIMIT 300`
    )
    .all(subject.kind, subject.id, ...scope.params);
  const currentRow = db
    .prepare(
      `SELECT d.current_version AS id, v.text FROM descriptions d JOIN description_versions v ON v.id = d.current_version WHERE d.id = ? AND d.retired_at IS NULL`
    )
    .get(descriptionId);
  const current = (currentRow?.text as string | undefined) ?? '';
  const currentVersion =
    db.prepare('SELECT current_version FROM descriptions WHERE id = ?').get(descriptionId)?.current_version ?? null;
  // "Last reviewed" is the accepted path's mark: a shadow review never moves it.
  const last =
    (db
      .prepare(
        "SELECT MAX(written_at) AS at FROM description_versions WHERE description_id = ? AND retired_at IS NULL AND written_at IS NOT NULL AND origin IS NOT 'shadow'"
      )
      .get(descriptionId)?.at as string | null | undefined) ?? null;

  const byId = new Map(claims.map((claim): [unknown, Row] => [claim.id, claim]));
  const evidence: Array<string> = [];
  const evidenceClaims = new Set<unknown>();
  if (claims.length > 0) {
    const marks = claims.map(() => '?').join(', ');
    const versions = db
      .prepare(
        `SELECT claim_id, event, text, recorded_at FROM claim_versions WHERE claim_id IN (${marks}) AND retired_at IS NULL
        ${last ? 'AND recorded_at > ?' : ''} ORDER BY recorded_at DESC, rowid DESC LIMIT ?`
      )
      .all(...claims.map((claim) => claim.id), ...(last ? [last] : []), EVIDENCE_MAX);
    for (const version of versions.reverse()) {
      evidenceClaims.add(version.claim_id);
      evidence.push(
        `${asText(version.recorded_at ?? 'undated')} ${asText(version.event)} [${asText(version.claim_id)}] ${asText(version.text ?? '').replace(/\s+/g, ' ')}`,
        ...sourceLines(db, version.claim_id, timezone, sourceIds)
      );
    }
    // A claim the sync brought in without versions: it counts as evidence when it was seen after the last review.
    for (const claim of claims) {
      if (evidenceClaims.has(claim.id) || evidence.length >= EVIDENCE_MAX * 2) continue;
      const seen = claim.last_seen_at ?? claim.first_seen_at;
      if (last && (!seen || (seen as string) <= last.slice(0, (seen as string).length))) continue;
      evidenceClaims.add(claim.id);
      evidence.push(
        `${asText(seen ?? 'undated')} seen [${asText(claim.id)}] ${asText(claim.text ?? '').replace(/\s+/g, ' ')}`,
        ...sourceLines(db, claim.id, timezone, sourceIds)
      );
    }
  }
  // Samples: lines from the other claims, spread over time.
  const sampled: Array<{ id: unknown; at: string; text: unknown }> = [];
  const pool: Array<{ id: unknown; at: string; text: unknown }> = [];
  for (const claim of claims) {
    if (evidenceClaims.has(claim.id)) continue;
    for (const row of db
      .prepare(
        `SELECT s.id, s.occurred_at, s.text FROM claim_sources cs JOIN sources s ON s.id = cs.source_id WHERE cs.claim_id = ? AND cs.retired_at IS NULL AND s.retired_at IS NULL ORDER BY cs.position LIMIT 1`
      )
      .all(claim.id))
      pool.push({ id: row.id, at: (row.occurred_at as string | null) ?? '', text: row.text });
  }
  pool.sort((a, b) => a.at.localeCompare(b.at));
  if (pool.length <= SAMPLES_MAX) sampled.push(...pool);
  else
    for (let i = 0; i < SAMPLES_MAX; i += 1)
      sampled.push(pool[Math.floor((i * (pool.length - 1)) / (SAMPLES_MAX - 1))]);
  for (const row of sampled) sourceIds.add(row.id);
  const samples = sampled.map(
    (row) =>
      `${Number.isFinite(Date.parse(row.at)) ? stamp(Date.parse(row.at), timezone) : '?'}: ${asText(row.text ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, SOURCE_CHARS)}`
  );
  const lines = placeLines(db, subject, readCtx, timezone, selfName, sourceIds);
  return {
    descriptionId,
    scope: scopeColumns,
    claims,
    byId,
    current,
    currentVersion,
    last,
    evidence,
    evidenceClaims: [...evidenceClaims],
    sourceIds: [...sourceIds],
    samples,
    lines,
  };
}

/** `<description>` and `<reason>` of an answer (the thinking removed); null when the description is missing or empty. */
export function parseDescriptionAnswer(text: unknown): { description: string; reason: string } | null {
  const raw = asText(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const pick = (tag: string): string | null => {
    const open = raw.lastIndexOf(`<${tag}>`);
    if (open === -1) return null;
    let body = raw.slice(open + tag.length + 2);
    const close = body.indexOf(`</${tag}>`);
    if (close !== -1) body = body.slice(0, close);
    return body.trim();
  };
  const description = pick('description');
  if (!description) return null;
  return { description, reason: pick('reason') ?? '' };
}

/** Why a review cannot run now, or null. */
export function reviewRefusal(
  config: Config | null | undefined,
  env: Row | null | undefined,
  prompts: Row | null | undefined,
  ring?: KeyRing | null,
  path?: MemoryPath | null
): string | null {
  if (sessionSettings(config).mode === 'off') return CODES.OFF;
  if (!memoryKeyState(config, env, ring, path).ok) return CODES.NOT_CONFIGURED;
  if (!present(prompts?.[DRAFT_PURPOSE]) || !present(prompts?.[CHECK_PURPOSE])) return CODES.NO_PROMPT;
  return null;
}

/** One request on the memory role with the session's limits: the review's two calls and the bind's merge (person-bind.ts). */
export async function askMemoryModel(
  ctx: Pick<SessionContext, 'llm' | 'hot'>,
  messages: ReadonlyArray<Row>,
  { purpose, maxOutputTokens }: { purpose: string; maxOutputTokens: number }
): Promise<Completion> {
  const config = ctx.hot.config;
  return ctx.llm.complete(messages, {
    role: MEMORY_ROLE,
    purpose,
    model: roleModel(config, MEMORY_ROLE),
    maxOutputTokens,
    timeoutMs: sessionSettings(config).timeoutMs,
    skipCalibration: true,
    cache: false,
    origin: purpose,
  });
}

/**
 * Reviews one description (see the head of this file). Never throws: a refusal, a failed call or an unreadable answer
 * comes back as `{ status, code }` and writes nothing.
 */
export async function reviewDescription(
  db: Db,
  subject: ReviewSubject,
  field: string,
  { ctx }: { ctx: SessionContext }
): Promise<ReviewResult> {
  const config = ctx.hot.config;
  const prompts = ctx.hot.prompts;
  const log = ctx.log ?? {};
  const now = ctx.now ?? Date.now;
  const refused = reviewRefusal(config, ctx.env, prompts, ctx.ring, ctx.path?.());
  if (refused) return { status: refused === CODES.OFF ? 'off' : 'refused', code: refused };
  if (
    !DESCRIPTION_FIELDS.includes(field) ||
    !subject?.id ||
    !['person', 'place', 'self', 'entity'].includes(subject.kind)
  )
    return { status: 'refused', code: 'bad_subject' };
  // Read through `audience_id`, as every context the core issues reads.
  const readCtx: Context = { ...(ctx.readCtx ?? groupContext(namedIface(ctx))), audienceColumn: true };
  const settings = sessionSettings(config);
  const cap = fieldCap(config, field);
  const selfName = ctx.selfName ?? '';
  const gathered = gatherReview(db, subject, field, { config, readCtx, selfName });
  const tokens = { prompt: 0, completion: 0 };
  const add = (completion: Completion): void => {
    tokens.prompt += Number(completion?.usage?.prompt_tokens) || 0;
    tokens.completion += Number(completion?.usage?.completion_tokens) || 0;
  };

  // Call 1: the draft, from the claims, the evidence and, for a place, its latest lines.
  const subjectBody = [
    `subject: ${subject.name ?? subject.id}`,
    `kind: ${subject.kind}`,
    `field: ${field}`,
    `cap: ${cap} characters`,
  ].join('\n');
  const draftUser = [
    block('subject', subjectBody),
    block('claims', gathered.claims.map(claimLine).join('\n')),
    block('evidence', gathered.evidence.join('\n')),
    block('samples', gathered.samples.join('\n')),
    block('lines', gathered.lines.join('\n')),
  ]
    .filter(Boolean)
    .join('\n\n');
  let draft: { description: string; reason: string } | null;
  const answers: Array<{ purpose: string; text: string }> = [];
  try {
    const completion = await askMemoryModel(
      ctx,
      [
        { role: 'system', content: systemTextOf(prompts, selfName, prompts?.[DRAFT_PURPOSE]) },
        { role: 'user', content: draftUser },
      ],
      { purpose: DRAFT_PURPOSE, maxOutputTokens: settings.descriptionMaxOutputTokens }
    );
    add(completion);
    if (typeof completion?.text === 'string') answers.push({ purpose: DRAFT_PURPOSE, text: completion.text });
    draft = parseDescriptionAnswer(completion?.text);
  } catch (error) {
    log.warn?.('description review: draft failed', { code: codeOf(error) });
    return { status: 'failed', code: codeOf(error), step: 'draft' };
  }
  if (!draft) return { status: 'failed', code: 'bad_answer', step: 'draft' };

  // Call 2: the check, against the stored text and the claim-level diff.
  const draftDiff = claimDiff(gathered.claims, gathered.current, draft.description);
  const diffBody = [
    draftDiff.lost.length
      ? `the old text showed, the draft does not:\n${draftDiff.lost.map(claimLine).join('\n')}`
      : '',
    draftDiff.gained.length
      ? `the draft shows, the old text did not:\n${draftDiff.gained.map(claimLine).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const checkUser = [block('draft', draft.description), block('current', gathered.current), block('diff', diffBody)]
    .filter(Boolean)
    .join('\n\n');
  let final: { description: string; reason: string } | null;
  try {
    const completion = await askMemoryModel(
      ctx,
      [
        { role: 'system', content: systemTextOf(prompts, selfName, prompts?.[CHECK_PURPOSE]) },
        { role: 'user', content: checkUser },
      ],
      { purpose: CHECK_PURPOSE, maxOutputTokens: settings.descriptionMaxOutputTokens }
    );
    add(completion);
    if (typeof completion?.text === 'string') answers.push({ purpose: CHECK_PURPOSE, text: completion.text });
    final = parseDescriptionAnswer(completion?.text);
  } catch (error) {
    log.warn?.('description review: check failed', { code: codeOf(error) });
    return { status: 'failed', code: codeOf(error), step: 'check' };
  }
  if (!final) return { status: 'failed', code: 'bad_answer', step: 'check' };

  const at = now();
  const change = claimDiff(gathered.claims, gathered.current, final.description);
  const chars = [...final.description].length;
  const row = {
    id: `dv:${gathered.descriptionId}:${shortHash(at, final.description)}`,
    descriptionId: gathered.descriptionId,
    text: final.description,
    writtenAt: new Date(at).toISOString(),
    kept: change.kept,
    removed: change.lost.length,
    added: change.gained.length,
    reason: final.reason || draft.reason || null,
    extra: {
      draft: draft.description,
      draftReason: draft.reason || null,
      cap,
      ...(chars > cap ? { overCap: chars } : {}),
      model: roleModel(config, MEMORY_ROLE),
      prompts: { draft: shortHash(prompts?.[DRAFT_PURPOSE]), check: shortHash(prompts?.[CHECK_PURPOSE]) },
      tokens,
      sinceReview: gathered.last,
      basedOn: gathered.currentVersion,
      claimIds: gathered.claims.map((claim) => claim.id),
      evidenceClaimIds: gathered.evidenceClaims,
      evidenceSourceIds: gathered.sourceIds,
      evidence: gathered.evidence,
      samples: gathered.samples,
      diff: { lost: draftDiff.lost.map((claim) => claim.id), gained: draftDiff.gained.map((claim) => claim.id) },
    },
  };
  try {
    await ctx.write({
      kind: 'description',
      mode: settings.mode,
      row,
      subject: { kind: subject.kind, id: subject.id, field },
      scope: gathered.scope,
      expectCurrent: gathered.currentVersion,
      answers,
      now: at,
    });
  } catch (error) {
    log.warn?.('description review: write failed', { code: codeOf(error) });
    return { status: 'failed', code: codeOf(error), step: 'write' };
  }
  return { status: 'ok', draft: draft.description, final: final.description, reason: row.reason, row };
}
