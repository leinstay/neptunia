// The paths a shipped data directory spelled and what each one is: the decoder of an old unit name, read by the pending
// writes of an earlier release, the explicit legacy export and the shipped data steps. A path (relative to a server's data
// directory, or to the data root with its `guilds/<id>/` prefix) becomes
//   { kind, mapper, format, unit, guildId? }   a memory file: `format` says how to read and write it
//                                              ('json' | 'jsonl' | 'text' | 'vectors'), `unit` is the key the rows
//                                              are owned by (the path; a month directory for vectors)
//   { skipped: true, reason }                  not memory (instance state, tools' output, backups)
//   null                                       unknown: the walker reports it and leaves it alone

import { MAPPERS, mapperKindOf } from '../db/map/index.ts';
import type { FileFormat, Mapper, MapperKind } from '../db/map/index.ts';

const PRIVATE = '(?:private\\/[^/]+\\/)?';
const re = (source: string): RegExp => new RegExp(`^${source}$`);

/** Not memory: instance state, tools' output, backups and the copies of unreadable files. */
const SKIPPED: Array<[RegExp, string]> = [
  [re('(?:state|usage|metrics)\\.json'), 'instance state'],
  [re('(?:mentor|recall-eval|vision-compare)(?:\\/.*)?'), 'tool output'],
  [/\.bak(?:[-.][^/]*)?$/, 'backup'],
  [/\.unreadable-[^/]*$/, 'unreadable copy'],
];

/** A kind a path names that has its own write kind and no mapper (src/memory/db/intentions-write.ts, line-vectors.ts). */
type DirectKind = 'intentions' | 'vectors';

/** [pattern, kind, format] for a path inside a guild's data directory; the first match wins. */
const KINDS: Array<[RegExp, MapperKind | DirectKind, FileFormat]> = [
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
  [re('guild\\.json'), 'place', 'json'],
  [re('lore\\.json'), 'lore', 'json'],
  [re('participation\\.json'), 'participation', 'json'],
  [re('recent\\.json'), 'recent', 'json'],
  [re('diary\\.json'), 'selfreflection', 'json'],
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
export function kindOfPath(rel: string): MapperKind | DirectKind | null {
  const found = KINDS.find(([pattern]) => pattern.test(String(rel)));
  return found ? found[1] : null;
}

/** The month directory of a vectors file path (`vectors/<month>/manifest.json` -> `vectors/<month>`). */
const vectorsUnit = (path: string): string => path.replace(/\/[^/]+$/, '');

/** A path the mappers know: its kind and mapper, its format and the unit it belongs to. */
export type MappedPath = {
  kind: MapperKind | DirectKind;
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
    mapper: MAPPERS[mapperKindOf(kind)],
    format,
    unit: format === 'vectors' ? vectorsUnit(path) : path,
  };
  if (guildId !== undefined) out.guildId = guildId;
  return out;
}
