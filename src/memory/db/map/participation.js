// Mapper: `participation.json` (`{ episodes: [...], nextId }`, the stretches of a channel she took part in) <->
// `episodes` rows of kind participation + `episode_sources`, and `operational` (kind participation) for the rest of
// the file (`nextId`).
//
// An episode's id is its `itemId` (a derived id, marked `$derived`, when it has none). The channel is the place,
// startAt / lastAt are start_ms / last_ms. `episode_sources` has one row per message id, pointing at the record by
// `src:discord:<messageId>` (no revision or kind: sync resolves it to the real source row). The message objects
// (name, caption, reply, her own flag, text) are kept verbatim in `extra.messages` ALWAYS: the record does not hold
// a caption, and an episode must come back exactly even when a message is no longer in the record.
//
// toRows(rel, value, ctx) -> { episodes, episode_sources, operational }     fromRows(rows, ctx) -> the file's value

import { channelPlaceId, itemOrDerivedId, nativeOf, nativeOfAny, uniqueIds } from '../ids.ts';
import { LEGACY_IFACE } from '../legacy-namespace.ts';
import { groupScope } from '../scope.ts';
import { extraText, ifaceOf, isPlainObject, join, ordered, parseExtra, put, rowsOf, split } from './common.js';

const SPEC = [
  {
    col: 'place_id',
    key: 'channelId',
    type: 'text',
    ok: (v) => nativeOf(channelPlaceId(LEGACY_IFACE, v)) === v,
    enc: (v, iface) => channelPlaceId(iface, v),
    dec: nativeOfAny,
  },
  { col: 'start_ms', key: 'startAt', type: 'num' },
  { col: 'last_ms', key: 'lastAt', type: 'num' },
];

export const messageSourceRef = (iface, messageId) => `src:${iface}:${messageId}`;

export function toRows(rel, value, ctx = {}) {
  const iface = ifaceOf(ctx);
  const rows = {};
  const rest = { ...value };
  const has = [];
  if (Array.isArray(value.episodes) && value.episodes.every(isPlainObject)) {
    const uniq = uniqueIds();
    value.episodes.forEach((episode, position) => {
      const part = split(episode, SPEC, iface);
      const itemId = typeof episode.itemId === 'string' && episode.itemId ? episode.itemId : null;
      const base =
        itemId ??
        itemOrDerivedId(null, 'participation', episode.channelId ?? '', episode.startAt ?? '', episode.id ?? position);
      const id = uniq(base);
      if (itemId && id === base) delete part.rest.itemId;
      else part.rest.$derived = true;
      put(rows, 'episodes', {
        id,
        ...part.cols,
        kind: 'participation',
        subject_id: null,
        extra: extraText(part.rest),
        ...groupScope(iface),
        created_at: null,
        retired_at: null,
        owner_file: rel,
        position,
      });
      const messages = Array.isArray(episode.messages) ? episode.messages : [];
      messages.forEach((message, index) => {
        if (isPlainObject(message) && typeof message.id === 'string') {
          put(rows, 'episode_sources', {
            episode_id: id,
            source_id: messageSourceRef(iface, message.id),
            position: index,
          });
        }
      });
    });
    delete rest.episodes;
    has.push('episodes');
  }
  rest.$has = has;
  put(rows, 'operational', { kind: 'participation', owner: rel, value: JSON.stringify(rest), owner_file: rel });
  return rows;
}

export function fromRows(rows) {
  const rest = parseExtra(rowsOf(rows, 'operational')[0]?.value);
  const has = Array.isArray(rest.$has) ? rest.$has : [];
  delete rest.$has;
  const obj = { ...rest };
  if (has.includes('episodes')) {
    obj.episodes = ordered(rows, 'episodes').map((row) => {
      const extra = parseExtra(row.extra);
      const derived = extra.$derived === true;
      delete extra.$derived;
      const episode = join(row, extra, SPEC);
      if (!derived) episode.itemId = row.id;
      return episode;
    });
  }
  return obj;
}
