// Resolves participation evidence before the unit writer replaces episode rows.

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

type SourceSchema = { catalog: boolean; tuple: boolean };

/**
 * The source of the message a link's position names in its episode's messages, in the episode's chat, on the interface
 * and under the native id of the chat's row (`places.iface`, `native_id`). Null when no row holds the chat.
 */
function qualifiedSource(db: Db, episode: Row, link: Row, schema: SourceSchema): unknown {
  const place = db.prepare('SELECT iface, native_id FROM places WHERE id = ?').get(episode.place_id);
  const iface = typeof place?.iface === 'string' && place.iface !== '' ? place.iface : null;
  const messages = parseExtra(episode.extra).messages;
  const named: unknown = Array.isArray(messages) ? (messages[Number(link.position)] as Row | undefined)?.id : null;
  const message = typeof named === 'string' ? named : null;
  if (iface === null || message === null) return null;
  const source = schema.catalog
    ? db
        .prepare(
          `SELECT s.id FROM message_families f JOIN sources s
    ON s.authority_id = f.authority_id AND s.native_kind = f.native_kind
    AND s.native_id = f.native_key AND s.generation = f.generation
    WHERE f.iface = ? AND f.conversation_id = ? AND f.message_id = ?
    AND s.kind IN ('seen', 'said') AND s.retired_at IS NULL
    ORDER BY s.revision DESC LIMIT 1`
        )
        .get(iface, place?.native_id ?? null, message)
    : null;
  if (source) return source.id;
  // Record-only sources can predate indexed family adoption. Their actual stored route remains authoritative.
  return db
    .prepare(
      `SELECT id FROM sources WHERE iface = ? AND place_id = ? AND native_id = ?
    ${schema.tuple ? "AND native_kind = 'message' AND generation = 1" : ''}
    AND kind IN ('seen', 'said') AND retired_at IS NULL
    ORDER BY revision DESC LIMIT 1`
    )
    .get(iface, episode.place_id, message)?.id;
}

/** Keeps captured revisions and resolves new evidence by its episode chat and interface. */
export function resolveParticipationSources(db: Db, mapping: Rows): void {
  const links = mapping.episode_sources ?? [];
  if (!links.length) return;
  const schema: SourceSchema = {
    catalog:
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_families'").get() !== undefined,
    tuple: db
      .prepare('PRAGMA table_info(sources)')
      .all()
      .some((column) => column.name === 'native_kind'),
  };
  for (const link of links) {
    const episode = mapping.episodes?.find((row) => row.id === link.episode_id && row.kind === 'participation');
    if (!episode || typeof link.source_id !== 'string') continue;
    const source = capturedSource(db, episode, link) ?? qualifiedSource(db, episode, link, schema);
    if (typeof source === 'string') link.source_id = source;
  }
}
