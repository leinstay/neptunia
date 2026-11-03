// The mappers by kind, and which kind a memory file path is. Each mapper module exports `toRows(rel, value, ctx)`
// and `fromRows(rows, ctx)`; the pair is an exact round trip of the old value (key order aside).
//
// `classify(rel)` is what sync and export walk a data directory with: a path (relative to a guild's data directory,
// or to the data root with its `guilds/<id>/` prefix) becomes
//   { kind, mapper, format, unit, guildId? }   a memory file: `format` says how to read and write it
//                                              ('json' | 'jsonl' | 'text' | 'vectors'), `unit` is the key the rows
//                                              are owned by (the path; a month directory for vectors)
//   { skipped: true, reason }                  not memory (instance state, tools' output, backups)
//   null                                       unknown: sync reports it and leaves it alone

import * as archive from './archive.ts';
import * as channel from './channel.ts';
import * as diary from './diary.ts';
import * as errands from './errands.ts';
import * as gifs from './gifs.ts';
import * as guild from './guild.ts';
import type { MapContext } from './common.ts';
import type { Db, Row, Rows } from '../types.ts';
import { nativeOfAny, personId } from '../ids.ts';
import type { StorageKey } from '../storage-keys.ts';
import * as intentions from './intentions.ts';
import * as journal from './journal.ts';
import * as lore from './lore.ts';
import * as media from './media.ts';
import * as participation from './participation.ts';
import * as privateLayer from './private.ts';
import * as recent from './recent.ts';
import * as record from './record.ts';
import * as requests from './requests.ts';
import * as user from './user.ts';
import * as vectors from './vectors.ts';
import * as verbatim from './verbatim.ts';
import * as versions from './versions.ts';

/**
 * What every mapper module offers the unit sync: the rows of a file, the file back from its rows, and (the vectors
 * mapper only) the rows of the part of a month that came after the stored ones. The methods are written as methods so
 * a module may take the narrower value its own file holds.
 */
export type Mapper = {
  toRows(rel: string, value: unknown, ctx: MapContext): Rows;
  fromRows(rows: Rows, ctx?: MapContext): unknown;
  appendRows?(
    rel: string,
    delta: never,
    state: { previous: never; keys: Iterable<string>; iface?: string; privateUserId?: string | null }
  ): Rows | null;
};

export const MAPPERS = {
  record,
  journal,
  user,
  private: privateLayer,
  channel,
  guild,
  lore,
  participation,
  recent,
  diary,
  intentions,
  errands,
  archive,
  versions,
  vectors,
  media,
  gifs,
  requests,
  verbatim,
} satisfies Record<string, Mapper>;

/** The kinds of file the mappers know. */
export type MapperKind = keyof typeof MAPPERS;

/** How a file is read: whole JSON, lines, text or a month of vectors. */
export type FileFormat = 'json' | 'jsonl' | 'text' | 'vectors';

const PRIVATE = '(?:private\\/[^/]+\\/)?';
const re = (source: string): RegExp => new RegExp(`^${source}$`);

/** Not memory: instance state, tools' output, backups and the copies of unreadable files. */
const SKIPPED: Array<[RegExp, string]> = [
  [re('(?:state|usage|metrics)\\.json'), 'instance state'],
  [re('(?:mentor|recall-eval|vision-compare)(?:\\/.*)?'), 'tool output'],
  [/\.bak(?:[-.][^/]*)?$/, 'backup'],
  [/\.unreadable-[^/]*$/, 'unreadable copy'],
];

/** [pattern, kind, format] for a path inside a guild's data directory; the first match wins. */
const KINDS: Array<[RegExp, MapperKind, FileFormat]> = [
  [re(`${PRIVATE}record\\/\\d{4}-\\d{2}\\/\\d{4}-\\d{2}-\\d{2}\\.jsonl`), 'record', 'jsonl'],
  [re(`${PRIVATE}record\\/\\d{4}-\\d{2}\\/ids\\.json`), 'verbatim', 'json'],
  [re('record\\/backfill\\.json'), 'verbatim', 'json'],
  [re(`${PRIVATE}journal\\/\\d{4}-\\d{2}-\\d{2}\\.jsonl`), 'journal', 'jsonl'],
  [re(`${PRIVATE}journal\\/requests\\/tools\\/[^/]+\\.json`), 'verbatim', 'json'],
  [re(`${PRIVATE}journal\\/requests\\/\\d{4}-\\d{2}-\\d{2}\\/[^/]+\\.json`), 'requests', 'json'],
  [re(`${PRIVATE}journal\\/\\.running`), 'verbatim', 'text'],
  [re(`${PRIVATE}archive\\/\\d{4}-\\d{2}\\.jsonl`), 'archive', 'jsonl'],
  [re(`${PRIVATE}archive\\/\\d{4}-\\d{2}\\.ids\\.json`), 'verbatim', 'json'],
  [re(`${PRIVATE}archive\\/pending[^/]*\\.jsonl`), 'verbatim', 'jsonl'],
  [re(`${PRIVATE}vectors\\/\\d{4}-\\d{2}\\/(?:manifest\\.json|\\d+\\.(?:i8|jsonl))`), 'vectors', 'vectors'],
  [re('versions\\/[^/]+\\/[^/]+\\.json'), 'versions', 'json'],
  [re('users\\/[^/]+\\.json'), 'user', 'json'],
  [re('private\\/[^/]+\\.json'), 'private', 'json'],
  [re('channels\\/[^/]+\\.json'), 'channel', 'json'],
  [re('guild\\.json'), 'guild', 'json'],
  [re('lore\\.json'), 'lore', 'json'],
  [re('participation\\.json'), 'participation', 'json'],
  [re('recent\\.json'), 'recent', 'json'],
  [re('diary\\.json'), 'diary', 'json'],
  [re('intentions\\.json'), 'intentions', 'json'],
  [re('intentions-archive\\.jsonl'), 'intentions', 'jsonl'],
  [re('errands\\.json'), 'errands', 'json'],
  [re('errands\\.jsonl'), 'errands', 'jsonl'],
  [re('media\\.json'), 'media', 'json'],
  [re('gifs\\.json'), 'gifs', 'json'],
  [re('recall-trace\\.jsonl'), 'verbatim', 'jsonl'],
  [re('(?:voice|buffer|inner|missed|forgotten)\\.json'), 'verbatim', 'json'],
  [re('forgetting\\/[^/]+\\.json'), 'verbatim', 'json'],
  [re('backfill\\/[^/]+\\.jsonl'), 'verbatim', 'jsonl'],
  [re('backfill\\/[^/]+\\.json'), 'verbatim', 'json'],
];

/**
 * The mapper kind of a path relative to a guild's data directory, or null. Record and journal paths (a guild's or a
 * private layer's day files) are lines, the others whole files.
 */
export function kindOfPath(rel: string): MapperKind | null {
  const found = KINDS.find(([pattern]) => pattern.test(String(rel)));
  return found ? found[1] : null;
}

/** The month directory of a vectors file path (`vectors/<month>/manifest.json` -> `vectors/<month>`). */
const vectorsUnit = (path: string): string => path.replace(/\/[^/]+$/, '');

/** A path the mappers know: its kind and mapper, its format and the unit it belongs to. */
export type MappedPath = {
  kind: MapperKind;
  mapper: Mapper;
  format: FileFormat;
  unit: string;
  guildId?: string;
};

/** What `classify` answers for a path: skipped with a reason, or a mapped kind with its unit. */
export type Classified = { skipped: true; reason: string } | MappedPath;

/** What a path is, for a walker of a data directory (see the head of this file). */
export function classify(rel: string): Classified | null {
  let path = String(rel).replace(/\\/g, '/');
  let guildId: string | undefined;
  const prefix = /^guilds\/([^/]+)\/(.+)$/.exec(path);
  if (prefix) [, guildId, path] = prefix;
  const skipped = SKIPPED.find(([pattern]) => pattern.test(path));
  if (skipped) return { skipped: true, reason: skipped[1] };
  const found = KINDS.find(([pattern]) => pattern.test(path));
  if (!found) return null;
  const [, kind, format] = found;
  const out: MappedPath = {
    kind,
    mapper: MAPPERS[kind],
    format,
    unit: format === 'vectors' ? vectorsUnit(path) : path,
  };
  if (guildId !== undefined) out.guildId = guildId;
  return out;
}

export function storageFormat(key: StorageKey): FileFormat {
  if (key.kind === 'vectors') return 'vectors';
  if (
    ['record', 'journal', 'archive', 'recall_trace', 'archive_pending'].includes(key.kind) ||
    (key.kind === 'intentions' && key.selector?.collection === 'archive') ||
    (key.kind === 'errands' && key.selector?.collection === 'history')
  )
    return 'jsonl';
  return key.kind === 'journal_running' ? 'text' : 'json';
}

/** The exact stored identity metadata, with the existing legacy spellings understood at the identity boundary. */
function identityOf(
  db: Db,
  id: string,
  table: 'accounts' | 'places'
): { iface: string; native: string; person?: string } {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  const native = row?.native_id ?? row?.native_key ?? nativeOfAny(id);
  const iface = row?.iface ?? id.split(':')[0];
  if (typeof native !== 'string' || typeof iface !== 'string')
    throw Object.assign(new Error('UNIT_IDENTITY'), { code: 'UNIT_IDENTITY' });
  return { iface, native, ...(typeof row?.person_id === 'string' ? { person: row.person_id } : {}) };
}

/** Context passed to the existing field mappers for a semantic collection. */
export function storageContext(db: Db, key: StorageKey): MapContext {
  if (key.subject.type === 'persona') return {};
  const subject = identityOf(db, key.subject.id, key.subject.type === 'account' ? 'accounts' : 'places');
  const scope = key.scopePlaceId ? identityOf(db, key.scopePlaceId, 'places') : subject;
  return {
    iface: subject.iface,
    guildId: scope.native,
    subjectId: key.subject.id,
    subjectNativeId: subject.native,
    subjectPersonId: subject.person ?? personId(subject.iface, subject.native),
    scopePlaceId: key.scopePlaceId,
    collection: key.selector?.collection,
    versionKind: key.selector?.versionKind,
    itemId: key.selector?.itemId,
    privateUserId: key.subject.type === 'account' && key.kind !== 'user' ? subject.native : null,
  };
}

/** Owner conversion preserves legacy provenance only for the explicit importer. */
function ownedRows(db: Db, rows: Rows, id: string, position: number | undefined, legacyOwner?: string): Rows {
  for (const list of Object.values(rows))
    for (const row of list) {
      if (row.owner_file !== undefined) {
        delete row.owner_file;
        row.owner_key = id;
      }
      if (row.owner_key !== undefined) row.owner_key = id;
      if (legacyOwner && row.owner_key !== undefined) row.owner_file = legacyOwner;
      if (list === rows.operational) {
        const existing = db
          .prepare('SELECT owner FROM operational WHERE kind = ? AND owner_key = ? ORDER BY rowid LIMIT 1')
          .get(row.kind, id);
        if (existing && position === undefined) row.owner = existing.owner;
      }
    }
  return rows;
}

/** Existing field conversion with semantic owner and context. */
export function storageMapper(
  db: Db,
  key: StorageKey,
  id: string,
  legacyOwner?: string
): { mapper: Mapper; kind: MapperKind; format: FileFormat } {
  const kind: MapperKind = key.kind in MAPPERS ? (key.kind as MapperKind) : 'verbatim';
  const original = MAPPERS[kind] as Mapper;
  const base = storageContext(db, key);
  const toRows = (_rel: string, value: unknown, ctx: MapContext): Rows => {
    const context = {
      ...ctx,
      ...base,
      position: ctx.position,
      messageIdentity: ctx.messageIdentity,
      hotClaimIds: ctx.hotClaimIds,
    };
    const rows =
      kind === 'verbatim'
        ? { operational: [verbatim.operationalRow(key.kind, id, value as Row, context)] }
        : original.toRows(id, value, context);
    return ownedRows(db, rows, id, context.position, legacyOwner);
  };
  return {
    kind,
    format: storageFormat(key),
    mapper: {
      ...original,
      toRows,
      ...(original.appendRows
        ? {
            appendRows: (rel, delta, state) => {
              const rows = original.appendRows!(rel, delta, { ...state, privateUserId: base.privateUserId });
              return rows ? ownedRows(db, rows, id, undefined, legacyOwner) : null;
            },
          }
        : {}),
      fromRows: (rows) => original.fromRows(rows, base),
    },
  };
}
