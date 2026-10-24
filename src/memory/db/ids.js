// Deterministic ids for the memory database (spec section 2): the same input gives the same id, so a re-import
// writes the same rows. Pure, no I/O.

import { createHash } from 'node:crypto';

export const IFACE = 'discord';
export const SELF_PERSON = 'person:self';

const text = (value) => String(value);

export const personId = (userId) => `person:${IFACE}:${text(userId)}`;
export const accountId = (userId) => `${IFACE}:${text(userId)}`;
export const guildPlaceId = (guildId) => `${IFACE}:guild:${text(guildId)}`;
export const channelPlaceId = (channelId) => `${IFACE}:channel:${text(channelId)}`;
export const dmPlaceId = (userId) => `${IFACE}:dm:${text(userId)}`;

/** The native id inside a person, account or place id; null when the id has another shape. */
export function nativeOf(id) {
  const match = /^(?:person:discord:|discord:(?:guild:|channel:|dm:)?)(.+)$/.exec(String(id));
  return match ? match[1] : null;
}

/** A message source: `src:discord:<messageId>:<revision>:<kind>`. */
export const messageSourceId = (messageId, revision, kind) => `src:${IFACE}:${text(messageId)}:${text(revision)}:${kind}`;
/** Her answer in a turn: `src:turn:<turnId>:<step>`. */
export const answerSourceId = (turnId, step) => `src:turn:${text(turnId)}:${text(step)}`;
/** Any other kind of source: `src:<kind>:<its id>`. */
export const otherSourceId = (kind, id) => `src:${kind}:${text(id)}`;

/** The first 16 hex digits of the SHA-1 of the parts joined by a NUL. */
export function shortHash(...parts) {
  return createHash('sha1').update(parts.map((part) => text(part)).join('\u0000')).digest('hex').slice(0, 16);
}

/** A claim, episode or description id: the old `itemId` when the item had one, else `<kind>:<owner>:<hash of stable fields>`. */
export function itemOrDerivedId(itemId, kind, owner, ...stable) {
  if (typeof itemId === 'string' && itemId) return itemId;
  return `${kind}:${text(owner)}:${shortHash(...stable)}`;
}

/** Makes ids unique inside one mapping: a repeat gets `-2`, `-3`, ... (the first keeps its id). */
export function uniqueIds() {
  const seen = new Map();
  return (id) => {
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return n === 1 ? id : `${id}-${n}`;
  };
}
