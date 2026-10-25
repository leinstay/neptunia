// The memory limits in one home: the fallbacks of the memory's limit settings and the fixed
// lengths of the texts the store writes, so one text is never cut at two limits. This module imports
// nothing, so every memory module can take its limits from here without an import cycle. The
// episode, attitude and teacher rules have their own homes: src/memory/episodes.js (EPISODE_CHARS,
// episodeDate, isSameEpisode), src/memory/affinity.js (REASON_CHARS, deltaCapOf)
// and src/memory/mentions.js (teacherToken).

/**
 * Fallbacks of the memory limits, equal to config.json's own values -- used only when a
 * deployment's config is missing the key. Most are `memory.<key>`; the others are
 * `relationships.maxDeltaPerUpdate`, `relationships.historySize`, `relationships.textChars`
 * (`relationshipChars`) and `lore.textChars` (`loreTextChars`). Frozen: a caller reads it, never
 * moves a fallback for everyone.
 */
export const MEMORY_LIMIT_DEFAULTS = Object.freeze({
  fieldChars: 1000,
  maxDetails: 15,
  maxSelfFacts: 20,
  maxEpisodes: 20,
  maxDeltaPerUpdate: 15,
  historySize: 10,
  maxInterests: 12,
  loreTextChars: 600,
  maxLearned: 20,
  maxLearnedStored: 60,
  learnedChars: 160,
  learnedHalfLifeDays: 720,
  relationshipChars: 800,
  clampTolerance: 1.25,
});

/** How long one self fact (the persona's own `self` list) may be, in characters, before
 * `memory.clampTolerance`. */
export const SELF_CHARS = 200;
