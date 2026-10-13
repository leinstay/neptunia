// Pure logic for a member's remembered aliases -- stable nicknames people in
// chat actually call them (a shortened or translated name), NOT their
// Discord display names (src/memory/store.js keeps those separately as
// `names`, refreshed every time the member speaks). Ranked and confirmed
// exactly like interests (src/memory/interests.js#applyRankedOps): `{ name,
// weight, firstSeen, lastSeen }`, a sighting bumps weight on the same
// confirmGapHours rule, eviction keeps the top-ranked ones once over the
// storage cap. See docs/prompt-contract.md, "Aliases".

import { applyRankedOps, effectiveStorageCap, normalizeTopic } from './interests.js';

const MAX_ALIAS_CHARS = 40;

/**
 * Merge one analyzer batch's alias ops into a member's stored alias list.
 * `ops` is `{ add?: string[], remove?: string[] }` -- no `update`/`seen`:
 * aliases are plain strings, an `add` of an already-known one (identity is
 * case-insensitive, like an interest's topic) is itself the sighting. An
 * `add` equal, case-insensitively, to one of `displayNames` (the member's own
 * stored Discord names) is dropped before it ever reaches the ranked-item
 * merge -- an alias is what OTHER people call them, not their own name.
 * Every alias is clamped to 40 characters. Eviction keeps the top-ranked
 * items over `max(maxAliasesStored, maxAliases)`.
 *
 * @param {object[]|undefined} existing     Stored aliases.
 * @param {{ add?: unknown, remove?: unknown }} ops  Untrusted, model-extracted.
 * @param {string[]} displayNames           The member's own stored Discord display names.
 * @param {{ maxAliases?: number, maxAliasesStored?: number, confirmGapHours?: number,
 *   seenAt?: number, halfLifeDays?: number }} [opts]
 * @returns {object[]}  With the non-enumerable `dropped` of src/memory/interests.js#applyRankedOps:
 *   the stored aliases that left (removed or evicted), as stored.
 */
export function applyAliasOps(
  existing,
  ops,
  displayNames,
  { maxAliases, maxAliasesStored, confirmGapHours, seenAt = Date.now(), halfLifeDays } = {},
) {
  const ownNames = new Set((Array.isArray(displayNames) ? displayNames : []).map((name) => normalizeTopic(name)));
  const filtered = ops && typeof ops === 'object' && !Array.isArray(ops) ? { ...ops } : {};
  if (Array.isArray(filtered.add)) {
    filtered.add = filtered.add.filter((raw) => typeof raw === 'string' && !ownNames.has(normalizeTopic(raw)));
  }

  return applyRankedOps(existing, filtered, {
    identityField: 'name',
    identityChars: MAX_ALIAS_CHARS,
    confirmGapHours,
    seenAt,
    halfLifeDays,
    cap: effectiveStorageCap(maxAliasesStored, maxAliases),
  });
}
