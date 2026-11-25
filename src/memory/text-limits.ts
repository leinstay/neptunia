// The memory limits in one home: the measures of what the store keeps and shows and the fixed lengths of the texts
// it writes, so one text is never cut at two limits. This module imports nothing, so every memory module can take its
// limits from here without an import cycle. The episode and teacher rules have their own homes:
// src/memory/episodes.ts (episodeDate) and src/memory/mentions.ts (TEACHER_TOKEN_RE).

/**
 * The measures of the member memory, by the names the store and the request builders read. Production values,
 * config cut of 2026-10-31 (they were `memory.<name>`). Frozen: a caller reads it, never moves a limit for everyone.
 */
export const MEMORY_LIMITS = Object.freeze({
  fieldChars: 1000,
  maxDetails: 15,
  recentHours: 72,
  channelWritersStored: 20,
  channelWritersHalfLifeDays: 30,
  maxInterests: 12,
  interestHalfLifeDays: 180,
  detailHalfLifeDays: 720,
  learnedHalfLifeDays: 720,
  maxAliases: 5,
  aliasHalfLifeDays: 365,
  addressHalfLifeDays: 30,
  supersededShownDays: 7,
  confirmAfter: 2,
  interestStaleDays: 90,
});

/** The attitude's measures (they were `relationships.<name>`). Production values, config cut of 2026-10-31. */
export const RELATIONSHIP_LIMITS = Object.freeze({
  maxDeltaPerUpdate: 15,
  decayPerDay: 0.04,
  decayPower: 1,
  textChars: 800,
});

/** The server lore's measures (they were `lore.<name>`). Production values, config cut of 2026-10-31. */
export const LORE_LIMITS = Object.freeze({
  maxEntries: 500,
});
