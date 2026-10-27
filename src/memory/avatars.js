// Avatar descriptions (features.avatars), the pure part: whether the stored description is of the
// avatar a member shows now (the platform's asset hash, null for its default avatar), and the
// stored field's shape. The member's current avatar lives in their profile as `avatar`:
// `{ hash, text, describedAt }`, or `{ hash: null, default: true }` for the default avatar; a new
// version replaces it, no history is kept. The hash comes from the interface with the event. The queue that describes them is src/memory/avatar-queue.js;
// the `<people>` line is src/behavior/prompt.js's.

import { isPlainObject } from '../config.js';
import { oneLine } from './clamp.js';

/**
 * An avatar hash (or a URL) as kept: a non-empty string as it is, anything else null. Pure.
 * @param {unknown} value
 * @returns {string|null}
 */
export function hashOrNull(value) {
  return typeof value === 'string' && value ? value : null;
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
