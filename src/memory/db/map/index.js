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

import * as archive from './archive.js';
import * as channel from './channel.js';
import * as diary from './diary.js';
import * as gifs from './gifs.js';
import * as guild from './guild.js';
import * as intentions from './intentions.js';
import * as journal from './journal.js';
import * as lore from './lore.js';
import * as media from './media.js';
import * as participation from './participation.js';
import * as privateLayer from './private.js';
import * as recent from './recent.js';
import * as record from './record.js';
import * as requests from './requests.js';
import * as tasks from './tasks.js';
import * as user from './user.js';
import * as vectors from './vectors.js';
import * as verbatim from './verbatim.js';
import * as versions from './versions.js';

export const MAPPERS = {
  record, journal, user, private: privateLayer, channel, guild, lore,
  participation, recent, diary, intentions, tasks, archive, versions, vectors, media, gifs, requests, verbatim,
};

const PRIVATE = '(?:private\\/[^/]+\\/)?';
const re = (source) => new RegExp(`^${source}$`);

/** Not memory: instance state, tools' output, backups and the copies of unreadable files. */
const SKIPPED = [
  [re('(?:state|usage|metrics)\\.json'), 'instance state'],
  [re('(?:mentor|recall-eval|vision-compare)(?:\\/.*)?'), 'tool output'],
  [/\.bak(?:[-.][^/]*)?$/, 'backup'],
  [/\.unreadable-[^/]*$/, 'unreadable copy'],
];

/** [pattern, kind, format] for a path inside a guild's data directory; the first match wins. */
const KINDS = [
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
  [re('tasks\\.json'), 'tasks', 'json'],
  [re('tasks\\.jsonl'), 'tasks', 'jsonl'],
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
export function kindOfPath(rel) {
  const found = KINDS.find(([pattern]) => pattern.test(String(rel)));
  return found ? found[1] : null;
}

/** The month directory of a vectors file path (`vectors/<month>/manifest.json` -> `vectors/<month>`). */
const vectorsUnit = (path) => path.replace(/\/[^/]+$/, '');

/** What a path is, for a walker of a data directory (see the head of this file). */
export function classify(rel) {
  let path = String(rel).replace(/\\/g, '/');
  let guildId;
  const prefix = /^guilds\/([^/]+)\/(.+)$/.exec(path);
  if (prefix) [, guildId, path] = prefix;
  const skipped = SKIPPED.find(([pattern]) => pattern.test(path));
  if (skipped) return { skipped: true, reason: skipped[1] };
  const found = KINDS.find(([pattern]) => pattern.test(path));
  if (!found) return null;
  const [, kind, format] = found;
  const out = { kind, mapper: MAPPERS[kind], format, unit: format === 'vectors' ? vectorsUnit(path) : path };
  if (guildId !== undefined) out.guildId = guildId;
  return out;
}
