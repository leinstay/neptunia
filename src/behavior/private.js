// Pure logic for private chat (direct messages, `private.enabled`): who
// may talk to the persona in private, and how the public profile and the
// per-member private layer combine for that one conversation. The gate is
// checked locally with zero tokens; anything it refuses is dropped by the
// caller (src/behavior/pipeline.js). The private
// layer never changes the public profile: `mergeProfiles` builds a NEW
// object for rendering only, and the public affinity score alone decides the
// gate -- see docs/prompt-contract.md.

import { normalizeTopic, clampScore } from '../memory/index.js';

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

/** Earlier of two ISO date strings; a missing one never wins. */
function minIso(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return a < b ? a : b;
}

/** Later of two ISO date strings; a missing one never wins. */
function maxIso(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Whether a DM from this author is answered. Checked in order: the switch
 * (`private.enabled === true`), membership in the served guild, a stored
 * public profile, and the public `affinity.score >= private.minAffinity`
 * (owners skip this one check). A missing `private.minAffinity` fails closed
 * (no threshold passes).
 * @param {{ config: object, isMember: boolean, profile: object|null, isOwner: boolean }} input
 * @returns {{ ok: true } | { ok: false, reason: 'off'|'not-member'|'unknown'|'affinity' }}
 */
export function privateGate({ config, isMember, profile, isOwner }) {
  const settings = config?.private ?? {};
  if (settings.enabled !== true) return { ok: false, reason: 'off' };
  if (!isMember) return { ok: false, reason: 'not-member' };
  if (!profile) return { ok: false, reason: 'unknown' };
  if (!isOwner) {
    const score = finiteOr(profile.affinity?.score, 0);
    if (score < finiteOr(settings.minAffinity, Infinity)) return { ok: false, reason: 'affinity' };
  }
  return { ok: true };
}

/**
 * What the persona feels in a DM: the public and the private scores added
 * and clamped to -100..100, the private reason first (the public one when the
 * private reason is empty), no history (a view, never stored). Malformed or
 * missing sides count as neutral.
 * @param {object|null|undefined} publicAffinity   `{ score, reason, history }`
 * @param {object|null|undefined} privateAffinity  `{ score, reason, history }`
 * @returns {{ score: number, reason: string, history: [] }}
 */
export function effectiveAffinity(publicAffinity, privateAffinity) {
  const score = clampScore(finiteOr(publicAffinity?.score, 0) + finiteOr(privateAffinity?.score, 0));
  const privateReason = typeof privateAffinity?.reason === 'string' ? privateAffinity.reason : '';
  const publicReason = typeof publicAffinity?.reason === 'string' ? publicAffinity.reason : '';
  return { score, reason: privateReason || publicReason, history: [] };
}

/** Union of two interest lists by topic (see `normalizeTopic`): a shared topic keeps the public
 * item's spelling, the heavier weight and the widest date range, and the private note unless it is
 * empty. Public items first, then private-only ones; ranking is left to the renderer. */
function mergeInterests(publicItems, privateItems) {
  const merged = listOf(publicItems).map((item) => ({ ...item }));
  const indexByTopic = new Map(merged.map((item, index) => [normalizeTopic(item.topic), index]));
  for (const item of listOf(privateItems)) {
    const index = indexByTopic.get(normalizeTopic(item.topic));
    if (index === undefined) {
      indexByTopic.set(normalizeTopic(item.topic), merged.length);
      merged.push({ ...item });
      continue;
    }
    const shared = merged[index];
    merged[index] = {
      ...shared,
      note: item.note || shared.note,
      weight: Math.max(finiteOr(shared.weight, 0), finiteOr(item.weight, 0)),
      firstSeen: minIso(shared.firstSeen, item.firstSeen),
      lastSeen: maxIso(shared.lastSeen, item.lastSeen),
    };
  }
  return merged;
}

/** Both episode lists, oldest `date` first (`addedAt` breaks a tie); a stable sort otherwise. */
function mergeEpisodes(publicEpisodes, privateEpisodes) {
  return [...listOf(publicEpisodes), ...listOf(privateEpisodes)].sort(
    (a, b) =>
      String(a?.date ?? '').localeCompare(String(b?.date ?? '')) ||
      String(a?.addedAt ?? '').localeCompare(String(b?.addedAt ?? ''))
  );
}

/**
 * The profile the persona sees about its DM partner: names, aliases,
 * character, style, message count and dates from the public profile;
 * `relationship` is the public text, then the private text as a second
 * paragraph; `interests` a union by topic (the private note wins); `details`
 * public then private (ids are irrelevant for rendering); `episodes` both,
 * sorted by date; `affinity` the `effectiveAffinity` view. Neither input is
 * mutated; a missing private profile returns the public one as is.
 * @param {object|null} publicProfile
 * @param {object|null|undefined} privateProfile
 * @returns {object|null}
 */
export function mergeProfiles(publicProfile, privateProfile) {
  if (!privateProfile || !publicProfile) return publicProfile;
  const relationship = [publicProfile.relationship, privateProfile.relationship]
    .filter((text) => typeof text === 'string' && text.trim())
    .join('\n\n');
  return {
    ...publicProfile,
    relationship,
    interests: mergeInterests(publicProfile.interests, privateProfile.interests),
    details: [...listOf(publicProfile.details), ...listOf(privateProfile.details)],
    episodes: mergeEpisodes(publicProfile.episodes, privateProfile.episodes),
    affinity: effectiveAffinity(publicProfile.affinity, privateProfile.affinity),
  };
}
