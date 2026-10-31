// The memory limits in one home: the measures of what the store keeps and shows and the fixed lengths of the texts
// it writes, so one text is never cut at two limits. This module imports nothing, so every memory module can take its
// limits from here without an import cycle. The episode, attitude and teacher rules have their own homes:
// src/memory/episodes.js (EPISODE_CHARS, episodeDate, isSameEpisode), src/memory/affinity.js (REASON_CHARS,
// deltaCapOf) and src/memory/mentions.ts (teacherToken).

/**
 * The measures of the member memory, by the names the store and the request builders read. Production values,
 * config cut of 2026-10-31 (they were `memory.<name>`). Frozen: a caller reads it, never moves a limit for everyone.
 */
export const MEMORY_LIMITS = Object.freeze({
  fieldChars: 1000,
  maxDetails: 15,
  maxSelfFacts: 20,
  maxEpisodes: 20,
  keepNewestEpisodes: 5,
  recentHours: 72,
  maxRecentStored: 150,
  maxNewRecent: 3,
  recentChars: 160,
  recentShown: 12,
  channelWritersStored: 20,
  channelWritersHalfLifeDays: 30,
  maxInterests: 12,
  maxInterestsStored: 40,
  interestHalfLifeDays: 180,
  maxDetailsStored: 40,
  detailHalfLifeDays: 720,
  maxLearned: 20,
  maxLearnedStored: 60,
  learnedChars: 160,
  learnedHalfLifeDays: 720,
  maxAliases: 5,
  maxAliasesStored: 15,
  aliasHalfLifeDays: 365,
  addressHalfLifeDays: 30,
  maxClosedStored: 40,
  supersededShownDays: 7,
  confirmAfter: 2,
  confirmGapHours: 12,
  interestStaleDays: 90,
  clampTolerance: 1.25,
});

/** The attitude's measures (they were `relationships.<name>`). Production values, config cut of 2026-10-31. */
export const RELATIONSHIP_LIMITS = Object.freeze({
  maxDeltaPerUpdate: 15,
  historySize: 10,
  shownMoves: 4,
  damping: true,
  dampingPower: 1,
  decayPerDay: 0.04,
  decayPower: 1,
  rewriteOnBandChange: true,
  rewriteOnDrift: 8,
  rewriteAfterMoves: 6,
  bandHysteresis: 2,
  textChars: 800,
});

/** The server lore's measures (they were `lore.<name>`). Production values, config cut of 2026-10-31. */
export const LORE_LIMITS = Object.freeze({
  maxEntries: 500,
  scanMessages: 30,
  maxMatches: 8,
  textChars: 600,
});

/** How long one self fact (the persona's own `self` list) may be, in characters, before the clamp tolerance. */
export const SELF_CHARS = 200;
