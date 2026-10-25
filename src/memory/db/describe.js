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
// that hold her two whole answers, `<think>` included). A final over the display cap is stored as it came with
// `extra.overCap`; nothing is cut or rewritten by the engine.
//   - shadow: origin `shadow`, never current, and it does not move the "last reviewed" mark the next review reads.
//   - apply (`memoryDb.session.mode` `apply`): origin `review`, and the same
//     transaction moves `descriptions.current_version` to it (session-write.js).
// A description is identified by its scope as well as its subject and field: the id of one this module creates is
// `desc:<scope>:<subject>:<field>`; a stored row of the same subject, field and scope keeps the id it has.
//
// reviewDescription(db, subject, field, { ctx }) -> { status, code?, draft?, final?, reason?, row? }
//   subject: { kind: 'person' | 'place' | 'self', id, name? }
//   ctx:     { llm, hot ({ config, prompts }), env, now, write, log, selfName, readCtx (a scope context, group by default) }
//   With `memoryDb.audienceColumn` the review reads (and finds its description) through `audience_id`, not the triple.

import { MEMORY_ROLE, roleModel } from '../../llm/roles.js';
import { MEMORY_LIMIT_DEFAULTS } from '../text-limits.js';
import { shortHash } from './ids.js';
import { audienceOf, dmScope, groupContext, groupScope, scopeWhere } from './scope.js';
import { CODES, DESCRIPTION_FIELDS, memoryKeyState, sessionSettings, stamp, systemTextOf } from './session.js';
import { block } from '../../behavior/prompt.js';

export const DRAFT_PURPOSE = 'description-draft';
export const CHECK_PURPOSE = 'description-check';
const EVIDENCE_MAX = 40;
const SAMPLES_MAX = 8;
const SOURCES_PER_ITEM = 3;
const SOURCE_CHARS = 200;

const codeOf = (error) => error?.code ?? error?.name ?? 'ERROR';
const present = (value) => typeof value === 'string' && value.trim() !== '';

/** A finite number above 0, else `fallback`. */
const positive = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback);

/**
 * The display cap of a field, in characters: the limits the store applies to the same kind of text
 * (`relationships.textChars` for a relationship, twice `memory.fieldChars` for the server notes, `memory.fieldChars`
 * for a portrait; config.json's values when missing).
 */
export function fieldCap(config, field) {
  const fieldChars = positive(config?.memory?.fieldChars, MEMORY_LIMIT_DEFAULTS.fieldChars);
  if (field === 'relationship') return positive(config?.relationships?.textChars, MEMORY_LIMIT_DEFAULTS.relationshipChars);
  if (field === 'patterns' || field === 'starters') return fieldChars * 2;
  return fieldChars;
}

const wordsOf = (text) => [...new Set(String(text ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])];

/** Whether `description` carries the claim: most of the claim's words (4 letters or more) occur in it. */
export function showsClaim(description, claim) {
  const words = wordsOf(claim.text);
  if (words.length === 0) return false;
  const haystack = String(description ?? '').normalize('NFKC').toLowerCase();
  const found = words.filter((word) => haystack.includes(word)).length;
  return found / words.length >= 0.6;
}

/** The claim-level diff of two texts over a subject's claims: `{ lost, gained, kept }` (claims). */
export function claimDiff(claims, before, after) {
  const lost = [];
  const gained = [];
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

const claimStatus = (claim) => (claim.shown === 1 && (claim.truth === 'current' || claim.truth === 'disputed') ? `shown, ${claim.truth}` : `historical${claim.valid_to ? ` since ${claim.valid_to}` : ''}, ${claim.truth}`);
const claimLine = (claim) => `[${claim.id}] ${claim.kind ? `${claim.kind}: ` : ''}${String(claim.text ?? '').replace(/\s+/g, ' ').trim()} (${[claim.first_seen_at, claim.last_seen_at].filter(Boolean).join(' to ') || 'undated'}; ${claimStatus(claim)})`;

/** The scope columns a review reads and writes in: the read context's own. */
export function scopeOfContext(readCtx) {
  return readCtx?.kind === 'dm' ? dmScope(readCtx.person, readCtx.iface) : groupScope(readCtx?.iface);
}

/**
 * The id of the description of `subject` and `field` in `scope`: the stored row's, else the scoped id of a new one.
 * `audienceColumn`: the stored row is found by its `audience_id` (the scope's audience), else by the triple.
 */
export function descriptionIdFor(db, subject, field, scope, { audienceColumn = false } = {}) {
  const found = audienceColumn === true
    ? db.prepare('SELECT id FROM descriptions WHERE subject_id = ? AND field = ? AND audience_id = ? AND retired_at IS NULL ORDER BY id LIMIT 1')
      .get(subject.id, field, audienceOf(scope).audience_id)
    : db.prepare(
      `SELECT id FROM descriptions WHERE subject_id = ? AND field = ? AND scope_kind IS ? AND scope_iface IS ? AND scope_dm IS ? AND retired_at IS NULL ORDER BY id LIMIT 1`,
    ).get(subject.id, field, scope.scope_kind, scope.scope_iface, scope.scope_dm);
  if (found) return found.id;
  const tag = scope.scope_kind === 'dm' ? `dm.${scope.scope_iface}.${scope.scope_dm}` : `${scope.scope_kind}.${scope.scope_iface}`;
  return `desc:${tag}:${subject.id}:${field}`;
}

function sourceLines(db, claimId, timezone, seen) {
  return db.prepare(
    `SELECT s.id, s.occurred_at, s.text FROM claim_sources cs JOIN sources s ON s.id = cs.source_id WHERE cs.claim_id = ? AND cs.retired_at IS NULL AND s.retired_at IS NULL
      ORDER BY cs.position LIMIT ?`,
  ).all(claimId, SOURCES_PER_ITEM).map((row) => {
    seen?.add(row.id);
    return `  source ${Number.isFinite(Date.parse(row.occurred_at)) ? stamp(Date.parse(row.occurred_at), timezone) : '?'}: ${String(row.text ?? '').replace(/\s+/g, ' ').slice(0, SOURCE_CHARS)}`;
  });
}

/** What the first call is given, from the database. */
export function gatherReview(db, subject, field, { config, readCtx }) {
  const scopeColumns = scopeOfContext(readCtx);
  const descriptionId = descriptionIdFor(db, subject, field, scopeColumns, { audienceColumn: readCtx?.audienceColumn === true });
  const sourceIds = new Set();
  const timezone = config?.bot?.timezone ?? 'UTC';
  const scope = scopeWhere(readCtx, 'c');
  const claims = db.prepare(
    `SELECT c.id, c.kind, c.text, c.first_seen_at, c.last_seen_at, c.valid_to, c.truth, c.shown FROM claims c
      WHERE c.subject_kind = ? AND c.subject_id = ? AND c.retired_at IS NULL AND ${scope.sql} ORDER BY c.first_seen_at, c.id LIMIT 300`,
  ).all(subject.kind, subject.id, ...scope.params);
  const currentRow = db.prepare(
    `SELECT d.current_version AS id, v.text FROM descriptions d JOIN description_versions v ON v.id = d.current_version WHERE d.id = ? AND d.retired_at IS NULL`,
  ).get(descriptionId);
  const current = currentRow?.text ?? '';
  const currentVersion = db.prepare('SELECT current_version FROM descriptions WHERE id = ?').get(descriptionId)?.current_version ?? null;
  // "Last reviewed" is the accepted path's mark: a shadow review never moves it.
  const last = db.prepare("SELECT MAX(written_at) AS at FROM description_versions WHERE description_id = ? AND retired_at IS NULL AND written_at IS NOT NULL AND origin IS NOT 'shadow'").get(descriptionId)?.at ?? null;

  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const evidence = [];
  const evidenceClaims = new Set();
  if (claims.length > 0) {
    const marks = claims.map(() => '?').join(', ');
    const versions = db.prepare(
      `SELECT claim_id, event, text, recorded_at FROM claim_versions WHERE claim_id IN (${marks}) AND retired_at IS NULL
        ${last ? 'AND recorded_at > ?' : ''} ORDER BY recorded_at DESC, rowid DESC LIMIT ?`,
    ).all(...claims.map((claim) => claim.id), ...(last ? [last] : []), EVIDENCE_MAX);
    for (const version of versions.reverse()) {
      evidenceClaims.add(version.claim_id);
      evidence.push(`${version.recorded_at ?? 'undated'} ${version.event} [${version.claim_id}] ${String(version.text ?? '').replace(/\s+/g, ' ')}`, ...sourceLines(db, version.claim_id, timezone, sourceIds));
    }
    // A claim the sync brought in without versions: it counts as evidence when it was seen after the last review.
    for (const claim of claims) {
      if (evidenceClaims.has(claim.id) || evidence.length >= EVIDENCE_MAX * 2) continue;
      const seen = claim.last_seen_at ?? claim.first_seen_at;
      if (last && (!seen || seen <= last.slice(0, seen.length))) continue;
      evidenceClaims.add(claim.id);
      evidence.push(`${seen ?? 'undated'} seen [${claim.id}] ${String(claim.text ?? '').replace(/\s+/g, ' ')}`, ...sourceLines(db, claim.id, timezone, sourceIds));
    }
  }
  // Samples: lines from the other claims, spread over time.
  const sampled = [];
  const pool = [];
  for (const claim of claims) {
    if (evidenceClaims.has(claim.id)) continue;
    for (const row of db.prepare(
      `SELECT s.id, s.occurred_at, s.text FROM claim_sources cs JOIN sources s ON s.id = cs.source_id WHERE cs.claim_id = ? AND cs.retired_at IS NULL AND s.retired_at IS NULL ORDER BY cs.position LIMIT 1`,
    ).all(claim.id)) pool.push({ id: row.id, at: row.occurred_at ?? '', text: row.text });
  }
  pool.sort((a, b) => a.at.localeCompare(b.at));
  if (pool.length <= SAMPLES_MAX) sampled.push(...pool);
  else for (let i = 0; i < SAMPLES_MAX; i += 1) sampled.push(pool[Math.floor((i * (pool.length - 1)) / (SAMPLES_MAX - 1))]);
  for (const row of sampled) sourceIds.add(row.id);
  const samples = sampled.map((row) => `${Number.isFinite(Date.parse(row.at)) ? stamp(Date.parse(row.at), timezone) : '?'}: ${String(row.text ?? '').replace(/\s+/g, ' ').slice(0, SOURCE_CHARS)}`);
  return { descriptionId, scope: scopeColumns, claims, byId, current, currentVersion, last, evidence, evidenceClaims: [...evidenceClaims], sourceIds: [...sourceIds], samples };
}

/** `<description>` and `<reason>` of an answer (the thinking removed); null when the description is missing or empty. */
export function parseDescriptionAnswer(text) {
  const raw = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const pick = (tag) => {
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
export function reviewRefusal(config, env, prompts) {
  if (sessionSettings(config).mode === 'off') return CODES.OFF;
  if (!memoryKeyState(config, env).ok) return CODES.NOT_CONFIGURED;
  if (!present(prompts?.[DRAFT_PURPOSE]) || !present(prompts?.[CHECK_PURPOSE])) return CODES.NO_PROMPT;
  return null;
}

async function ask(ctx, messages, { purpose, maxOutputTokens }) {
  const config = ctx.hot.config;
  return ctx.llm.complete(messages, {
    role: MEMORY_ROLE,
    purpose,
    model: roleModel(config, MEMORY_ROLE),
    maxOutputTokens,
    timeoutMs: sessionSettings(config).timeoutMs,
    temperature: config?.llm?.temperature,
    skipCalibration: true,
    cache: false,
    origin: purpose,
  });
}

/**
 * Reviews one description (see the head of this file). Never throws: a refusal, a failed call or an unreadable answer
 * comes back as `{ status, code }` and writes nothing.
 */
export async function reviewDescription(db, subject, field, { ctx }) {
  const config = ctx.hot.config;
  const prompts = ctx.hot.prompts;
  const log = ctx.log ?? {};
  const now = ctx.now ?? Date.now;
  const refused = reviewRefusal(config, ctx.env, prompts);
  if (refused) return { status: refused === CODES.OFF ? 'off' : 'refused', code: refused };
  if (!DESCRIPTION_FIELDS.includes(field) || !subject?.id || !['person', 'place', 'self'].includes(subject.kind)) return { status: 'refused', code: 'bad_subject' };
  // Read through `audience_id` when the live config says so (`memoryDb.audienceColumn`) or the caller's context does.
  const given = ctx.readCtx ?? groupContext('discord');
  const readCtx = config?.memoryDb?.audienceColumn === true ? { ...given, audienceColumn: true } : given;
  const settings = sessionSettings(config);
  const cap = fieldCap(config, field);
  const selfName = ctx.selfName ?? '';
  const gathered = gatherReview(db, subject, field, { config, readCtx });
  const tokens = { prompt: 0, completion: 0 };
  const add = (completion) => {
    tokens.prompt += Number(completion?.usage?.prompt_tokens) || 0;
    tokens.completion += Number(completion?.usage?.completion_tokens) || 0;
  };

  // Call 1: the draft, from the claims and the evidence alone.
  const subjectBody = [`subject: ${subject.name ?? subject.id}`, `kind: ${subject.kind}`, `field: ${field}`, `cap: ${cap} characters`].join('\n');
  const draftUser = [
    block('subject', subjectBody),
    block('claims', gathered.claims.map(claimLine).join('\n')),
    block('evidence', gathered.evidence.join('\n')),
    block('samples', gathered.samples.join('\n')),
  ].filter(Boolean).join('\n\n');
  let draft;
  const answers = [];
  try {
    const completion = await ask(ctx, [{ role: 'system', content: systemTextOf(prompts, selfName, prompts[DRAFT_PURPOSE]) }, { role: 'user', content: draftUser }], { purpose: DRAFT_PURPOSE, maxOutputTokens: settings.descriptionMaxOutputTokens });
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
    draftDiff.lost.length ? `the old text showed, the draft does not:\n${draftDiff.lost.map(claimLine).join('\n')}` : '',
    draftDiff.gained.length ? `the draft shows, the old text did not:\n${draftDiff.gained.map(claimLine).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  const checkUser = [
    block('draft', draft.description),
    block('current', gathered.current),
    block('diff', diffBody),
  ].filter(Boolean).join('\n\n');
  let final;
  try {
    const completion = await ask(ctx, [{ role: 'system', content: systemTextOf(prompts, selfName, prompts[CHECK_PURPOSE]) }, { role: 'user', content: checkUser }], { purpose: CHECK_PURPOSE, maxOutputTokens: settings.descriptionMaxOutputTokens });
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
      prompts: { draft: shortHash(prompts[DRAFT_PURPOSE]), check: shortHash(prompts[CHECK_PURPOSE]) },
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
      kind: 'description', mode: settings.mode, row, subject: { kind: subject.kind, id: subject.id, field }, scope: gathered.scope,
      expectCurrent: gathered.currentVersion, answers, now: at,
    });
  } catch (error) {
    log.warn?.('description review: write failed', { code: codeOf(error) });
    return { status: 'failed', code: codeOf(error), step: 'write' };
  }
  return { status: 'ok', draft: draft.description, final: final.description, reason: row.reason, row };
}
