// Mapper: one line of the record (`record/<YYYY-MM>/<day>.jsonl`, or a private layer's) <-> one `sources` row.
// The line's kind is the source's kind (seen, said, deleted, felt). Every field a column names is in the column;
// the rest of the line (`v`, `id`, `guildId`, `participants`, `sourceMessageIds`, `links`, ...) is in `extra`.
//
// toRows(rel, line, ctx) -> { sources: [row] }       ctx: { position?, guildId? }
// fromRows(rows, ctx) -> the line

import { IFACE, accountId, messageSourceId, nativeOf, otherSourceId } from '../ids.js';
import { extraText, join, parseExtra, split } from './common.js';
import { privateUserOf, scopeFrom, scopeInto } from './scope-parts.js';

const MESSAGE_KINDS = new Set(['seen', 'said', 'deleted']);

const SPEC = [
  { col: 'kind', key: 'kind', type: 'text' },
  { col: 'native_id', key: 'messageId', type: 'text' },
  { col: 'revision', key: 'revision', type: 'num' },
  { col: 'occurred_at', key: 'occurredAt', type: 'text' },
  { col: 'recorded_at', key: 'recordedAt', type: 'text' },
  { col: 'text', key: 'text', type: 'text' },
  { col: 'media', key: 'media', type: 'json' },
  { col: 'mentions', key: 'mentions', type: 'json' },
  { col: 'direct', key: 'direct', type: 'bool' },
  { col: 'reply_to', key: 'replyTo', type: 'text' },
  { col: 'author_account', key: 'by', type: 'text', enc: accountId, dec: nativeOf },
  { col: 'turn_id', key: 'turnId', type: 'text' },
  { col: 'op_id', key: 'opId', type: 'text' },
  { col: 'origin', key: 'origin', type: 'text' },
];

function sourceIdOf(line) {
  const kind = typeof line.kind === 'string' ? line.kind : 'unknown';
  if (MESSAGE_KINDS.has(kind) && typeof line.messageId === 'string') {
    return messageSourceId(line.messageId, Number.isFinite(line.revision) ? line.revision : 0, kind);
  }
  if (kind === 'felt' && typeof line.feltId === 'string') return otherSourceId('felt', line.feltId);
  return otherSourceId(kind, line.id ?? 'unknown');
}

export function toRows(rel, line, ctx = {}) {
  const { cols, rest } = split(line, SPEC);
  delete rest.scope;
  const scopeRest = {};
  const scope = scopeInto(scopeRest, line.scope, privateUserOf(rel));
  Object.assign(rest, scopeRest);
  const row = {
    id: sourceIdOf(line),
    iface: IFACE,
    ...cols,
    ...scope,
    seen_at: null,
    extra: extraText(rest),
    owner_file: rel,
    position: ctx.position ?? null,
  };
  return { sources: [row] };
}

export function fromRows(rows) {
  const row = rows.sources[0];
  const rest = parseExtra(row.extra);
  const scope = scopeFrom(row, rest, privateUserOf(row.owner_file));
  const line = join(row, rest, SPEC);
  if (scope !== undefined) line.scope = scope;
  return line;
}
