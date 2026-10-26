// Mapper: one line of the journal (`journal/<day>.jsonl`, or a private layer's) <-> rows, whatever its kind.
//
//   turn                      -> a `sources` row (kind answer: her think and the ids she posted) + a `day` row
//   memory                    -> a `decisions` row (by the analyzer) + one `affinity_events` row per attitude entry
//   action, inner, system, turn.start, answer (the missed-message records) and any other kind -> a `day` row
//
// Every field a column names is in the column; the rest of the line is in the carrying row's `extra` (the `day`
// row, the `decisions` row), so the line is rebuilt exactly from its rows. `day.what` is the line's kind.
// Note that a journal line of kind `answer` is a missed-message record, not a `sources` row of kind answer.
//
// toRows(rel, line, ctx) -> { day|decisions|sources|affinity_events: [...] }      ctx: { position? }
// fromRows(rows, ctx) -> the line

import { answerSourceId, nativeOfAny, personId } from '../ids.ts';
import { extraText, ifaceOf, isPlainObject, join, ordered, parseExtra, put, rowsOf, split } from './common.js';
import { privateUserOf, scopeFrom, scopeInto } from './scope-parts.js';

const DAY_SPEC = [
  { col: 'id', key: 'id', type: 'text' },
  { col: 'at', key: 'occurredAt', type: 'text' },
  { col: 'what', key: 'kind', type: 'text' },
  { col: 'outcome', key: 'outcome', type: 'text' },
  { col: 'reason', key: 'reason', type: 'text' },
  { col: 'turn_id', key: 'turnId', type: 'text' },
];

const DECISION_SPEC = [
  { col: 'id', key: 'id', type: 'text' },
  { col: 'at', key: 'occurredAt', type: 'text' },
  { col: 'target_id', key: 'batchId', type: 'text' },
  { col: 'action', key: 'stage', type: 'text' },
  { col: 'reason', key: 'note', type: 'text' },
];

const ANSWER_SPEC = [{ col: 'think', key: 'think', type: 'text' }];

const ATTITUDE_SPEC = [
  { col: 'person_id', key: 'userId', type: 'text', enc: (v, iface) => personId(iface, v), dec: nativeOfAny },
  { col: 'delta', key: 'delta', type: 'num' },
  { col: 'applied', key: 'applied', type: 'num' },
  { col: 'reason', key: 'reason', type: 'text' },
];

const has = (rest, key) => Array.isArray(rest.$has) && rest.$has.includes(key);
const markHas = (rest, key) => {
  (rest.$has ??= []).push(key);
};

function memoryRows(rel, line, ctx, privateUser) {
  const iface = ifaceOf(ctx);
  const rows = {};
  const body = { ...line };
  delete body.attitude;
  const { cols, rest } = split(body, DECISION_SPEC);
  const attitude = line.attitude;
  const mappable = Array.isArray(attitude) && attitude.every(isPlainObject);
  if (mappable) markHas(rest, 'attitude');
  else if (Object.hasOwn(line, 'attitude')) rest.attitude = attitude;
  put(rows, 'decisions', {
    ...cols,
    by: 'analyzer',
    target_kind: 'batch',
    extra: extraText(rest),
    owner_file: rel,
    position: ctx.position ?? null,
  });
  if (mappable) {
    const scopeRest = {};
    const scope = scopeInto(scopeRest, line.scope, privateUser, iface);
    attitude.forEach((entry, index) => {
      const part = split(entry, ATTITUDE_SPEC, iface);
      put(rows, 'affinity_events', {
        id: `aff:${line.id}:${index}`,
        ...part.cols,
        at: typeof line.occurredAt === 'string' ? line.occurredAt : null,
        score: null,
        scope_kind: scope.scope_kind,
        scope_iface: scope.scope_iface,
        scope_dm: scope.scope_dm,
        extra: extraText(part.rest),
        owner_file: rel,
        position: index,
      });
    });
  }
  return rows;
}

export function toRows(rel, line, ctx = {}) {
  const iface = ifaceOf(ctx);
  const privateUser = privateUserOf(rel);
  if (line.kind === 'memory') return memoryRows(rel, line, ctx, privateUser);
  const rows = {};
  const body = { ...line };
  delete body.scope;
  const isTurn = line.kind === 'turn';
  let sourceId = null;
  if (isTurn) {
    delete body.think;
    delete body.posted;
    sourceId = answerSourceId(
      typeof line.turnId === 'string' ? line.turnId : line.id,
      Number.isFinite(line.attemptId) ? line.attemptId : 0
    );
  }
  const { cols, rest } = split(body, DAY_SPEC);
  const scope = scopeInto(rest, line.scope, privateUser, iface);
  put(rows, 'day', {
    ...cols,
    place_id: scope.place_id,
    source_id: sourceId,
    work_id: null,
    scope_kind: scope.scope_kind,
    scope_iface: scope.scope_iface,
    scope_dm: scope.scope_dm,
    extra: extraText(rest),
    owner_file: rel,
    position: ctx.position ?? null,
  });
  if (isTurn) {
    const answer = {};
    for (const key of ['think', 'posted']) if (Object.hasOwn(line, key)) answer[key] = line[key];
    const part = split(answer, ANSWER_SPEC);
    put(rows, 'sources', {
      id: sourceId,
      kind: 'answer',
      iface,
      place_id: scope.place_id,
      occurred_at: typeof line.occurredAt === 'string' ? line.occurredAt : null,
      recorded_at: typeof line.recordedAt === 'string' ? line.recordedAt : null,
      turn_id: typeof line.turnId === 'string' ? line.turnId : null,
      origin: typeof line.origin === 'string' ? line.origin : null,
      ...part.cols,
      scope_kind: scope.scope_kind,
      scope_iface: scope.scope_iface,
      scope_dm: scope.scope_dm,
      extra: extraText(part.rest),
      owner_file: rel,
      position: ctx.position ?? null,
    });
  }
  return rows;
}

export function fromRows(rows) {
  const decision = rowsOf(rows, 'decisions')[0];
  if (decision) {
    const rest = parseExtra(decision.extra);
    const attitudeRows = has(rest, 'attitude') ? ordered(rows, 'affinity_events') : null;
    delete rest.$has;
    const line = join(decision, rest, DECISION_SPEC);
    if (attitudeRows) {
      line.attitude = attitudeRows.map((row) => join(row, row.extra, ATTITUDE_SPEC));
    }
    return line;
  }
  const day = rows.day[0];
  const rest = parseExtra(day.extra);
  const scope = scopeFrom(day, rest, privateUserOf(day.owner_file), ifaceOf(day, 'scope_iface'));
  const line = join(day, rest, DAY_SPEC);
  if (scope !== undefined) line.scope = scope;
  const answer = rowsOf(rows, 'sources')[0];
  if (answer) Object.assign(line, join(answer, answer.extra, ANSWER_SPEC));
  return line;
}
