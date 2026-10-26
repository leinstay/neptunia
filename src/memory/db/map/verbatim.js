// Mapper: the files that are not memory proper but are kept so nothing is lost: one `operational` row holding the
// file's value verbatim (`kind` says which file it is, `owner` is the file's path, or path + '#' + line position for
// one line of a JSONL file). Used for voice, buffer, inner, missed, recall-trace, backfill/*, record ids and
// backfill state, the forgetting ledger and markers, the journal's `.running` marker, the archive's id index and
// pending queues, and the journal's request tool lists (`journal/requests/tools/<hash>.json`).
//
// toRows(rel, value, ctx) -> { operational: [row] }      ctx: { position? } (a JSONL line); a text file's value is a string
// fromRows(rows, ctx) -> the value

import { rowsOf } from './common.js';

/** The `kind` of an operational file, from its path (a private layer's path counts like the guild's). */
export function operationalKindOf(rel) {
  const path = String(rel).replace(/^private\/[^/]+\//, '');
  if (path === 'voice.json') return 'voice';
  if (path === 'buffer.json') return 'buffer';
  if (path === 'inner.json') return 'inner';
  if (path === 'missed.json') return 'missed';
  if (path === 'recall-trace.jsonl') return 'recall_trace';
  if (path === 'forgotten.json') return 'forgotten';
  if (path === 'journal/.running') return 'journal_running';
  if (path === 'record/backfill.json') return 'record_backfill';
  if (/^record\/\d{4}-\d{2}\/ids\.json$/.test(path)) return 'record_ids';
  if (/^archive\/\d{4}-\d{2}\.ids\.json$/.test(path)) return 'archive_ids';
  if (/^archive\/pending[^/]*\.jsonl$/.test(path)) return 'archive_pending';
  if (path.startsWith('backfill/')) return 'backfill';
  if (path.startsWith('forgetting/')) return 'forgetting';
  if (path.startsWith('journal/requests/tools/')) return 'request_tools';
  if (path.startsWith('journal/requests/')) return 'request_dump';
  return 'file';
}

/** The `owner` key of a row: the path, or the path and the line position for a JSONL line. */
export const ownerOf = (rel, ctx = {}) =>
  ctx.position === undefined || ctx.position === null ? String(rel) : `${rel}#${ctx.position}`;

export function operationalRow(kind, rel, value, ctx = {}) {
  return { kind, owner: ownerOf(rel, ctx), value: JSON.stringify(value), owner_file: String(rel) };
}

export function toRows(rel, value, ctx = {}) {
  return { operational: [operationalRow(operationalKindOf(rel), rel, value, ctx)] };
}

export function fromRows(rows) {
  return JSON.parse(rowsOf(rows, 'operational')[0].value);
}
