// Mapper: one line of an archive segment (`archive/<YYYY-MM>.jsonl`, or a private layer's) <-> one `claim_versions`
// row. The line is a past version of an item that left hot memory (an event: expired, replaced, removed, ...).
//
//   claim_versions   id = the line's id; claim_id = its `itemId` (the id of the hot claim, episode or recent line it
//                    belonged to); revision_id, event, by, origin, recorded_at are columns; text is `text.text` when
//                    the line has one; the rest (kind, itemKind, scope, participants, observedAt, sourceRefs,
//                    stored, the other text fields, ...) is in `extra`.
//
// The mapper makes version rows only. Linking them to hot claims is sync's job, through `claimStub` and
// `withStubs` below: an archived item that is not in hot memory becomes a claim with `retired_at` set and truth
// `historical`; an item that IS in hot memory keeps its claim untouched (a stub must never replace a hot claim, so
// toRows adds stubs only when ctx.hotClaimIds, a Set of the hot claim ids, is given, and only for ids not in it).
//
// toRows(rel, entry, ctx) -> { claim_versions: [row], claims?: [stub] }     ctx: { position?, hotClaimIds? }
// fromRows(rows, ctx) -> the entry

import { shortHash } from '../ids.js';
import { scopeColumns } from '../scope.js';
import { extraText, isPlainObject, join, parseExtra, put, rowsOf, split } from './common.js';
import { privateUserOf } from './scope-parts.js';

const SPEC = [
  { col: 'id', key: 'id', type: 'text' },
  { col: 'claim_id', key: 'itemId', type: 'text' },
  { col: 'revision_id', key: 'revisionId', type: 'text' },
  { col: 'recorded_at', key: 'recordedAt', type: 'text' },
  { col: 'event', key: 'event', type: 'text' },
  { col: 'by', key: 'by', type: 'text' },
  { col: 'origin', key: 'origin', type: 'text' },
];

/** The claim row for an archived item that is not in hot memory: retired, historical, text from the entry. */
export function claimStub(rel, entry) {
  const scope = entry.scope ?? {};
  const subject =
    typeof scope.user === 'string' && scope.user
      ? { subject_kind: 'person', subject_id: `person:discord:${scope.user}` }
      : typeof scope.channel === 'string' && scope.channel
        ? { subject_kind: 'place', subject_id: `discord:channel:${scope.channel}` }
        : { subject_kind: null, subject_id: null };
  return {
    id: entry.itemId,
    ...subject,
    kind: typeof entry.itemKind === 'string' ? entry.itemKind : null,
    text: typeof entry.text?.text === 'string' ? entry.text.text : null,
    extra: null,
    weight: typeof entry.weight === 'number' ? entry.weight : null,
    first_seen_at: typeof entry.observedAt?.date === 'string' ? entry.observedAt.date : null,
    last_seen_at: typeof entry.lastSeen === 'string' ? entry.lastSeen : null,
    valid_to: null,
    superseded_by: null,
    how: 'archive',
    author: 'import',
    from_person: null,
    truth: 'historical',
    shown: 0,
    ...scopeColumns(entry.scope, { privateUser: privateUserOf(rel) }),
    created_at: null,
    retired_at: typeof entry.recordedAt === 'string' ? entry.recordedAt : null,
    origin_file: rel,
    owner_file: rel,
    position: null,
  };
}

/** Adds to a mapping the stubs of the entries whose item is not a hot claim (no duplicates by item id). */
export function withStubs(mapping, rel, entries, hotClaimIds) {
  const seen = new Set();
  for (const entry of entries) {
    const id = entry?.itemId;
    if (typeof id !== 'string' || !id || seen.has(id) || hotClaimIds.has(id)) continue;
    seen.add(id);
    put(mapping, 'claims', claimStub(rel, entry));
  }
  return mapping;
}

export function toRows(rel, entry, ctx = {}) {
  const rows = {};
  if (!isPlainObject(entry)) {
    put(rows, 'claim_versions', {
      id: `cv:${shortHash(JSON.stringify(entry))}:${ctx.position ?? 0}`,
      claim_id: null,
      revision_id: null,
      text: null,
      extra: JSON.stringify({ $raw: entry }),
      recorded_at: null,
      event: null,
      by: null,
      origin: null,
      owner_file: rel,
      position: ctx.position ?? null,
    });
    return rows;
  }
  const body = { ...entry };
  let text = null;
  if (isPlainObject(entry.text) && typeof entry.text.text === 'string') {
    text = entry.text.text;
    const left = { ...entry.text };
    delete left.text;
    body.text = left;
  }
  const { cols, rest } = split(body, SPEC);
  if (cols.id === null) {
    cols.id = `cv:${shortHash(JSON.stringify(entry))}:${ctx.position ?? 0}`;
    rest.$noId = true;
  }
  put(rows, 'claim_versions', {
    ...cols,
    text,
    extra: extraText(rest),
    owner_file: rel,
    position: ctx.position ?? null,
  });
  if (ctx.hotClaimIds instanceof Set) withStubs(rows, rel, [entry], ctx.hotClaimIds);
  return rows;
}

export function fromRows(rows) {
  const row = rowsOf(rows, 'claim_versions')[0];
  const rest = parseExtra(row.extra);
  if (Object.hasOwn(rest, '$raw')) return rest.$raw;
  const noId = rest.$noId === true;
  delete rest.$noId;
  const entry = join(row, rest, SPEC);
  if (noId) delete entry.id;
  if (row.text !== null && row.text !== undefined)
    entry.text = { text: row.text, ...(isPlainObject(rest.text) ? rest.text : {}) };
  return entry;
}
