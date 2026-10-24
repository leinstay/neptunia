// The mappers by kind, and which kind a memory file path is. Each mapper module exports `toRows(rel, value, ctx)`
// and `fromRows(rows, ctx)`; the pair is an exact round trip of the old value (key order aside).

import * as channel from './channel.js';
import * as guild from './guild.js';
import * as journal from './journal.js';
import * as lore from './lore.js';
import * as privateLayer from './private.js';
import * as record from './record.js';
import * as user from './user.js';

export const MAPPERS = { record, journal, user, private: privateLayer, channel, guild, lore };

/**
 * The mapper kind of a path relative to a guild's data directory, or null. Record and journal paths (a guild's or a
 * private layer's day files) are lines, the others whole files.
 */
export function kindOfPath(rel) {
  const path = String(rel);
  if (/^(?:private\/[^/]+\/)?record\/\d{4}-\d{2}\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(path)) return 'record';
  if (/^(?:private\/[^/]+\/)?journal\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(path)) return 'journal';
  if (/^users\/[^/]+\.json$/.test(path)) return 'user';
  if (/^private\/[^/]+\.json$/.test(path)) return 'private';
  if (/^channels\/[^/]+\.json$/.test(path)) return 'channel';
  if (path === 'guild.json') return 'guild';
  if (path === 'lore.json') return 'lore';
  return null;
}
