// The record's reads from the database (src/memory/record.js reads through them).
// A record day file is the unit `<layer>/record/<YYYY-MM>/<YYYY-MM-DD>.jsonl` of `sources` rows (map/record.js);
// the lines come back rebuilt by the export, in file order. Pure functions over a read connection.

import { byBytes, childNames, layerDir, ownersUnder, unitLines } from './common.js';

const MONTH_RE = /^\d{4}-\d{2}$/;
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const PRIVATE_RECORD_RE = /^([^/]+)\/record\//;

/** The record's directory of a layer: `guilds/<g>/record` or `guilds/<g>/private/<u>/record`. */
export const recordDirOf = (guildId, privateUserId = null) => layerDir(guildId, privateUserId, 'record');

/** The month names (`YYYY-MM`) of a layer's record, sorted. */
export function recordMonths(db, guildId, privateUserId = null) {
  const dir = recordDirOf(guildId, privateUserId);
  return childNames(ownersUnder(db, 'sources', dir), dir).filter((name) => MONTH_RE.test(name));
}

/** The day units of one month of a layer's record: `[{ day, owner }]`, sorted by name. */
export function recordDays(db, guildId, privateUserId, month) {
  const dir = `${recordDirOf(guildId, privateUserId)}/${month}`;
  const out = [];
  for (const name of childNames(ownersUnder(db, 'sources', dir), dir)) {
    const match = name.match(DAY_FILE_RE);
    if (match) out.push({ day: match[1], owner: `${dir}/${name}` });
  }
  return out;
}

/** The lines (JSON text) of one record day unit, in file order. */
export const recordLines = (db, owner) => unitLines(db, owner);

/**
 * The newest revision of a message among the lines of one month of a layer's record (the id index's rule: a line
 * without a usable revision counts as revision 1, a `deleted` line does not count), or null.
 */
export function recordNewestRevision(db, guildId, privateUserId, month, messageId) {
  const prefix = `${recordDirOf(guildId, privateUserId)}/${month}/`;
  let newest = null;
  for (const row of db
    .prepare(
      'SELECT kind, revision FROM sources WHERE native_id = ? AND owner_file >= ? AND owner_file < ? AND retired_at IS NULL'
    )
    .all(String(messageId), prefix, `${prefix}￿`)) {
    if (row.kind === 'deleted') continue;
    const n = Number.isInteger(row.revision) && row.revision > 0 ? row.revision : 1;
    if (n > (newest ?? 0)) newest = n;
  }
  return newest;
}

/** The members with a private record in the guild, sorted. */
export function recordLayers(db, guildId) {
  const dir = layerDir(guildId, null, 'private');
  const users = new Set();
  for (const owner of ownersUnder(db, 'sources', dir)) {
    const match = owner.slice(dir.length + 1).match(PRIVATE_RECORD_RE);
    if (match) users.add(match[1]);
  }
  return [...users].sort(byBytes);
}

/**
 * The guild record's counts: `messages` (distinct message ids of its lines with one), `days` (day units), `first`
 * (the earliest day, or null).
 */
export function recordStats(db, guildId) {
  const dir = recordDirOf(guildId);
  let days = 0;
  let first = null;
  for (const month of recordMonths(db, guildId)) {
    for (const { day } of recordDays(db, guildId, null, month)) {
      days += 1;
      if (first === null || day < first) first = day;
    }
  }
  const prefix = `${dir}/`;
  const messages = db
    .prepare(
      'SELECT COUNT(DISTINCT native_id) AS n FROM sources WHERE native_id IS NOT NULL AND owner_file >= ? AND owner_file < ? AND retired_at IS NULL'
    )
    .get(prefix, `${prefix}￿`).n;
  return { messages, days, first };
}
