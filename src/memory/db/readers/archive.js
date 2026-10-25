// The archive's reads from the database (src/memory/archive.js reads through them).
// An archive month is the unit `<layer>/archive/<YYYY-MM>.jsonl` of `claim_versions` rows (map/archive.js); the
// lines come back rebuilt by the export, in file order. Pure functions over a read connection.

import { byBytes, childNames, layerDir, ownersUnder, unitLines } from './common.js';

const SEGMENT_RE = /^(\d{4}-\d{2})\.jsonl$/;
const PRIVATE_ARCHIVE_RE = /^([^/]+)\/archive\//;

/** The archive's directory of a layer. */
export const archiveDirOf = (guildId, privateUserId = null) => layerDir(guildId, privateUserId, 'archive');

/** The months (`YYYY-MM`) with a segment in a layer's archive, sorted. */
export function archiveMonths(db, guildId, privateUserId = null) {
  const dir = archiveDirOf(guildId, privateUserId);
  const out = [];
  for (const name of childNames(ownersUnder(db, 'claim_versions', dir), dir)) {
    const match = name.match(SEGMENT_RE);
    if (match) out.push(match[1]);
  }
  return out;
}

/** The lines (JSON text) of one month segment of a layer's archive, in file order. */
export function archiveLines(db, guildId, privateUserId, month) {
  return unitLines(db, `${archiveDirOf(guildId, privateUserId)}/${month}.jsonl`);
}

/** The members with a private archive in the guild, sorted. */
export function archiveLayers(db, guildId) {
  const dir = layerDir(guildId, null, 'private');
  const users = new Set();
  for (const owner of ownersUnder(db, 'claim_versions', dir)) {
    const match = owner.slice(dir.length + 1).match(PRIVATE_ARCHIVE_RE);
    if (match) users.add(match[1]);
  }
  return [...users].sort(byBytes);
}
