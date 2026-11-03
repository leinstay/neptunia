// Mapper: one line of the record (`record/<YYYY-MM>/<day>.jsonl`, or a private layer's) <-> one `sources` row.
// The line's kind is the source's kind (seen, said, deleted, felt). Every field a column names is in the column;
// the rest of the line (`v`, `id`, `guildId`, `participants`, `sourceMessageIds`, `links`, ...) is in `extra`.
//
// `seen_at` is the time the line's message was observed: the line's own `recordedAt` for a `seen` line (the moment the
// engine saw the message), null for every other kind (a line of hers, a deletion, a feeling is not an observation).
//
// toRows(rel, line, ctx) -> { sources: [row] }       ctx: { position?, guildId? }
// fromRows(rows, ctx) -> the line

import { messageLocator } from '../message-locator.ts';
import { accountId, messageSourceId, nativeOfAny } from '../ids.ts';
import { extraText, ifaceOf, join, parseExtra, split } from './common.ts';
import type { OldScope } from './scope-parts.ts';
import { privateUserOf, scopeFrom, scopeInto } from './scope-parts.ts';
import { asText } from '../types.ts';
import type { Row, Rows } from '../types.ts';
import type { MapContext, Spec } from './common.ts';

// Kinds whose source id carries the message revision. A deleted or felt line, and any line without a revision, has no
// revision to tell it apart, so its id carries the line's own id (ids never collide).
const REVISIONED_KINDS = new Set(['seen', 'said']);

const SPEC: Array<Spec> = [
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
  {
    col: 'author_account',
    key: 'by',
    type: 'text',
    enc: (v: unknown, iface: string) => accountId(iface, v),
    dec: nativeOfAny,
  },
  { col: 'turn_id', key: 'turnId', type: 'text' },
  { col: 'op_id', key: 'opId', type: 'text' },
  { col: 'origin', key: 'origin', type: 'text' },
];

function sourceIdOf(line: Row, iface: string) {
  const kind = typeof line.kind === 'string' ? line.kind : 'unknown';
  const messageId = typeof line.messageId === 'string' ? line.messageId : null;
  if (REVISIONED_KINDS.has(kind) && messageId && Number.isFinite(line.revision))
    return messageSourceId(iface, messageId, line.revision, kind);
  return `src:${iface}:${messageId ?? 'none'}:${kind}:${asText(line.id ?? 'unknown')}`;
}

export function toRows(rel: string, line: Row, ctx: MapContext = {}): Rows {
  const iface = ifaceOf(ctx);
  const { cols, rest } = split(line, SPEC, iface);
  delete rest.scope;
  delete rest.$messageLocator;
  if (line.v === 1 && REVISIONED_KINDS.has(String(line.kind))) {
    const locator = messageLocator(
      {
        v: 1,
        origin: 'record-v1',
        iface,
        messageId: line.messageId,
        conversationId: (line.scope as OldScope | undefined)?.channel,
      },
      iface
    );
    if (locator) rest.$messageLocator = locator;
  }
  const scopeRest = {};
  const scope = scopeInto(scopeRest, line.scope as OldScope | undefined, privateUserOf(rel), iface);
  Object.assign(rest, scopeRest);
  const row = {
    id: sourceIdOf(line, iface),
    iface,
    ...cols,
    ...scope,
    seen_at: line.kind === 'seen' && typeof line.recordedAt === 'string' && line.recordedAt ? line.recordedAt : null,
    extra: extraText(rest),
    owner_file: rel,
    position: ctx.position ?? null,
  };
  return { sources: [row] };
}

export function fromRows(rows: Rows): Row {
  const row = rows.sources[0];
  const rest = parseExtra(row.extra);
  delete rest.$messageLocator;
  const scope = scopeFrom(row, rest, privateUserOf(String(row.owner_file)), ifaceOf(row));
  const line = join(row, rest, SPEC);
  if (scope !== undefined) line.scope = scope;
  return line;
}
