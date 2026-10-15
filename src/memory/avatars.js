// Avatar descriptions (features.avatars), the pure part: which avatar a member shows (Discord's
// asset hash -- the server avatar when the member set one, else the account avatar, else none:
// Discord's default avatar), whether the stored description is of that version, and the stored
// field's shape. The member's current avatar lives in their profile as `avatar`:
// `{ hash, text, describedAt }`, or `{ hash: null, default: true }` for the default avatar; a new
// version replaces it, no history is kept. The queue that describes them is
// src/memory/avatar-queue.js; the `<people>` line is src/behavior/prompt.js's.

import { isPlainObject } from '../config.js';
import { oneLine } from './clamp.js';

/** The avatar picture asked for: a static 256 px PNG (an animated one's first frame). */
const AVATAR_URL_OPTIONS = Object.freeze({ extension: 'png', size: 256, forceStatic: true });

/**
 * An avatar hash (or a URL) as kept: a non-empty string as it is, anything else null. Pure.
 * @param {unknown} value
 * @returns {string|null}
 */
export function hashOrNull(value) {
  return typeof value === 'string' && value ? value : null;
}

/**
 * The avatar a member shows in the guild: the server avatar's hash when set, else the account
 * avatar's, else null (Discord's default avatar). Pure.
 * @param {{ memberAvatar?: unknown, userAvatar?: unknown }} hashes
 * @returns {string|null}
 */
export function avatarHashOf({ memberAvatar, userAvatar } = {}) {
  return hashOrNull(memberAvatar) ?? hashOrNull(userAvatar);
}

/**
 * A discord.js GuildMember as the queue sees it: its id, whether it is a bot, the current avatar
 * hash (avatarHashOf) and, with a hash, the URL of a static 256 px PNG of it
 * (`displayAvatarURL`, which prefers the server avatar as the hash does). Null for anything that
 * is not a member with a user id. Never throws (a failing URL builder gives a null url).
 * @param {object|null|undefined} member
 * @returns {{ id: string, bot: boolean, hash: string|null, url: string|null }|null}
 */
export function memberView(member) {
  const user = member?.user;
  if (!user || typeof user.id !== 'string' || !user.id) return null;
  const hash = avatarHashOf({ memberAvatar: member.avatar, userAvatar: user.avatar });
  let url = null;
  if (hash) {
    try {
      url = hashOrNull(member.displayAvatarURL?.({ ...AVATAR_URL_OPTIONS }));
    } catch {
      url = null;
    }
  }
  return { id: user.id, bot: user.bot === true, hash, url };
}

/**
 * A stored `avatar` field as it may be kept: `{ hash, text, describedAt }` with a non-empty hash
 * and a non-empty one-line text (`describedAt` an ISO time or null), or exactly
 * `{ hash: null, default: true }`. Anything else is null: the field goes. Pure.
 * @param {unknown} value
 * @returns {{ hash: string, text: string, describedAt: string|null }|{ hash: null, default: true }|null}
 */
export function normalizeAvatar(value) {
  if (!isPlainObject(value)) return null;
  if (value.hash === null && value.default === true) return { hash: null, default: true };
  const hash = hashOrNull(value.hash);
  const text = typeof value.text === 'string' ? oneLine(value.text) : '';
  if (!hash || !text) return null;
  const at = typeof value.describedAt === 'string' ? Date.parse(value.describedAt) : NaN;
  return { hash, text, describedAt: Number.isFinite(at) ? new Date(at).toISOString() : null };
}

/**
 * Whether a member with the stored `avatar` field and the current avatar `hash` (null: the
 * default avatar) needs the avatar described or stored: nothing valid stored, or another
 * version. Pure.
 * @param {unknown} stored  `profile.avatar`.
 * @param {string|null} hash
 * @returns {boolean}
 */
export function isAvatarDue(stored, hash) {
  const current = normalizeAvatar(stored);
  if (!current) return true;
  return current.hash !== hashOrNull(hash);
}
