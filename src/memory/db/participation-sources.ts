// Resolves participation evidence before the unit writer replaces episode rows.

import { nativeOfAny } from './ids.ts';
import { parseExtra } from './map/common.ts';
import type { Db, Row, Rows } from './types.ts';

function capturedSource(db: Db, episode: Row, link: Row): unknown {
  const prior = db.prepare('SELECT place_id, extra FROM episodes WHERE id = ?').get(episode.id);
  if (!prior || prior.place_id !== episode.place_id) return null;
  const oldMessages = parseExtra(prior.extra).messages;
  const newMessages = parseExtra(episode.extra).messages;
  const position = Number(link.position);
  if (
    !Array.isArray(oldMessages) ||
    !Array.isArray(newMessages) ||
    JSON.stringify(oldMessages[position]) !== JSON.stringify(newMessages[position])
  )
    return null;
  return db
    .prepare(
      `SELECT es.source_id FROM episode_sources es JOIN sources s ON s.id = es.source_id
      WHERE es.episode_id = ? AND es.position = ? AND es.retired_at IS NULL AND s.place_id = ?`
    )
    .get(episode.id, link.position, episode.place_id)?.source_id;
}

function qualifiedSource(db: Db, episode: Row, reference: string): unknown {
  const iface = typeof episode.place_id === 'string' ? episode.place_id.split(':')[0] : '';
  const prefix = `src:${iface}:`;
  if (!reference.startsWith(prefix)) return null;
  const message = reference.slice(prefix.length);
  const source = db
    .prepare(
      `SELECT s.id FROM message_families f JOIN sources s
    ON s.authority_id = f.authority_id AND s.native_kind = f.native_kind
    AND s.native_id = f.native_key AND s.generation = f.generation
    WHERE f.iface = ? AND f.conversation_id = ? AND f.message_id = ?
    AND s.kind IN ('seen', 'said') AND s.retired_at IS NULL
    ORDER BY s.revision DESC LIMIT 1`
    )
    .get(iface, nativeOfAny(episode.place_id), message);
  if (source) return source.id;
  // Record-only sources can predate indexed family adoption. Their actual stored route remains authoritative.
  return db
    .prepare(
      `SELECT id FROM sources WHERE iface = ? AND place_id = ? AND native_id = ?
    AND native_kind = 'message' AND kind IN ('seen', 'said') AND retired_at IS NULL
    ORDER BY generation DESC, revision DESC LIMIT 1`
    )
    .get(iface, episode.place_id, message)?.id;
}

/** Keeps captured revisions and resolves new evidence by its episode conversation and interface. */
export function resolveParticipationSources(db: Db, mapping: Rows): void {
  for (const link of mapping.episode_sources ?? []) {
    const episode = mapping.episodes?.find((row) => row.id === link.episode_id && row.kind === 'participation');
    if (!episode || typeof link.source_id !== 'string') continue;
    const source = capturedSource(db, episode, link) ?? qualifiedSource(db, episode, link.source_id);
    if (typeof source === 'string') link.source_id = source;
  }
}
