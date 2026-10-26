// The memory's public API: the one module the rest of the engine imports the memory through
// (src/index.js, src/behavior/, src/ops/, src/errands/), so that the memory can
// replace an implementation behind it without touching a caller. It re-exports and defines
// nothing; nothing in src/memory/ imports it. The pure helpers that are not memory (clamp.js,
// mentions.js, ranking.js, recent.js, text-limits.js, prose.js) stay direct imports.
// The paths under data/ are src/memory/root.js; the layout is the header comment of store.js.

// The stores and the schedulers src/index.js constructs.
export { createAppendStore } from './append-store.js';
export { createStore } from './store.js';
export { createRecord } from './record.js';
export { createJournal } from './journal.js';
export { createArchive } from './archive.js';
export { createVectors } from './vectors.js';
export { createEmbedder } from './embedder.js';
export { createMemoryUpdater } from './update.js';
export { createEmojiBackfill } from './emoji-backfill.js';
export { createGifBackfill } from './gif-backfill.js';
export { createGifRecache } from './gif-recache.js';
export { createDescriber } from './describe.js';
export { createAvatarQueue } from './avatar-queue.js';
export { startYoutubeCheck } from './youtube-check.js';

// Reads: profiles, the private layer, channels, lore, episodes, media and the journal's views.
export { affinityBand, clampScore, emptyAffinity, ignoreAdjustment, roundScore, strongestMoves } from './affinity.js';
export { isConfirmed, isOpen, isStale, normalizeTopic } from './interests.js';
export { rankAddressed } from './addressed.js';
export { episodeDate, sortEpisodesForDisplay, topEpisodes } from './episodes.js';
export { matchLore } from './lore.js';
export { channelActivity, renderChannel } from './channels.js';
export { mainChannelSet } from './update.js';
export {
  PARTICIPATION_DEFAULTS,
  cutEpisode,
  earlierEpisodes,
  episodeHeadlines,
  participationSettings,
  selectEpisodes,
} from './participation.js';
export { memberView, normalizeAvatar } from './avatars.js';
export { rankEmojiUsage } from './emoji-usage.js';
export { findGif, gifHandleMap, gifHandleOf, gifOpts, normalizeGifs, rankGifs } from './gifs.js';
export { gifPostsToday, gifWatchBlocker, gifWatchesToday } from './gif-watch.js';
export { RECACHE_DAYS, gifCaptionCounts, gifFormatCounts } from './gif-recache.js';
export { VIDEO_DAILY } from './describe.js';
export { isVideoVisionOn } from './youtube-check.js';
export { createOffPeriodsReader, journalLine, turnView } from './journal.js';
export { ARCHIVE_EVENTS, ARCHIVE_KINDS, archiveEntry } from './archive.js';

// Writes: the record's lines, participation, aliases, atomic JSON files.
export { appendRevision, toRecordLine } from './record.js';
export { slimMessage } from './update.js';
export { recordFollowing, recordOwnLine } from './participation.js';
export { applyAliasOps } from './aliases.js';
export { writeJsonAtomic } from './store.js';

// The snapshot of data/ and the vault left by the earlier forgets (data, never written).
export { DEFAULT_VAULT_DIR, SNAPSHOTS_DIR } from './store.js';

// The root: every memory path under data/.
export { memoryRootOf } from './root.js';
