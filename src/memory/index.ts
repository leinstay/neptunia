// The memory's public API: the one module the rest of the engine imports the memory through
// (src/index.js, src/behavior/, src/tools/impl/, src/errands/), so that the memory can
// replace an implementation behind it without touching a caller. It re-exports and defines
// nothing; nothing in src/memory/ imports it. The pure functions that are not memory (clamp.ts,
// mentions.ts, ranking.ts, recent.ts, text-limits.ts, prose.ts) stay direct imports.
// The paths under data/ are src/memory/root.ts; the layout is the header comment of store.ts.

// The stores and the schedulers src/index.js constructs.
export { createAppendStore } from './append-store.ts';
export { createStore } from './store.ts';
export { createRecord } from './record.ts';
export { createJournal } from './journal.ts';
export { createArchive } from './archive.ts';
export { createVectors } from './vectors.ts';
export { createEmbedder } from './embedder.ts';
export { createMemoryUpdater } from './update.ts';
export { createEmojiBackfill } from './emoji-backfill.ts';
export { createGifBackfill } from './gif-backfill.ts';
export { createGifRecache } from './gif-recache.ts';
export { createDescriber } from './describe.ts';
export { createAvatarQueue } from './avatar-queue.ts';
export { startYoutubeCheck } from './youtube-check.ts';

// Reads: profiles, the private layer, channels, lore, episodes, media and the journal's views.
export { affinityBand, clampScore, emptyAffinity, roundScore, strongestMoves } from './affinity.ts';
export { isConfirmed, isOpen, isStale, normalizeTopic } from './interests.ts';
export { rankAddressed } from './addressed.ts';
export { episodeDate, sortEpisodesForDisplay, topEpisodes } from './episodes.ts';
export { matchLore } from './lore.ts';
export { channelActivity, renderChannel } from './channels.ts';
export { mainChannelSet } from './update.ts';
export {
  PARTICIPATION_DEFAULTS,
  cutEpisode,
  earlierEpisodes,
  episodeHeadlines,
  participationSettings,
  selectEpisodes,
} from './participation.ts';
export { normalizeAvatar } from './avatars.ts';
export { rankEmojiUsage } from './emoji-usage.ts';
export { findGif, gifHandleMap, gifHandleOf, gifOpts, normalizeGifs, rankGifs } from './gifs.ts';
export { gifWatchBlocker } from './gif-watch.ts';
export { RECACHE_DAYS, gifCaptionCounts, gifFormatCounts } from './gif-recache.ts';
export { createOffPeriodsReader, journalLine, turnView } from './journal.ts';
export { ARCHIVE_EVENTS, ARCHIVE_KINDS, archiveEntry } from './archive.ts';

// Writes: the record's lines, participation, aliases, atomic JSON files.
export { appendRevision, toRecordLine } from './record.ts';
export { slimMessage } from './update.ts';
export { recordFollowing, recordOwnLine } from './participation.ts';
export { applyAliasOps } from './aliases.ts';
export { writeJsonAtomic } from './store.ts';

// The snapshot of data/ and the vault left by the earlier forgets (data, never written).
export { DEFAULT_VAULT_DIR, SNAPSHOTS_DIR } from './store.ts';

// The root: every memory path under data/.
export { memoryRootOf } from './root.ts';
